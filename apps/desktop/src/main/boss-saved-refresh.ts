import type { BrowserJob } from '../../../../packages/contracts/src/boss-browser.js';
import type { SavedRefreshState } from '../../../../packages/contracts/src/job-management.js';
import { SearchBlocked } from './boss-search-runner.js';

type Port={now():number;wait(ms:number):Promise<void>;read(job:BrowserJob,deadline:number):Promise<BrowserJob|null>;save(id:string,job:BrowserJob,at:string):void;record(id:string,status:'FAILED'|'STOPPED',reason:string,at:string):void};
export class BossSavedRefresh {
  private stopped=false;
  private stopReason='用户停止，旧记录保留';
  readonly progress:SavedRefreshState;
  constructor(private jobs:{id:string;job:BrowserJob}[],private port:Port){if(!jobs.length || jobs.length>20)throw new Error('每次更新 1–20 个已保存岗位');this.progress={running:true,total:jobs.length,checked:0,updated:0,failed:0,reason:'',items:[]};}
  get cancelled(){return this.stopped;}
  stop(reason='用户停止，旧记录保留'){this.stopped=true;this.stopReason=reason;}
  async execute(){
    const deadline=this.port.now()+120000;let errors=0;
    try{
      for(const item of this.jobs){
        if(this.stopped || this.port.now()>=deadline)break;
        try{
          const next=await this.port.read(item.job,deadline);
          if(this.stopped){this.port.record(item.id,'STOPPED',this.stopReason,new Date(this.port.now()).toISOString());this.progress.items.push({id:item.id,status:'STOPPED',reason:this.stopReason});break;}
          if(this.port.now()>=deadline)break;
          if(!next)throw new Error('原帖未返回可核对的薪资和地点，旧记录保留');
          this.port.save(item.id,next,new Date(this.port.now()).toISOString());
          this.progress.checked++;this.progress.updated++;errors=0;
          this.progress.items.push({id:item.id,status:'DONE',reason:'已更新原帖薪资与地点'});
        }catch(error){
          if(this.stopped){this.port.record(item.id,'STOPPED',this.stopReason,new Date(this.port.now()).toISOString());this.progress.items.push({id:item.id,status:'STOPPED',reason:this.stopReason});break;}
          const reason=(error instanceof Error?error.message:'详情更新失败，旧记录保留').slice(0,300);
          this.port.record(item.id,'FAILED',reason,new Date(this.port.now()).toISOString());
          this.progress.checked++;this.progress.failed++;this.progress.items.push({id:item.id,status:'FAILED',reason});
          if(error instanceof SearchBlocked){this.stop(reason);break;}
          if(++errors>=3){this.stop('连续三次详情读取失败，旧记录保留，请稍后重试');break;}
        }
        if(!this.stopped)await this.port.wait(600);
      }
    }finally{this.progress.running=false;this.progress.reason=this.stopped?this.stopReason:this.progress.checked<this.jobs.length?'达到 120 秒时限，未检查项保留旧记录，可稍后重试':'本次更新结束，未发送消息或简历';}
  }
}
