import {greetingConfigSchema,defaultGreeting,type GreetingRecord} from '../../contracts/src/greeting.js';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Repository } from '../../persistence/src/repository.js';
import { AdapterRegistry } from '../../adapters/core/src/registry.js';
import { validateStation } from '../../adapters/core/src/index.js';
import { accountInput, batchInput, batchPreviewInput, jobInput, planInput, profileInput, resumeInput, ruleInput, settingsInput, USER_ID,
  type Account, type Action, type Batch, type BatchInput, type Job, type JobInput, type MatchResult, type Message, type Profile, type Resume, type Rule, type SearchPlan, type Settings, type Task } from '../../contracts/src/index.js';
import { requireCondition, AppError } from '../../domain/src/errors.js';
import { matchJob, qualificationIssues, deadlinePassed } from '../../domain/src/matching.js';
import { csvCell, stableHash } from '../../adapters/import/src/index.js';
import { Notifications, type DesktopChannel } from '../../notifications/src/index.js';
import { audit } from '../../diagnostics/src/index.js';
import { SourceRegistry } from '../../source-registry/src/index.js';
import { PublicWllmReader, type PublicNotice } from '../../adapters/wllm91/src/public-reader.js';
import { jobMarkSchema, jobNoteSchema, savedJobQuerySchema, browserFilterSchema, emptyBrowserFilter, type JobMark, type SavedJobQuery, type SavedRefreshRecord, type ManagedJob } from '../../contracts/src/job-management.js';
import { matchingPreferencesSchema, emptyMatchingPreferences } from '../../contracts/src/boss-matching.js';
import { browserJobSchema, canonicalBossJob } from '../../contracts/src/boss-browser.js';
import { searchConfigSchema, searchRunSchema, defaultSearchConfig, searchPresetSchema, searchPresetInput, searchCriteriaKey, evaluateSearchJob, needsSearchVerification, type BossSearchConfig, type BossSearchRun, type SearchPreset } from '../../contracts/src/boss-search.js';

const now = () => new Date().toISOString();
const base = () => ({id: randomUUID(), user_id: USER_ID});
export class RecruitmentService {
  readonly adapters: AdapterRegistry;
  readonly notifications: Notifications;
  readonly sources: SourceRegistry;
  readonly publicReader = new PublicWllmReader();
  constructor(readonly store: Repository, readonly directory: string, desktop?: DesktopChannel) {
    this.adapters = new AdapterRegistry(directory);
    this.notifications = new Notifications(store, () => this.getSettings(), desktop);
    this.sources = new SourceRegistry(store);
  }
  get<T>(table: Parameters<Repository['get']>[0], id: string): T {
    const entity = this.store.get<T>(table, id);
    requireCondition(entity, 'NOT_FOUND', '记录不存在', 404); return entity;
  }
  getGreetingConfig(){return greetingConfigSchema.strip().parse(this.store.get('settings','greeting-config')??defaultGreeting);}
  saveGreetingConfig(raw:unknown){const config=greetingConfigSchema.parse(raw);this.store.put('settings',{id:'greeting-config',...config});return config;}
  greetingRecord(id:string){return this.store.get<GreetingRecord>('settings',`job-greeting:${id}`);}
  recordGreeting(id:string,record:GreetingRecord){this.savedBrowserJob(id);this.store.put('settings',{id:`job-greeting:${id}`,...record});}
  getProfile(): Profile { return profileInput.strip().parse(this.store.get('profiles', USER_ID) ?? {}); }
  saveProfile(raw: unknown) { const input = profileInput.parse(raw); return this.store.put('profiles', {id: USER_ID, ...input}); }
  getSettings(): Settings { return settingsInput.strip().parse(this.store.get('settings', 'preferences') ?? {}); }
  saveSettings(raw: unknown) { return this.store.put('settings', {id: 'preferences', ...settingsInput.parse(raw)}); }
  getBrowserFilter() { return browserFilterSchema.strip().parse(this.store.get('settings', 'boss-browser-filter') ?? emptyBrowserFilter); }
  getMatchingPreferences() { return matchingPreferencesSchema.strip().parse(this.store.get('settings','boss-matching') ?? emptyMatchingPreferences); }
  savedBossUrls(){return [...new Set(this.store.savedBossUrls().flatMap(url=>{const canonical=canonicalBossJob(url);return canonical?[canonical]:[];}))];}
  getBossSearchConfig(){const stored=this.store.get<Record<string,unknown>>('settings','boss-search-config');return searchConfigSchema.parse(stored?{keywords:stored.keywords,cities:stored.cities,education:stored.education,experience:stored.experience,exclude:stored.exclude,salary_min:stored.salary_min,salary_max:stored.salary_max,rounds:stored.rounds,salary_enrichment:stored.salary_enrichment,salary_period:stored.salary_period,skip_saved:stored.skip_saved,skip_processed:stored.skip_processed}:defaultSearchConfig);}
  saveBossSearchConfig(raw:unknown){const config=searchConfigSchema.parse(raw);this.store.put('settings',{id:'boss-search-config',...config});return config;}
  saveBossSearchRun(raw:BossSearchRun){const run=searchRunSchema.parse(raw);const previous=this.store.get<{run:BossSearchRun}>('settings','boss-search-run')?.run;this.store.transaction(()=>{this.recordSearchHistory(run,previous);this.store.put('settings',{id:'boss-search-run',run});});}
  private searchScope(config:BossSearchConfig){return createHash('sha256').update(searchCriteriaKey(config)).digest('hex');}
  private recordSearchHistory(run:BossSearchRun,previous?:BossSearchRun){
    const scope=this.searchScope(run.config),old=new Map(previous?.id===run.id?previous.results.map(item=>[item.job.url,JSON.stringify(item)]):[]);
    for(const item of run.results){
      if(old.get(item.job.url)===JSON.stringify(item))continue;
      const url=canonicalBossJob(item.job.url);if(!url)continue;
      const key=createHash('sha256').update(url).digest('hex'),id=`boss-seen:${key}`;
      const seen=this.store.get<{first_read_at:string;last_read_at:string}>('settings',id);
      this.store.put('settings',{id,url,first_read_at:seen && seen.first_read_at<item.observed_at?seen.first_read_at:item.observed_at,last_read_at:seen && seen.last_read_at>item.observed_at?seen.last_read_at:item.observed_at});
      const status=evaluateSearchJob(item.job,run.config).status;
      const processed=`boss-processed:${scope}:${key}`;
      const prior=this.store.get<{observed_at:string}>('settings',processed);
      const at=item.verification?.observed_at ?? item.job.salary_detail?.observed_at ?? item.observed_at;
      if(prior && prior.observed_at>at)continue;
      if(status!=='UNKNOWN' && !needsSearchVerification(item.job,run.config) && item.verification?.status!=='FAILED' && item.verification?.status!=='BLOCKED')this.store.put('settings',{id:processed,url,status,observed_at:at});
      else this.store.remove('settings',processed);
    }
  }
  prepareSearchHistory(){const old=this.getBossSearchRun();this.store.transaction(()=>{
    if(old)this.recordSearchHistory(old);
    for(let offset=0;;offset+=200){
      const page=this.store.queryJobs({platform:'boss',mode:'IMPORT',offset,limit:200});
      for(const job of page.items){const url=canonicalBossJob(job.source_url);if(!url)continue;const id=`boss-seen:${createHash('sha256').update(url).digest('hex')}`;if(this.store.get('settings',id))continue;const time=z.iso.datetime({offset:true}).safeParse(job.extra.observed_at);const at=time.success?time.data:job.first_seen_at;this.store.put('settings',{id,url,first_read_at:at,last_read_at:at});}
      if(offset+page.items.length>=page.total)break;
    }
  });}
  seenBossJobs(){return this.store.settingsByPrefix<{url:string;first_read_at:string}>('boss-seen:').filter(item=>canonicalBossJob(item.url));}
  processedBossUrls(config:BossSearchConfig){return this.store.settingsByPrefix<{url:string}>(`boss-processed:${this.searchScope(config)}:`).map(item=>item.url).filter(url=>!!canonicalBossJob(url));}
  listSearchPresets(){return this.store.settingsByPrefix<SearchPreset>('boss-preset:').map(value=>searchPresetSchema.parse({id:value.id.slice('boss-preset:'.length),name:value.name,config:value.config,updated_at:value.updated_at})).sort((a,b)=>b.updated_at.localeCompare(a.updated_at));}
  saveSearchPreset(raw:unknown){const input=searchPresetInput.parse(raw),list=this.listSearchPresets();if(input.id)requireCondition(list.some(item=>item.id===input.id),'NOT_FOUND','常用条件不存在');else requireCondition(list.length<20,'PRESET_LIMIT','最多保存 20 组常用条件');const preset=searchPresetSchema.parse({...input,id:input.id??randomUUID(),updated_at:now()});this.store.put('settings',{...preset,id:`boss-preset:${preset.id}`});return preset;}
  deleteSearchPreset(id:string){requireCondition(this.listSearchPresets().some(item=>item.id===id),'NOT_FOUND','常用条件不存在');this.store.remove('settings',`boss-preset:${id}`);return {deleted:true};}
  getBossSearchRun(){const stored=this.store.get<{run:unknown}>('settings','boss-search-run');if(!stored)return null;const run=searchRunSchema.parse(stored.run);return run.status==='RUNNING'?{...run,status:'INTERRUPTED' as const,reason:'上次任务中断，显示历史读取结果；可手动继续获取，或重新获取开始新一轮'}:run;}
  saveMatchingPreferences(raw:unknown) {const input=matchingPreferencesSchema.parse(raw);this.store.put('settings',{id:'boss-matching',...input});return input;}
  saveBrowserFilter(raw: unknown) {
    const filter = browserFilterSchema.parse(raw);
    this.store.put('settings', { id: 'boss-browser-filter', ...filter });
    return filter;
  }
  jobMark(id: string): JobMark {
    const value = this.store.get<{ mark: unknown }>('settings', `job-mark:${id}`);
    return jobMarkSchema.parse(value?.mark ?? 'CONSIDERING');
  }
  markJob(id: string, raw: unknown) {
    const mark = jobMarkSchema.parse(raw);
    const job = this.get<Job>('jobs', id);
    requireCondition(job.platform === 'boss' && job.mode === 'IMPORT', 'INVALID_MODE', '个人标记仅用于本地 BOSS 岗位');
    this.store.put('settings', { id: `job-mark:${id}`, mark, marked_at: now() });
    return { ...job, personal_mark: mark };
  }
  managedJob(job:Job):ManagedJob {const changes=this.store.get<{latest:NonNullable<ManagedJob['change_check']>;history:NonNullable<ManagedJob['change_history']>}>('settings',`job-changes:${job.id}`);return {...job,greeting:this.greetingRecord(job.id),personal_mark:this.jobMark(job.id),personal_note:this.store.get<{note:string}>('settings',`job-note:${job.id}`)?.note??'',refresh:this.store.get<SavedRefreshRecord>('settings',`job-refresh:${job.id}`),change_check:changes?.latest,change_history:changes?.history??[]};}
  noteJob(id:string,raw:unknown){const note=jobNoteSchema.parse(raw),job=this.get<Job>('jobs',id);requireCondition(job.platform==='boss'&&job.mode==='IMPORT','INVALID_MODE','备注仅用于本地 BOSS 岗位');this.store.put('settings',{id:`job-note:${id}`,note});return this.managedJob(job);}
  listSavedJobs(raw:SavedJobQuery){const q=savedJobQuerySchema.parse(raw);const page=this.store.queryJobs({...q,platform:'boss',mode:'IMPORT',saved_management:true});return {...page,items:page.items.map(job=>this.managedJob(job))};}
  savedBrowserJob(id:string){const job=this.get<Job>('jobs',id);requireCondition(job.platform==='boss'&&job.mode==='IMPORT'&&canonicalBossJob(job.source_url),'INVALID_MODE','仅支持本地保存的官方 BOSS 岗位');return browserJobSchema.parse({url:canonicalBossJob(job.source_url),title:job.title,company:job.company_name,salary:job.salary_raw??'',location:job.locations?.[0]??'',education:job.education??'',experience:job.experience_raw??'',tags:job.tags??[]});}
  recordSavedRefresh(id:string,status:SavedRefreshRecord['status'],reason:string,at:string){const job=this.get<Job>('jobs',id);requireCondition(job.platform==='boss'&&job.mode==='IMPORT','INVALID_MODE','仅支持本地 BOSS 岗位');const previous=this.store.get<SavedRefreshRecord>('settings',`job-refresh:${id}`);this.store.put('settings',{id:`job-refresh:${id}`,status,reason:reason.slice(0,300),last_attempt_at:at,...(status==='DONE'?{last_success_at:at}:previous?.last_success_at?{last_success_at:previous.last_success_at}:{})});}
  refreshSavedJob(id:string,raw:unknown,at:string){
    const next=browserJobSchema.parse(raw),old=this.get<Job>('jobs',id),seed=this.savedBrowserJob(id);
    const normalized=(s:string)=>s.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
    requireCondition(seed.url===next.url&&normalized(seed.title)===normalized(next.title)&&normalized(seed.company)===normalized(next.company),'IDENTITY_MISMATCH','原帖岗位或企业变化，保留旧记录，请手动核对');
    requireCondition(next.salary.trim()&&!/[\uE000-\uF8FF]/.test(next.salary)&&next.location.trim(),'INCOMPLETE_DETAIL','详情薪资或地点未读出，保留旧记录');
    const date=z.iso.datetime({offset:true}).parse(at),last=this.store.get<SavedRefreshRecord>('settings',`job-refresh:${id}`)?.last_success_at;
    requireCondition(!last || Date.parse(date)>=Date.parse(last),'STALE_RESULT','迟到的详情结果未保存');
    return this.store.transaction(()=>{
      const oldDetail=browserJobSchema.shape.detail.safeParse(old.extra.boss_detail).data;
      const detail=next.detail && (next.detail.description || next.detail.address)?{...next.detail,description:next.detail.description||oldDetail?.description||'',address:next.detail.address||oldDetail?.address||''}:oldDetail;
      const changes:NonNullable<ManagedJob['change_check']>['changes']=[];
      const compare=(field:NonNullable<ManagedJob['change_check']>['changes'][number]['field'],before:string,after:string)=>{if(before.normalize('NFKC').replace(/\s+/g,' ').trim()!==after.normalize('NFKC').replace(/\s+/g,' ').trim())changes.push({field,before:before.slice(0,2000),after:after.slice(0,2000)});};
      compare('薪资',old.salary_raw??'',next.salary);compare('地点',(old.locations??[]).join(' / '),next.location);
      if(next.education)compare('学历',old.education??'',next.education);
      if(next.experience)compare('经验',old.experience_raw??'',next.experience);
      if(next.tags.length)compare('标签',[...(old.tags??[])].sort().join('、'),[...next.tags].sort().join('、'));
      if(next.detail?.description)compare('职位描述',oldDetail?.description??'',next.detail.description);
      if(next.detail?.address)compare('工作地址',oldDetail?.address??'',next.detail.address);
      const check:NonNullable<ManagedJob['change_check']>={checked_at:date,status:changes.length?'CHANGED':'UNCHANGED',changes};
      const history=this.managedJob(old).change_history??[];
      this.store.put('settings',{id:`job-changes:${id}`,latest:check,history:changes.length?[check,...history].slice(0,20):history});
      const {boss_detail_response:_response,boss_salary_detail:_salary,salary_source:_source,salary_original:_original,...extra}=old.extra;
      const input=jobInput.strip().parse({...old,salary_raw:next.salary,locations:[next.location],education:next.education||old.education,experience_raw:next.experience||old.experience_raw,tags:next.tags.length?next.tags:old.tags,description:next.detail?.description||old.description,salary_min:null,salary_max:null,salary_period:null,currency:null,extra:{...extra,observed_at:date,...(detail?{boss_detail:detail}:{}),...(next.salary_detail?{boss_salary_detail:next.salary_detail,salary_source:next.salary_detail.source==='DETAIL_DOM'?'BROWSER_DETAIL_DOM':'BROWSER_DETAIL_RESPONSE'}:{})}});
      const updated=this.upsertJob(input);this.recordSavedRefresh(id,'DONE','已核对原帖薪资与地点；仍需自行确认招聘状态',date);return this.managedJob(updated);
    });
  }

  createAccount(raw: unknown) {
    const input = accountInput.parse(raw);
    try { validateStation(input.platform, input.station); } catch (e) { throw new AppError('INVALID_STATION', (e as Error).message); }
    const account: Account = {...base(), ...input, identity: null, generation: 1, status: 'DISCONNECTED', created_at: now(), last_sync_at: null};
    requireCondition(!this.store.find<Account>('accounts', a => a.platform === input.platform && a.mode === input.mode && a.station?.base_url === input.station?.base_url), 'ACCOUNT_EXISTS', '此平台、模式和分站已有账号', 409);
    this.store.put('accounts', account); audit(this.store, 'ACCOUNT_CREATED', account.id, {mode: account.mode}); return account;
  }
  async connectAccount(id: string) {
    const account = this.get<Account>('accounts', id);
    const result = await this.adapters.forAccount(account).connectAccount(account);
    // Identity changes invalidate every previously approved batch.
    const updated = {...account, status: result.status, identity: result.identity,
      generation: account.identity && account.identity !== result.identity ? account.generation + 1 : account.generation};
    this.store.put('accounts', updated); audit(this.store, 'ACCOUNT_CONNECTED', id, {status: result.status, mode: account.mode});
    return {...updated, instruction: result.instruction, capabilities: this.capabilities(id)};
  }
  async disconnectAccount(id: string) {
    const account = this.get<Account>('accounts', id);
    this.store.transaction(() => {
      this.store.put('accounts', {...account, status: 'DISCONNECTED', generation: account.generation + 1});
      for (const task of this.store.all<Task>('tasks').filter(t => t.account_id === id && ['QUEUED','PAUSED','BLOCKED'].includes(t.state))) this.store.put('tasks', {...task, state: 'BLOCKED', error: 'ACCOUNT_DISCONNECTED'});
      for (const action of this.store.all<Action>('actions').filter(a => a.account_id === id && ['QUEUED','READY','PRECHECKING','PAUSED'].includes(a.status))) this.store.put('actions', {...action, status: 'BLOCKED', reason: '账号已断开；需要重新创建身份已确认的批次', updated_at: now()});
      audit(this.store, 'ACCOUNT_DISCONNECTED', id);
    });
    await this.adapters.forAccount(account).disconnectAccount(account);
    // Current V0 has no real session files; future credential providers must delete their own secrets here.
    rmSync(join(this.directory, 'sessions', id), {recursive: true, force: true});
    return this.get<Account>('accounts', id);
  }
  capabilities(id: string) { return this.adapters.forAccount(this.get<Account>('accounts', id)).describeCapabilities(); }

  async readPublicPage(url:string) {
    const page=await this.publicReader.read(url);
    return this.store.transaction(()=>{
      // A listing omits publication dates; it must not erase a date obtained from the detail page.
      const inputs=page.jobs.map(input=>{
        const previous=this.store.findSourceJob(input.mode,`${input.source_instance_id}:${input.external_job_id}`);
        return page.kind==='COMPANY_JOBS'&&previous?{...input,published_date:previous.published_date??null,published_at:previous.published_at}:input;
      });
      const jobs=inputs.length?this.importJobs(inputs,true):[];
      let notice:unknown=null;
      if(page.notice) {
        const old=this.store.find<PublicNotice & {id:string}>('notices',n=>n.source_url===page.source_url);
        notice=this.store.put('notices',{...(old?{id:old.id}:base()),...page.notice,mode:'REAL',observed_at:page.observed_at,capability:page.capability});
      }
      audit(this.store,'PUBLIC_PAGE_READ','hbeu',{count:jobs.length});
      return {...page,jobs,notice};
    });
  }

  importJobs(raw: unknown, internal = false) {
    const jobs = z.array(jobInput).min(1).max(500).parse(raw);
    if (!internal) requireCondition(jobs.every(j => j.mode === 'IMPORT'), 'INVALID_MODE', '手动导入必须标记 IMPORT，不能伪装为平台已核实数据');
    return this.store.transaction(() => jobs.map(input => this.upsertJob(input)));
  }
  private upsertJob(input: JobInput): Job {
    const previous = this.store.findSourceJob(input.mode,`${input.source_instance_id}:${input.external_job_id}`);
    const sameBrowserJob=input.extra.capture_method==='LOCAL_BROWSER_DOM' && input.source_instance_id==='desktop-browser:boss' && previous?.title===input.title && previous.company_name===input.company_name;
    if(sameBrowserJob && previous?.extra.boss_detail) {
      const detail=browserJobSchema.shape.detail.safeParse(previous.extra.boss_detail),incoming=browserJobSchema.shape.detail.safeParse(input.extra.boss_detail);
      if(detail.success && detail.data && (!incoming.success || !incoming.data || Date.parse(incoming.data.observed_at)<Date.parse(detail.data.observed_at)))input={...input,description:detail.data.description || null,extra:{...input.extra,boss_detail:detail.data}};
    }
    if(sameBrowserJob && previous?.extra.boss_detail_response){
      const old=browserJobSchema.shape.detail_response.safeParse(previous.extra.boss_detail_response),incoming=browserJobSchema.shape.detail_response.safeParse(input.extra.boss_detail_response);
      if(old.success && old.data && incoming.success && incoming.data && Date.parse(incoming.data.observed_at)<Date.parse(old.data.observed_at)){
        input={...input,salary_raw:old.data.salary || previous.salary_raw,locations:old.data.location?[old.data.location]:previous.locations,education:old.data.education || previous.education,experience_raw:old.data.experience || previous.experience_raw,extra:{...input.extra,boss_detail_response:old.data,...(old.data.salary?{salary_source:'BROWSER_DETAIL_RESPONSE'}:{})}};
      }
    }
    const time = now();
    const fingerprint = (job: JobInput) => {
      if (job.extra.capture_method !== 'LOCAL_BROWSER_DOM') return stableHash(job);
      const { observed_at: _observedAt, ...extra } = job.extra;
      const salaryDetail=browserJobSchema.shape.salary_detail.safeParse(extra.boss_salary_detail);
      if(salaryDetail.success && salaryDetail.data){const {observed_at:_salaryTime,original:_original,...content}=salaryDetail.data;extra.boss_salary_detail=content;}
      const detail=browserJobSchema.shape.detail.safeParse(extra.boss_detail);
      if(detail.success && detail.data) {const {observed_at:_detailTime,...content}=detail.data;extra.boss_detail=content;}
      const response=browserJobSchema.shape.detail_response.safeParse(extra.boss_detail_response);
      if(response.success && response.data){const {observed_at:_responseTime,...content}=response.data;extra.boss_detail_response=content;}
      return stableHash({ ...job, extra });
    };
    const hash = fingerprint(input);
    const job: Job = { ...input, ...(previous ? {id: previous.id, user_id: previous.user_id} : base()), schema_version: 1,
      content_hash: hash, first_seen_at: previous?.first_seen_at ?? time, last_seen_at: time,
      last_verified_at: input.mode === 'IMPORT' || input.status==='UNVERIFIED' ? null : time };
    this.store.put('jobs', job);
    this.store.put('job_sources', {id: job.id, job_id: job.id, source_instance_id: input.source_instance_id, external_job_id: input.external_job_id, source_url: input.source_url, raw: input, fingerprint: hash, observed_at: time, reliability: 'SOURCE_ID'});
    const previousHash = previous?.extra.capture_method === 'LOCAL_BROWSER_DOM' ? fingerprint(jobInput.strip().parse(previous)) : previous?.content_hash;
    if (previous && previousHash !== hash) {
      this.store.put('job_revisions', {...base(), job_id: job.id, before: previous, after: job, observed_at: time});
      this.notifications.emit(`job-revision:${job.id}:${hash}`, 'JOB_CHANGED', '岗位信息发生变化', `${job.title}，请复核最新岗位要求`);
    }
    return job;
  }
  listJobs(options: {offset?: number; limit?: number; platform?: string; mode?: string; status?: string; search?: string; rule_id?: string; personal_mark?: JobMark} = {}) {
    const page=this.store.queryJobs(options);
    const rule = options.rule_id ? this.latestRule(options.rule_id) : null;
    return {...page,items:page.items.map(job=>({...job, personal_mark:this.jobMark(job.id),...(rule?{match:matchJob(job,rule)}:{})}))};
  }
  createRule(raw: unknown) { return this.store.put('rules', {...base(), ...ruleInput.parse(raw), version: 1, created_at: now()}); }
  latestRule(id: string): Rule { return this.get<Rule>('rules', id); }
  updateRule(id: string, raw: unknown) {
    const previous = this.latestRule(id); const input = ruleInput.parse(raw);
    return this.store.transaction(() => {
      this.store.put('rules', {...previous, id: `${id}@${previous.version}`, rule_id: id});
      return this.store.put('rules', {...previous, ...input, version: previous.version + 1, created_at: now()});
    });
  }
  match(jobId: string, ruleId: string): MatchResult { return matchJob(this.get<Job>('jobs', jobId), this.latestRule(ruleId)); }

  importResume(raw: unknown) {
    const input = resumeInput.parse(raw);
    requireCondition(/\.pdf$/i.test(input.filename), 'UNSUPPORTED_FORMAT', 'V0 仅接受 PDF 附件简历');
    requireCondition(/^[A-Za-z0-9+/]*={0,2}$/.test(input.content_base64) && input.content_base64.length % 4 === 0, 'INVALID_BASE64', '简历编码不合法');
    const bytes = Buffer.from(input.content_base64, 'base64');
    requireCondition(bytes.length >= 8 && bytes.length <= 10 * 1024 * 1024 && bytes.subarray(0, 5).toString() === '%PDF-', 'INVALID_PDF', '必须是 PDF 文件，最大 10 MB');
    const id = randomUUID(); const ref = `${id}.pdf`;
    mkdirSync(join(this.directory, 'resumes'), {recursive: true, mode: 0o700});
    writeFileSync(join(this.directory, 'resumes', ref), bytes, {mode: 0o600, flag: 'wx'});
    const resume: Resume = {id, user_id: USER_ID, name: input.name, version: this.store.all<Resume>('resumes').filter(r => r.name === input.name).length + 1,
      file_ref: ref, file_hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, format: 'PDF', note: input.note, created_at: now()};
    try { return this.store.put('resumes', resume); } catch (error) { rmSync(join(this.directory,'resumes',ref), {force: true}); throw error; }
  }
  validateResume(id: string, hash: string) {
    const resume = this.get<Resume>('resumes', id);
    let bytes: Buffer;
    try { bytes = readFileSync(join(this.directory,'resumes',resume.file_ref)); } catch { throw new AppError('RESUME_MISSING', '简历文件丢失', 409); }
    requireCondition(resume.file_hash === hash && createHash('sha256').update(bytes).digest('hex') === hash, 'RESUME_CHANGED', '批次简历内容发生变化，暂停提交', 409);
  }
  createPlan(raw: unknown) {
    const input = planInput.parse(raw); this.get<Account>('accounts', input.account_id);
    return this.store.put('search_plans', {...base(), ...input, enabled: true, cursor: null, last_sync_at: null, next_run_at: now()} satisfies SearchPlan);
  }
  setPlanEnabled(id: string, enabled: boolean) { const plan = this.get<SearchPlan>('search_plans', id); return this.store.put('search_plans', {...plan, enabled}); }
  enqueue(accountId: string, kind: Task['kind'], payload: Task['payload'], priority = 50): Task {
    const existing = this.store.find<Task>('tasks', t => t.account_id === accountId && t.kind === kind && stableHash(t.payload) === stableHash(payload) && ['QUEUED','RUNNING','PAUSED','BLOCKED'].includes(t.state));
    if (existing) return existing;
    return this.store.put('tasks', {...base(), account_id: accountId, kind, payload, contract_version: 1, state: 'QUEUED', priority, attempts: 0, max_attempts: 3,
      run_after: now(), lease_until: null, owner: null, error: null, created_at: now()});
  }
  enqueueSync(accountId: string, kind: 'SYNC_JOBS' | 'SYNC_MESSAGES', planId?: string) {
    const account = this.get<Account>('accounts', accountId);
    requireCondition(account.status === 'CONNECTED', 'ACCOUNT_NOT_CONNECTED', '请先连接账号', 409);
    const cap = this.capabilities(accountId).find(c => c.name === (kind === 'SYNC_JOBS' ? 'jobs' : 'messages'));
    requireCondition(cap?.enabled && cap.status === 'VERIFIED', 'CAPABILITY_UNVERIFIED', '读取能力尚未验证', 409);
    if (planId) requireCondition(this.get<SearchPlan>('search_plans', planId).account_id === accountId, 'PLAN_ACCOUNT_MISMATCH', '搜索计划不属于此账号');
    return this.enqueue(accountId, kind, planId ? {plan_id: planId} : {}, kind === 'SYNC_MESSAGES' ? 90 : 40);
  }
  async syncJobs(task: Task) {
    const account = this.get<Account>('accounts', task.account_id);
    const plan = task.payload.plan_id ? this.get<SearchPlan>('search_plans', String(task.payload.plan_id)) : null;
    if (plan && !plan.enabled) throw new AppError('PLAN_PAUSED', '搜索计划已暂停', 409);
    const cursorRecord = this.store.get<{cursor: string | null}>('sync_cursors', `jobs:${account.id}`);
    const query = plan ? {keywords: plan.keywords, cities: plan.cities, budget: plan.budget} : {keywords:'', cities:[], budget:20};
    const page = await this.adapters.forAccount(account).searchJobs(account, query, plan?.cursor ?? cursorRecord?.cursor ?? null);
    requireCondition(this.get<Account>('accounts',account.id).generation === account.generation && this.get<Account>('accounts',account.id).status === 'CONNECTED', 'ACCOUNT_CHANGED', '同步过程中账号已断开');
    this.store.transaction(() => {
      if (page.jobs.length) this.importJobs(page.jobs, true);
      if (plan) this.store.put('search_plans', {...plan, cursor: page.next_cursor, last_sync_at: now(), next_run_at: new Date(Date.now()+plan.interval_seconds*1000).toISOString()});
      else this.store.put('sync_cursors', {id: `jobs:${account.id}`, cursor: page.next_cursor, last_sync_at: now()});
      this.store.put('accounts', {...account, last_sync_at: now()});
      audit(this.store,'JOBS_SYNCED',task.id,{count:page.jobs.length});
    });
  }
  async syncMessages(task: Task) {
    const account = this.get<Account>('accounts', task.account_id);
    const cursorId = `messages:${account.id}`;
    const previous = this.store.get<{cursor: string | null}>('sync_cursors',cursorId);
    const page = await this.adapters.forAccount(account).syncMessages(account, previous?.cursor ?? null);
    requireCondition(this.get<Account>('accounts',account.id).generation === account.generation && this.get<Account>('accounts',account.id).status === 'CONNECTED', 'ACCOUNT_CHANGED', '消息同步时账号已变化');
    this.store.transaction(() => {
      for (const message of page.messages) {
        const key = message.source_message_id ?? stableHash({conversation:message.conversation_id,sender:message.sender,time:message.source_sent_at,body:message.body,unread_count:message.unread_count});
        if (this.store.find<Message>('messages', m => m.account_id === account.id && m.dedupe_key === key)) continue;
        const saved = this.store.put('messages', {...base(), ...message, dedupe_key:key, uncertain:message.source_message_id === null, observed_at:now(), local_read:false});
        if (previous) this.notifications.emit(`message:${saved.id}`, 'NEW_MESSAGE', `${account.mode === 'MOCK' ? '[模拟] ' : ''}新招聘消息`, message.body ?? `未读摘要：${message.unread_count ?? '未知'}，平台不支持全文`);
      }
      this.store.put('sync_cursors', {id: cursorId,cursor:page.next_cursor,last_sync_at:now(),next_run_at:new Date(Date.now()+120000).toISOString()});
    });
  }

  previewBatch(raw: unknown) {
    const input = batchPreviewInput.parse(raw);
    const account = this.get<Account>('accounts',input.account_id); const resume = input.resume_id ? this.get<Resume>('resumes',input.resume_id) : null; const rule = this.latestRule(input.rule_id);
    const profile = this.getProfile(); const capabilities = this.capabilities(account.id);
    const items = input.job_ids.map(id => {
      const job = this.get<Job>('jobs',id); const match = matchJob(job,rule);
      return {job_id:id,title:job.title,content_hash:job.content_hash,match,issues:[...qualificationIssues(job,profile),
        ...(job.mode !== account.mode || job.platform !== account.platform ? ['岗位与账号的平台/模式不一致'] : []),
        ...(job.mode === 'MOCK' && job.source_instance_id !== `mock:${account.id}` ? ['模拟岗位属于其他账号'] : []),
        ...(job.status !== 'ACTIVE' ? ['岗位已关闭、过期或未核实'] : []),
        ...(deadlinePassed(job) ? ['岗位申请截止日期已过'] : []),
        ...(job.apply_target.kind !== 'IN_PLATFORM' ? ['外链或未知入口需要人工处理'] : [])],
        action_issues:Object.fromEntries(input.actions.map(type=>[type,capabilities.some(c=>c.name===type&&c.status==='VERIFIED'&&c.enabled)?[]:[`${type} 能力不可自动执行`]]))};
    });
    const summary = {mode:account.mode,account_id:account.id,account_generation:account.generation,resume_id:resume?.id ?? null,resume_hash:resume?.file_hash ?? null,rule_id:rule.id,rule_version:rule.version,items,actions:input.actions,greeting:input.greeting,limits:this.getSettings()};
    return {...summary,preview_hash:stableHash(summary)};
  }
  createBatch(raw: unknown) {
    const input: BatchInput = batchInput.parse(raw); const hash = stableHash(input);
    return this.store.transaction(() => {
      const existing = this.store.find<Batch>('batches', b => b.idempotency_key === input.idempotency_key);
      if (existing) { requireCondition(existing.request_hash === hash,'IDEMPOTENCY_CONFLICT','此幂等键已用于不同批次',409); return this.batchDetail(existing.id); }
      requireCondition(new Set(input.job_ids).size === input.job_ids.length && new Set(input.actions).size === input.actions.length,'DUPLICATE_INPUT','批次内的岗位和动作不能重复');
      requireCondition(input.job_ids.length * input.actions.length <= this.getSettings().max_batch_size,'BATCH_TOO_LARGE','批次动作数超过配置上限');
      const summary = this.previewBatch(inputForPreview(input));
      requireCondition(input.preview_hash===summary.preview_hash,'PREVIEW_CHANGED','岗位、规则、简历、账号或额度已变化，请重新查看批次摘要再确认',409);
      const account = this.get<Account>('accounts',input.account_id);
      requireCondition(account.status === 'CONNECTED','ACCOUNT_NOT_CONNECTED','账号未连接',409);
      if (input.resume_id && summary.resume_hash) this.validateResume(input.resume_id,summary.resume_hash);
      const batch: Batch = {...base(),account_id:account.id,account_generation:account.generation,mode:account.mode,resume_id:input.resume_id,resume_hash:summary.resume_hash,
        rule_id:input.rule_id,rule_version:summary.rule_version,greeting:input.greeting,limits:summary.limits,state:'RUNNING',approved_at:now(),idempotency_key:input.idempotency_key,request_hash:hash};
      this.store.put('batches',batch);
      for (const item of summary.items) for (const type of input.actions) {
        const job = this.get<Job>('jobs',item.job_id);
        requireCondition(job.platform === account.platform && job.mode === account.mode && (job.mode !== 'MOCK' || job.source_instance_id === `mock:${account.id}`),'JOB_ACCOUNT_MISMATCH','岗位与账号的模式、平台或归属不一致',409);
        const sourceKey = `${job.source_instance_id}:${job.external_job_id}`;
        requireCondition(!this.store.find<Action>('actions', a => a.account_id === account.id && a.source_key === sourceKey && a.type === type),'DUPLICATE_ACTION','此账号的岗位动作已存在，修改简历不会允许重复投递',409);
        const issues=[...item.issues,...(item.action_issues[type]??[])];
        const action: Action = {...base(),batch_id:batch.id,account_id:account.id,job_id:job.id,source_key:sourceKey,type,
          status:item.match.status === 'EXCLUDED' ? 'SKIPPED' : item.match.status === 'PENDING' || issues.length ? 'BLOCKED' : 'QUEUED',
          reason:item.match.status === 'EXCLUDED' ? '不符合硬性规则' : item.match.status === 'PENDING' ? '规则包含待确认条件' : issues.join('；') || null,
          evidence:null,evidence_kind:null,execution_ref:null,updated_at:now()};
        this.store.put('actions',action);
        if (action.status === 'QUEUED' || action.status === 'BLOCKED') {
          const task=this.enqueue(account.id,'ACTION',{action_id:action.id},60);
          if(action.status==='BLOCKED') this.store.put('tasks',{...task,state:'BLOCKED',error:action.reason});
        }
      }
      audit(this.store,'BATCH_APPROVED',batch.id,{mode:batch.mode,rule_version:batch.rule_version,count:summary.items.length*input.actions.length});
      return this.batchDetail(batch.id);
    });
  }
  batchDetail(id: string) {
    const batch = this.get<Batch>('batches',id); const actions = this.store.all<Action>('actions').filter(a => a.batch_id === id);
    const counts = Object.fromEntries([...new Set(actions.map(a=>a.status))].map(s=>[s,actions.filter(a=>a.status===s).length]));
    return {...batch,actions,counts};
  }
  controlBatch(id: string, command: 'pause' | 'resume' | 'cancel') {
    const batch = this.get<Batch>('batches',id);
    requireCondition(batch.state !== 'CANCELLED','BATCH_CANCELLED','已取消的批次无法恢复',409);
    if (command === 'resume') { const account = this.get<Account>('accounts',batch.account_id); requireCondition(account.status === 'CONNECTED' && account.generation === batch.account_generation,'ACCOUNT_CHANGED','账号身份代次已变化，需要重新确认',409); }
    this.store.transaction(() => {
      this.store.put('batches',{...batch,state:command === 'pause' ? 'PAUSED' : command === 'cancel' ? 'CANCELLED' : 'RUNNING'});
      for (const action of this.batchDetail(id).actions) {
        if (!['QUEUED','PAUSED','READY','PRECHECKING'].includes(action.status)) continue;
        const status = command === 'pause' ? 'PAUSED' : command === 'cancel' ? 'CANCELLED' : 'QUEUED';
        this.store.put('actions',{...action,status,updated_at:now()});
        for (const task of this.store.all<Task>('tasks').filter(t=>t.payload.action_id===action.id && ['QUEUED','PAUSED'].includes(t.state))) this.store.put('tasks',{...task,state:status === 'QUEUED' ? 'QUEUED' : status === 'PAUSED' ? 'PAUSED' : 'CANCELLED'});
      }
    });
    return this.batchDetail(id);
  }
  reconcile(id: string) {
    const action = this.get<Action>('actions',id); requireCondition(action.status === 'UNKNOWN','NOT_UNKNOWN','仅未知结果支持重新核实',409);
    const account = this.get<Account>('accounts',action.account_id); const batch = this.get<Batch>('batches',action.batch_id);
    requireCondition(account.status === 'CONNECTED' && account.generation === batch.account_generation,'ACCOUNT_CHANGED','需保持原批准账号身份才能核实',409);
    return this.enqueue(action.account_id,'RECONCILE',{action_id:id},100);
  }
  reportAction(id: string, raw: unknown) {
    const input = z.object({status:z.enum(['SUCCEEDED','FAILED_CONFIRMED']),evidence:z.string().min(1).max(2000)}).strict().parse(raw);
    const action = this.get<Action>('actions',id); requireCondition(['UNKNOWN','BLOCKED'].includes(action.status),'INVALID_STATE','只允许对未知或待处理项目填人工结果',409);
    this.store.transaction(() => {
      this.store.put('actions',{...action,...input,evidence_kind:'USER_REPORTED',reason:'用户人工填写；未经平台核实',updated_at:now()});
      for(const task of this.store.all<Task>('tasks').filter(t=>t.payload.action_id===id&&['QUEUED','BLOCKED','PAUSED'].includes(t.state)))this.store.put('tasks',{...task,state:'DONE',error:null});
      audit(this.store,'USER_REPORTED',id,{status:input.status});
    });
    return this.get<Action>('actions',id);
  }
  ledgerCsv() {
    const header = ['action_id','batch_id','platform','mode','company','job','resume_id','action','status','evidence_kind','reason','updated_at'];
    const lines = this.store.all<Action>('actions').map(a => {const b=this.get<Batch>('batches',a.batch_id),j=this.get<Job>('jobs',a.job_id),acc=this.get<Account>('accounts',a.account_id);return [a.id,b.id,acc.platform,b.mode,j.company_name,j.title,b.resume_id,a.type,a.status,a.evidence_kind,a.reason,a.updated_at].map(csvCell).join(',');});
    return '\uFEFF'+[header.map(csvCell).join(','),...lines].join('\r\n');
  }
  overview() {
    const accounts = this.store.all<Account>('accounts').map(a=>({...a,capabilities:this.capabilities(a.id)}));
    const actions=this.store.all<Action>('actions');
    return {version:'0.2.0',scope:'BOSS 求职助手：岗位筛选与沟通流程；真实接入待验证',simulation_notice:'MOCK 仅供演示；BOSS 真实岗位读取、沟通、附件简历发送尚未接通',accounts,jobs:this.listJobs({limit:1}).total,
      actions:Object.fromEntries([...new Set(actions.map(a=>a.status))].map(s=>[s,actions.filter(a=>a.status===s).length])),messages:this.store.all<Message>('messages').length,
      queue_paused:this.store.get<{paused:boolean}>('settings','scheduler-control')?.paused ?? false};
  }
}
function inputForPreview(input: BatchInput) { const {approved:_approved,idempotency_key:_key,preview_hash:_hash,...preview}=input;return preview; }
