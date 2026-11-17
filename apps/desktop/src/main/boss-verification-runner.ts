import { searchRunSchema, evaluateSearchJob, needsSearchVerification, type BossSearchRun, type BossSearchConfig } from '../../../../packages/contracts/src/boss-search.js';
import type { BrowserJob } from '../../../../packages/contracts/src/boss-browser.js';
import { needsSalary } from './boss-salary-detail.js';
import { SearchBlocked } from './boss-search-runner.js';

export const needsVerification=needsSearchVerification;
type Port={read(job:BrowserJob,deadline:number):Promise<BrowserJob|null>;now():number;wait(ms:number):Promise<void>;checkpoint(run:BossSearchRun):void;savedUrls():string[]};
/** Explicit, bounded repair of existing observations. Never opens a search list. */
export class BossVerificationRunner {
  run:BossSearchRun;
  private stopped=false;
  private reason='用户停止';
  constructor(previous:BossSearchRun,private port:Port){
    const seed=searchRunSchema.parse(structuredClone(previous));
    if(seed.status==='RUNNING')throw new Error('请先停止当前任务');
    this.run={...seed,status:'RUNNING',activity:'VERIFY',detail_progress:undefined};
  }
  get cancelled(){return this.stopped;}
  stop(reason='用户停止'){this.stopped=true;this.reason=reason;}
  async execute(){
    const saved=new Set(this.run.config.skip_saved?this.port.savedUrls():[]);
    // Unchecked items first; retry failures only after those, avoiding starvation.
    const pending=this.run.results.filter(item=>!saved.has(item.job.url) && needsVerification(item.job,this.run.config)).sort((a,b)=>Number(!!a.verification)-Number(!!b.verification));
    const progress:NonNullable<BossSearchRun['detail_progress']>=this.run.detail_progress={total:pending.length,checked:0,updated:0,failed:0,running:true,reason:''};
    const deadline=this.port.now()+120000;
    const publish=()=>this.port.checkpoint(this.run);
    let errors=0;
    try {
      publish();
      for(const item of pending.slice(0,50)){
        if(this.stopped || this.port.now()>=deadline)break;
        try {
          const next=await this.port.read(item.job,deadline);
          if(this.stopped)break;
          if(this.port.now()>=deadline){progress.reason='达到补全时限，迟到结果已丢弃';break;}
          progress.checked++;
          const at=new Date(this.port.now()).toISOString();
          if(next && next.url===item.job.url && next.title===item.job.title && next.company===item.job.company){
            item.job=next;progress.updated++;errors=0;
            item.verification={status:'DONE',observed_at:at,reason:evaluateSearchJob(next,this.run.config).status==='UNKNOWN'?'已读取详情，仍有条件待核实':'缺失字段已补全'};
          }else {progress.failed++;item.verification={status:'FAILED',observed_at:at,reason:'详情未返回可核对的缺失字段，原始数据保留'};}
        }catch(error){
          if(this.stopped)break;
          progress.checked++;progress.failed++;
          const reason=(error instanceof Error?error.message:'详情读取失败').slice(0,300);
          item.verification={status:error instanceof SearchBlocked?'BLOCKED':'FAILED',reason,observed_at:new Date(this.port.now()).toISOString()};
          if(error instanceof SearchBlocked){this.stop(reason);break;}
          if(++errors>=3){progress.reason='连续三次详情加载失败，已停止；可稍后重试';break;}
        }
        publish();if(!this.stopped)await this.port.wait(600);
      }
    }finally{
      progress.running=false;progress.reason ||= this.stopped?this.reason:progress.checked<pending.length?'达到本次 50 个 / 120 秒上限，剩余未检查项可再次补全':'本次补全结束；仍缺失或读取失败的字段可稍后重试';
      this.run.status=this.stopped?'STOPPED':'PARTIAL';
      // Do not alter scan dates, pair counts or segment counts for detail reads.
      publish();
    }
    return this.run;
  }
}
