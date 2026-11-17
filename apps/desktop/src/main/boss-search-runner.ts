import { randomUUID } from "node:crypto";
import { bossSearchUrl, searchConfigSchema, searchRunSchema, searchAdvanceSchema, type SearchAdvance, type BossSearchConfig, type BossSearchRun } from "../../../../packages/contracts/src/boss-search.js";
import { type BrowserJob } from "../../../../packages/contracts/src/boss-browser.js";
import { needsSalary } from './boss-salary-detail.js';

export class SearchBlocked extends Error {}
export type SearchPort={
  open(url:string,reuse?:boolean):Promise<void>;
  read(known:string[],waitForNew?:boolean,ignored?:string[]):Promise<BrowserJob[]>;
  advance():Promise<boolean|SearchAdvance>;
  wait(ms:number):Promise<void>;
  checkpoint(run:BossSearchRun):void;
  now():number;
  savedUrls?():string[];skippedUrls?():string[];
  processedUrls?():string[];
  seenJobs?():{url:string;first_read_at:string}[];
  salary?(job:BrowserJob,deadline:number):Promise<BrowserJob|null>;
};
/** A new run starts empty; an explicit continuation retains individually dated
 * observations and records new versus refreshed jobs for this segment. */
export class BossSearchRunner {
  run:BossSearchRun;
  private stopped=false;
  private stopReason="用户停止";
  constructor(config:BossSearchConfig,private port:SearchPort,previous?:BossSearchRun){
    const input=searchConfigSchema.parse(config);
    const at=new Date(port.now()).toISOString();
    if(previous){
      const seed=searchRunSchema.parse(structuredClone(previous));
      if(seed.status==='RUNNING')throw new Error('不能续读正在运行的任务');
      if(JSON.stringify(seed.config)!==JSON.stringify(input))throw new Error('续读必须沿用原任务条件；修改条件请重新获取');
      this.run={...seed,status:'RUNNING',activity:'SCAN',finished_at:null,reason:'',salary_progress:undefined,detail_progress:undefined,segment:{number:(seed.segment?.number ?? 1)+1,started_at:at,previous_total:seed.results.length,added:0,refreshed:0},pairs:seed.pairs.map(pair=>({...pair,status:'WAITING',reason:''}))};
    }else this.run={id:randomUUID(),config:input,started_at:at,finished_at:null,status:"RUNNING",reason:"",segment:{number:1,started_at:at,previous_total:0,added:0,refreshed:0},
      pairs:[...new Set(input.cities)].flatMap(city=>[...new Set(input.keywords)].map(keyword=>({city,keyword,status:"WAITING",rounds:0,seen:0,reason:""}))),results:[]};
  }
  stop(reason="用户停止"){this.stopped=true;this.stopReason=reason;}
  get cancelled(){return this.stopped;}
  async execute(){
    const collected=new Map(this.run.results.map(item=>[item.job.url,item])),existing=new Set(collected.keys()),refreshed=new Set<string>(),newJobs=new Set<string>(),started=this.port.now();
    const saved=new Set(this.run.config.skip_saved?this.port.savedUrls?.() ?? []:[]);
    const processed=new Set(this.run.config.skip_processed?this.port.processedUrls?.() ?? []:[]);
    for(const url of collected.keys())processed.delete(url);
    const ignored=new Set([...saved,...processed]),seenBefore=new Map((this.port.seenJobs?.() ?? []).map(item=>[item.url,item.first_read_at])),skipped=new Set<string>();
    const continuing=(this.run.segment?.number ?? 1)>1,active=this.run.active_pair;
    const order=this.run.pairs.map((pair,index)=>({pair,index}));
    if(continuing && active!==undefined)order.sort((a,b)=>Number(b.index===active)-Number(a.index===active));
    const publish=()=>{this.run.results=[...collected.values()];for(const url of this.port.skippedUrls?.() ?? [])skipped.add(url);this.run.skipped_saved=[...skipped].filter(url=>saved.has(url)).length;this.run.skipped_processed=[...skipped].filter(url=>!saved.has(url)&&processed.has(url)).length;this.port.checkpoint(this.run);};
    try {
      publish();
      for(const {pair,index} of order){
        if(this.stopped || this.port.now()-started>=600000 || collected.size>=2000)break;
        this.run.active_pair=index;
        pair.status="RUNNING";publish();
        const query=`${pair.city} · ${pair.keyword}`;
        const known=new Set([...collected.values()].filter(item=>item.queries.includes(query)).map(item=>item.job.url));let idle=0,advance:SearchAdvance|boolean|undefined;
        try {
          await this.port.open(bossSearchUrl(pair.city as keyof typeof import("../../../../packages/contracts/src/boss-search.js").searchCities,pair.keyword),continuing && index===active);
          if(this.stopped)break;
          for(let round=0;round<this.run.config.rounds;round++){
            if(this.stopped || this.port.now()-started>=600000 || collected.size>=2000)break;
            const jobs=await this.port.read([...known],typeof advance==='object'?advance.at_end || advance.action==='NEXT_PAGE':advance!==undefined,[...ignored]);
            if(this.stopped)break;
            if(this.port.now()-started>=600000){pair.reason='达到本次 10 分钟时限，迟到读取已丢弃';break;}
            if(!jobs.length && !ignored.size)throw new Error("未识别到岗位；不能判定本次搜索没有职位");
            const observed_at=new Date(this.port.now()).toISOString();let added=0;
            for(const job of jobs){
              if(ignored.has(job.url)){skipped.add(job.url);continue;}
              if(!known.has(job.url)){known.add(job.url);added++;}
              if(collected.size>=2000 && !collected.has(job.url))continue;
              const old=collected.get(job.url);
              if(!old)newJobs.add(job.url);
              if(existing.has(job.url))refreshed.add(job.url);
              collected.set(job.url,{job,observed_at,queries:[...new Set([...(old?.queries ?? []),query])],discovery:old?.discovery ?? (seenBefore.has(job.url)?'SEEN':'NEW'),first_read_at:old?.first_read_at ?? seenBefore.get(job.url) ?? observed_at});
            }
            if(this.run.segment){this.run.segment.added=newJobs.size;this.run.segment.refreshed=refreshed.size;}
            pair.rounds++;pair.seen=known.size;publish();
            // Repeated cards while moving through the middle are not evidence
            // of exhaustion. Count idle batches only after reaching the bottom.
            idle=added || (typeof advance==='object' && !advance.at_end)?0:idle+1;
            if(idle>=3){pair.status="STALLED";pair.reason="连续三批没有新增，已停止；搜索可能仍有未返回岗位";break;}
            if(round===this.run.config.rounds-1)break;
            const step=await this.port.advance();if(this.stopped)break;
            advance=typeof step==='boolean'?step:searchAdvanceSchema.parse(step);
            if(typeof advance==='object'){
              pair.advance=advance;
              if(advance.action==='SECURITY')throw new SearchBlocked(advance.reason);
              if(advance.action==='END'){pair.status='END';pair.reason=advance.reason;break;}
              if(advance.action==='UNSUPPORTED'){pair.status='STALLED';pair.reason=advance.reason;break;}
            }else if(!advance){pair.status="STALLED";pair.reason="未找到可继续滚动的列表";break;}
            publish();
            for(let tick=0;tick<15 && !this.stopped;tick++)await this.port.wait(100);
          }
          if(pair.status==="RUNNING"){pair.status=this.stopped?"STOPPED":"LIMIT";pair.reason ||= this.stopped?this.stopReason:"达到本段批数、时间或数量上限，可继续获取";}
        }catch(error){
          pair.status=this.stopped?"STOPPED":error instanceof SearchBlocked?"BLOCKED":"FAILED";
          pair.reason=this.stopped?this.stopReason:(error instanceof Error?error.message:"读取失败").slice(0,300);
          if(error instanceof SearchBlocked){this.run.reason=pair.reason;break;}
        }
        publish();
      }
      if (!this.stopped && this.run.config.salary_enrichment && this.port.salary && !this.run.pairs.some(pair=>pair.status==='BLOCKED')) {
        const pending=[...collected.values()].filter(item=>!ignored.has(item.job.url) && needsSalary(item.job)).sort((a,b)=>Number(newJobs.has(b.job.url))-Number(newJobs.has(a.job.url)));
        const progress:NonNullable<BossSearchRun['salary_progress']>=this.run.salary_progress={total:pending.length,checked:0,updated:0,failed:0,running:true,reason:''};
        const deadline=Math.min(started+600000,this.port.now()+120000);let consecutiveErrors=0;
        publish();
        for (const item of pending.slice(0,50)) {
          if(this.stopped || this.port.now()>=deadline)break;
          try {
            const enriched=await this.port.salary(item.job,deadline);
            if(this.stopped)break;
            progress.checked++;
            if(this.port.now()>=deadline){progress.failed++;break;}
            if(enriched && enriched.url===item.job.url && enriched.title===item.job.title && enriched.company===item.job.company && enriched.salary_detail && !needsSalary(enriched)) {
              collected.set(item.job.url,{...item,job:enriched});progress.updated++;
            }else progress.failed++;
            consecutiveErrors=0;
          } catch(error) {
            if(this.stopped)break;
            progress.checked++;progress.failed++;
            if(error instanceof SearchBlocked){this.stop(error.message);break;}
            if(++consecutiveErrors>=3){progress.reason='连续三次详情读取失败，已停止薪资补全；原始岗位保留';break;}
          }
          publish();
          if(this.port.now()<deadline && !this.stopped)await this.port.wait(600);
        }
        progress.running=false;
        progress.reason ||= this.stopped?this.stopReason:progress.checked<pending.length?'达到本次最多 50 个 / 120 秒或搜索总时限，尚有薪资未核实':'本次薪资补全结束；失败项保留原始薪资';
        publish();
      }
    }catch(error){this.run.reason=(error instanceof Error?error.message:"本地保存失败").slice(0,300);}
    finally{
      if(this.run.salary_progress?.running){this.run.salary_progress.running=false;this.run.salary_progress.reason ||= this.stopped?this.stopReason:'薪资补全中断，已读结果保留';}
      this.run.status=this.stopped?"STOPPED":"PARTIAL";
      this.run.finished_at=new Date(this.port.now()).toISOString();
      for(const pair of this.run.pairs)if(pair.status==="RUNNING"){pair.status="STOPPED";pair.reason=this.stopReason;}
      this.run.reason ||= this.stopped?`已停止：${this.stopReason}；已读结果保留，可手动继续获取`:"本段扫描结束。覆盖率未知，未扫描的组合和未返回岗位可能存在；可继续获取。";
      publish();
    }
    return this.run;
  }
}
