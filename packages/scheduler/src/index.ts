import { randomUUID } from 'node:crypto';
import type { Account, Action, Batch, Job, SearchPlan, Task } from '../../contracts/src/index.js';
import { USER_ID } from '../../contracts/src/index.js';
import type { RecruitmentService } from '../../application/src/service.js';
import type { ExecutionInput } from '../../adapters/core/src/index.js';
import { AppError, requireCondition } from '../../domain/src/errors.js';
import { matchJob, qualificationIssues, deadlinePassed } from '../../domain/src/matching.js';
import { audit } from '../../diagnostics/src/index.js';
import { inHours, shanghaiHour } from '../../notifications/src/index.js';

const now = () => new Date().toISOString();
const addMs = (ms: number) => new Date(Date.now()+ms).toISOString();
const dayInShanghai = (date: string) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date));
class Deferred extends Error { constructor(public delay = 60000, message = '等待运行时段或每日额度') {super(message);} }

export class Scheduler {
  readonly owner = randomUUID();
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private current?: Promise<void>;
  lastError: string | null = null;
  constructor(readonly service: RecruitmentService, private leaseMs = 30000) {}
  start() {
    this.stopped = false;
    this.timer = setInterval(() => {this.current = this.tick().catch(error => { this.lastError = error instanceof Error ? error.message : 'SCHEDULER_ERROR'; audit(this.service.store,'SCHEDULER_ERROR',this.owner,{code:'SCHEDULER_ERROR'}); });},1000);
  }
  async stop() { this.stopped=true; if (this.timer) clearInterval(this.timer); while (this.busy) await new Promise(resolve=>setTimeout(resolve,20)); }
  pause(paused: boolean) { return this.service.store.put('settings',{id:'scheduler-control',paused}); }

  recoverExpired() {
    const {store} = this.service;
    store.transaction(() => {
      const expired = store.all<Task>('tasks').filter(t=>t.state==='RUNNING' && (!t.lease_until || t.lease_until<=now()));
      for (const task of expired) {
        const action = task.payload.action_id ? store.get<Action>('actions',String(task.payload.action_id)) : undefined;
        if (action && ['EXECUTING','VERIFYING','UNKNOWN','RECONCILING'].includes(action.status)) {
          store.put('actions',{...action,status:'UNKNOWN',reason:'执行租约中断；必须先核实，禁止自动重投',updated_at:now()});
          store.put('tasks',{...task,state:'DONE',lease_until:null,owner:null,error:'INTERRUPTED_EXTERNAL_ACTION'});
          this.service.enqueue(task.account_id,'RECONCILE',{action_id:action.id},100);
        } else if (task.contract_version !== 1) store.put('tasks',{...task,state:'BLOCKED',owner:null,lease_until:null,error:'TASK_MIGRATION_REQUIRED'});
        else {
          if (action && ['PRECHECKING','READY'].includes(action.status)) store.put('actions',{...action,status:'QUEUED',updated_at:now()});
          store.put('tasks',{...task,state:'QUEUED',lease_until:null,owner:null,run_after:now(),error:'RECOVERED_BEFORE_SUBMIT'});
        }
      }
      store.expireAccountLocks(now());
    });
  }
  private planDueSyncs() {
    for (const plan of this.service.store.all<SearchPlan>('search_plans').filter(p=>p.enabled && p.next_run_at<=now())) {
      const account=this.service.store.get<Account>('accounts',plan.account_id);
      if (account?.status==='CONNECTED') this.service.enqueue(account.id,'SYNC_JOBS',{plan_id:plan.id},40);
    }
    for (const account of this.service.store.all<Account>('accounts').filter(a=>a.status==='CONNECTED')) {
      const cursor=this.service.store.get<{next_run_at:string}>('sync_cursors',`messages:${account.id}`);
      if ((!cursor || cursor.next_run_at<=now()) && this.service.capabilities(account.id).some(c=>c.name==='messages'&&c.enabled)) this.service.enqueue(account.id,'SYNC_MESSAGES',{},90);
    }
  }
  private claim(): Task | null {
    const {store}=this.service;
    return store.transaction(() => {
      const ready=store.readyTasks(now());
      for (const task of ready) {
        if (task.contract_version!==1) {store.put('tasks',{...task,state:'BLOCKED',error:'TASK_MIGRATION_REQUIRED'});continue;}
        const account=store.get<Account>('accounts',task.account_id);
        if (!account || account.status!=='CONNECTED') {store.put('tasks',{...task,state:'BLOCKED',error:'ACCOUNT_NOT_CONNECTED'});continue;}
        const lease=addMs(this.leaseMs);
        if (!store.acquireAccountLock(task.account_id,this.owner,lease,now())) continue;
        const running: Task={...task,state:'RUNNING',owner:this.owner,lease_until:lease,attempts:task.attempts+1};
        store.put('tasks',running); return running;
      }
      return null;
    });
  }
  async tick({schedule = true}: {schedule?: boolean} = {}) {
    if (this.busy || this.stopped) return;
    this.busy=true;
    try {
      this.recoverExpired();
      if (this.service.store.get<{paused:boolean}>('settings','scheduler-control')?.paused) { await this.service.notifications.flush(); return; }
      if (schedule) this.planDueSyncs();
      const task=this.claim();
      if (!task) {await this.service.notifications.flush();return;}
      const heartbeat=setInterval(()=>{
        const live=this.service.store.get<Task>('tasks',task.id);
        if (live?.owner===this.owner && live.state==='RUNNING') this.service.store.transaction(()=>{
          const lease=addMs(this.leaseMs);this.service.store.put('tasks',{...live,lease_until:lease});
          this.service.store.extendAccountLock(task.account_id,this.owner,lease);
        });
      },Math.max(100,Math.floor(this.leaseMs/3)));
      try {
        if (task.kind==='SYNC_JOBS') await this.service.syncJobs(task);
        else if (task.kind==='SYNC_MESSAGES') await this.service.syncMessages(task);
        else await this.runAction(task);
        const live=this.service.get<Task>('tasks',task.id);
        const action=task.payload.action_id?this.service.get<Action>('actions',String(task.payload.action_id)):null;
        const state=action?.status==='BLOCKED'?'BLOCKED':action?.status==='PAUSED'?'PAUSED':action?.status==='CANCELLED'?'CANCELLED':'DONE';
        this.service.store.put('tasks',{...live,state,lease_until:null,owner:null,error:action?.status==='BLOCKED'?action.reason:null});
      } catch (error) {
        const live=this.service.get<Task>('tasks',task.id);
        const code=error instanceof AppError ? error.code : error instanceof Error ? error.message : 'TASK_FAILED';
        if (error instanceof Deferred) this.service.store.put('tasks',{...live,state:'QUEUED',attempts:live.attempts-1,run_after:addMs(error.delay),lease_until:null,owner:null,error:code});
        else if (task.kind==='SYNC_JOBS'||task.kind==='SYNC_MESSAGES') {
          const blocked=error instanceof AppError && ['ACCOUNT_CHANGED','PLAN_PAUSED','CAPABILITY_UNVERIFIED','ACCOUNT_NOT_CONNECTED'].includes(error.code);
          this.service.store.put('tasks',{...live,state:blocked?'BLOCKED':live.attempts>=live.max_attempts?'FAILED':'QUEUED',run_after:addMs(2**live.attempts*1000),owner:null,lease_until:null,error:code});
          this.service.notifications.emit(`task-error:${task.id}`,'SYNC_ERROR','同步异常，保留原有数据',code);
        } else {
          const action=this.service.get<Action>('actions',String(task.payload.action_id));
          const unknown=['EXECUTING','VERIFYING','RECONCILING','UNKNOWN'].includes(action.status);
          this.service.store.transaction(()=>{
            this.updateAction(action,unknown?'UNKNOWN':'BLOCKED',unknown?'结果未核实，禁止自动重投':code);
            this.service.store.put('tasks',{...live,state:unknown?'DONE':'BLOCKED',lease_until:null,owner:null,error:code});
            if (unknown && task.kind==='ACTION') this.service.enqueue(task.account_id,'RECONCILE',{action_id:action.id},100);
          });
          this.service.notifications.emit(`action-error:${action.id}`,'ACTION_ERROR',unknown?'投递结果未知':'投递需要处理',code);
        }
      } finally {
        clearInterval(heartbeat);
        this.service.store.releaseAccountLock(task.account_id,this.owner);
      }
      await this.service.notifications.flush();
    } finally {this.busy=false;}
  }
  private updateAction(action: Action,status: Action['status'],reason: string|null = null,extra: Partial<Action>={}) {
    return this.service.store.put('actions',{...action,...extra,status,reason,updated_at:now()});
  }
  private assertIdentity(batch: Batch) {
    const account=this.service.get<Account>('accounts',batch.account_id);
    requireCondition(account.status==='CONNECTED'&&account.generation===batch.account_generation,'ACCOUNT_CHANGED','账号断开或身份代次发生变化',409);
    return account;
  }
  private async runAction(task: Task) {
    let action=this.service.get<Action>('actions',String(task.payload.action_id));
    const batch=this.service.get<Batch>('batches',action.batch_id);
    const account=this.assertIdentity(batch);
    const job=this.service.get<Job>('jobs',action.job_id);
    const adapter=this.service.adapters.forAccount(account);
    const input: ExecutionInput={action_id:action.id,account_id:account.id,type:action.type,job,resume_hash:batch.resume_hash,greeting:batch.greeting};
    if (task.kind==='RECONCILE') {
      if (action.status!=='UNKNOWN') return;
      action=this.updateAction(action,'RECONCILING');
      const result=await adapter.verifyAction(input);
      this.updateAction(action,result.status,result.reason,{evidence:result.evidence,evidence_kind:result.status==='SUCCEEDED'?(batch.mode==='MOCK'?'MOCK_VERIFIED':'PLATFORM_VERIFIED'):null});
      audit(this.service.store,'ACTION_RECONCILED',action.id,{status:result.status});return;
    }
    if (!['QUEUED','PAUSED'].includes(action.status)) return; // Re-delivery never re-executes submitted/unknown/terminal actions.
    if (batch.state!=='RUNNING') {this.updateAction(action,batch.state==='CANCELLED'?'CANCELLED':'PAUSED');return;}
    const control=this.service.store.get<{paused:boolean}>('settings','scheduler-control');
    if (control?.paused) throw new Deferred(1000,'队列已停止');
    const settings=this.service.getSettings();
    if (settings.run_hours && !inHours(shanghaiHour(new Date()),settings.run_hours)) throw new Deferred();
    if (batch.limits.run_hours && !inHours(shanghaiHour(new Date()),batch.limits.run_hours)) throw new Deferred();
    const today=dayInShanghai(now());
    const used=this.service.store.all<{account_id:string;created_at:string;submitted:boolean}>('attempts').filter(a=>a.account_id===account.id && a.submitted && dayInShanghai(a.created_at)===today).length;
    if (used>=Math.min(settings.daily_action_limit,batch.limits.daily_action_limit)) throw new Deferred(60000,'每日动作额度已用完');
    action=this.updateAction(action,'PRECHECKING');
    const session=await adapter.checkSession(account);
    if (session!=='CONNECTED') {
      this.service.store.put('accounts',{...account,status:session});
      this.service.notifications.emit(`session:${account.id}:${account.generation}`,'SESSION_EXPIRED','账号需要重新登录','对应账号任务已暂停');
      throw new AppError('SESSION_INVALID','登录失效或需要用户处理',409);
    }
    if (batch.resume_id && batch.resume_hash) this.service.validateResume(batch.resume_id,batch.resume_hash);
    else requireCondition(action.type === 'GREETING' && batch.resume_id === null && batch.resume_hash === null,'RESUME_REQUIRED','此动作需要完整的简历版本和校验值',409);
    const latest=this.service.latestRule(batch.rule_id);const match=matchJob(job,latest);
    if (job.status!=='ACTIVE'||deadlinePassed(job)||match.status==='EXCLUDED') {this.updateAction(action,'SKIPPED','岗位状态、截止日期或最新规则不允许投递');return;}
    if (match.status==='PENDING') {this.updateAction(action,'BLOCKED','最新规则仍有未知条件需要确认');return;}
    const issues=[...qualificationIssues(job,this.service.getProfile()),...await adapter.prepareApplication(account,job,action.type)];
    const capability=adapter.describeCapabilities().find(c=>c.name===action.type);
    if (!capability?.enabled || capability.status!=='VERIFIED') issues.push('此提交动作未验证或已禁用');
    if (issues.length) {this.updateAction(action,'BLOCKED',issues.join('；'));return;}
    action=this.updateAction(action,'READY');
    this.assertIdentity(batch);
    const liveBatch=this.service.get<Batch>('batches',batch.id);
    if (liveBatch.state!=='RUNNING'||this.service.store.get<{paused:boolean}>('settings','scheduler-control')?.paused) {this.updateAction(action,liveBatch.state==='CANCELLED'?'CANCELLED':'PAUSED');return;}
    const attempt={id:randomUUID(),user_id:USER_ID,attempt_id:randomUUID(),batch_id:batch.id,action_id:action.id,account_id:account.id,
      resume_version:batch.resume_id,resume_hash:batch.resume_hash,adapter_version:adapter.adapter_version,rule_version:batch.rule_version,prechecked_rule_version:latest.version,
      submitted:true,status:'EXECUTING',created_at:now(),completed_at:null as string|null,error:null as string|null};
    this.service.store.transaction(()=>{
      action=this.updateAction(action,'EXECUTING');this.service.store.put('attempts',attempt);
      audit(this.service.store,'ACTION_INTENT',action.id,{adapter_version:adapter.adapter_version,rule_version:latest.version});
    });
    try {
      const execution=await adapter.executeAction(input);
      action=this.updateAction(action,'VERIFYING',null,{execution_ref:execution.reference});
      this.assertIdentity(batch);
      const result=await adapter.verifyAction(input);
      this.service.store.transaction(()=>{
        this.updateAction(action,result.status,result.reason,{evidence:result.evidence,evidence_kind:result.status==='SUCCEEDED'?(batch.mode==='MOCK'?'MOCK_VERIFIED':'PLATFORM_VERIFIED'):null});
        this.service.store.put('attempts',{...attempt,status:result.status,completed_at:now()});
        this.service.notifications.emit(`action-result:${action.id}`,'ACTION_RESULT',`${batch.mode==='MOCK'?'[模拟] ':''}投递动作：${result.status}`,`${job.title} / ${action.type}`);
      });
    } catch (error) {
      this.service.store.put('attempts',{...attempt,status:'UNKNOWN',completed_at:now(),error:error instanceof AppError?error.code:'EXTERNAL_RESULT_UNKNOWN'});
      throw error;
    }
  }
  controlTask(id: string,command:'pause'|'resume'|'cancel') {
    const task=this.service.get<Task>('tasks',id);
    requireCondition(task.state!=='RUNNING','TASK_RUNNING','正在运行的任务通过队列/批次停止控制，不可撤回已发出的操作',409);
    requireCondition(!['DONE','CANCELLED'].includes(task.state),'TASK_TERMINAL','已完成或已取消任务不能重复执行',409);
    if (command==='resume') {
      const account=this.service.get<Account>('accounts',task.account_id);
      requireCondition(account.status==='CONNECTED','ACCOUNT_NOT_CONNECTED','账号需要连接',409);
      requireCondition(task.contract_version===1,'TASK_MIGRATION_REQUIRED','旧载荷需迁移',409);
      if (task.payload.action_id) {
        const action=this.service.get<Action>('actions',String(task.payload.action_id));const batch=this.service.get<Batch>('batches',action.batch_id);
        this.assertIdentity(batch);requireCondition(batch.state==='RUNNING','BATCH_PAUSED','请先恢复批次',409);
        requireCondition(['PAUSED','QUEUED','BLOCKED'].includes(action.status) && !this.service.store.find<{action_id:string}>('attempts',a=>a.action_id===action.id),'ACTION_ALREADY_ATTEMPTED','已进入提交边界的动作只能核实，不能重投',409);
        this.updateAction(action,'QUEUED');
      }
    }
    const state=command==='pause'?'PAUSED':command==='cancel'?'CANCELLED':'QUEUED';
    if (task.payload.action_id && command!=='resume') {const a=this.service.get<Action>('actions',String(task.payload.action_id));if (['QUEUED','PAUSED','BLOCKED'].includes(a.status)) this.updateAction(a,state==='PAUSED'?'PAUSED':'CANCELLED');}
    return this.service.store.put('tasks',{...task,state,error:null,attempts:command==='resume'?0:task.attempts,run_after:now(),lease_until:null,owner:null});
  }
}
