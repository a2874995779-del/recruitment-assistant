import { bossPageKind, browserJobSchema, canonicalBossJob, type BrowserJob } from "../../../../packages/contracts/src/boss-browser.js";

const MAX_BODY = 1024 * 1024;
const TTL = 120000;
const object = (value:unknown):Record<string,unknown> => value && typeof value==="object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
const field = (record:Record<string,unknown>,key:string,max:number) => typeof record[key]==="string" ? (record[key] as string).trim().slice(0,max) : "";
export function isBossDetailResponse(url:string):boolean {
  try {const u=new URL(url);return !u.username && !u.password && u.origin==="https://www.zhipin.com" && u.pathname==="/wapi/zpgeek/job/detail.json";}catch{return false;}
}
export function parseBossDetailResponse(body:string, observed_at:string):BrowserJob|null {
  if(body.length>MAX_BODY)return null;
  try {
    const root=object(JSON.parse(body));
    if(root.code!==0)return null;
    const data=object(root.zpData), info=object(data.jobInfo), brand=object(data.brandComInfo);
    const id=field(info,"encryptId",200),url=canonicalBossJob(`https://www.zhipin.com/job_detail/${id}.html`);
    if(!url)return null;
    const salaryRaw=field(info,"salaryDesc",200);
    const salary=/[\uE000-\uF8FF]/.test(salaryRaw)?"":salaryRaw;
    const location=field(info,"locationName",100),education=field(info,"degreeName",40),experience=field(info,"experienceName",200);
    const result=browserJobSchema.safeParse({url,title:field(info,"jobName",200),company:field(brand,"brandName",200),salary,location,education,experience,tags:[],
      detail:{description:field(info,"postDescription",20000),address:field(info,"address",100),observed_at},
      detail_response:{salary,location,education,experience,observed_at}});
    return result.success?result.data:null;
  }catch{return null;}
}
const sameText=(a:string,b:string)=>a.normalize("NFKC").replace(/\s+/g,"").toLowerCase()===b.normalize("NFKC").replace(/\s+/g,"").toLowerCase();
export function enrichBrowserJob(job:BrowserJob,response:BrowserJob|null):BrowserJob {
  if(!response?.detail_response || job.url!==response.url || !sameText(job.title,response.title) || !sameText(job.company,response.company))return job;
  const evidence=response.detail_response;
  const detail=response.detail && (response.detail.description || response.detail.address)?{
    ...response.detail,description:response.detail.description || job.detail?.description || "",address:response.detail.address || job.detail?.address || "",
  }:job.detail;
  // A readable response salary supersedes an OCR candidate for this snapshot.
  const {salary_ocr,...fields}=job;
  return {...fields,salary:evidence.salary || job.salary,location:evidence.location || job.location,education:evidence.education || job.education,experience:evidence.experience || job.experience,
    ...(!evidence.salary && salary_ocr?{salary_ocr}:{}),...(detail?{detail}:{}),detail_response:evidence};
}

type DebuggerPort = {
  isAttached():boolean;attach(version?:string):void;detach():void;
  sendCommand(method:string,params?:Record<string,unknown>):Promise<any>;
  on(event:string,listener:(...args:any[])=>void):unknown;removeListener(event:string,listener:(...args:any[])=>void):unknown;
};
/** Observes only completed, whitelisted browser responses. Never issues HTTP requests. */
export class BossResponseObserver {
  private pending=new Map<string,{epoch:number;at:number;order:number;ready:boolean}>();
  private cache=new Map<string,{job:BrowserJob;epoch:number;at:number;order:number}>();
  private sequence=0;
  private alive=true;
  private owned=false;
  private inFlight=0;
  ready=false;
  constructor(private port:DebuggerPort,private context:()=>{epoch:number;url:string},private now=Date.now) {
    port.on("message",this.message);port.on("detach",this.detached);
    try {
      if(port.isAttached())return;
      port.attach("1.3");this.owned=true;
      void port.sendCommand("Network.enable",{maxTotalBufferSize:2*MAX_BODY,maxResourceBufferSize:MAX_BODY}).then(()=>{if(this.alive)this.ready=true;},()=>{this.ready=false;});
    }catch{this.ready=false;}
  }
  clear(){this.pending.clear();this.cache.clear();}
  get(url:string):BrowserJob|null {
    const value=this.cache.get(url),context=this.context();
    return value && value.epoch===context.epoch && this.now()-value.at<=TTL && ["JOBS","DETAIL"].includes(bossPageKind(context.url))?value.job:null;
  }
  private detached=()=>{this.ready=false;this.clear();};
  private message=(_event:unknown,method:string,params:any)=>{
    if(!this.alive || !this.owned)return;
    const context=this.context(),id=params?.requestId;
    if(typeof id!=="string")return;
    if(method==="Network.requestWillBeSent") {
      this.pending.delete(id);
      if(!["JOBS","DETAIL"].includes(bossPageKind(context.url)) || params.request?.method!=="GET" || !isBossDetailResponse(params.request?.url ?? ""))return;
      for(const [key,value] of this.pending)if(this.now()-value.at>TTL)this.pending.delete(key);
      if(this.pending.size<20)this.pending.set(id,{epoch:context.epoch,at:this.now(),order:++this.sequence,ready:false});
    }else if(method==="Network.responseReceived") {
      const value=this.pending.get(id),response=params.response;
      if(!value)return;
      if(response?.status!==200 || !isBossDetailResponse(response.url ?? "") || !/json/i.test(response.mimeType ?? "")){this.pending.delete(id);return;}
      value.ready=true;
    }else if(method==="Network.loadingFailed")this.pending.delete(id);
    else if(method==="Network.loadingFinished") {
      const value=this.pending.get(id);this.pending.delete(id);
      if(!value?.ready || value.epoch!==context.epoch || this.now()-value.at>TTL || params.encodedDataLength>MAX_BODY || this.inFlight>=4)return;
      this.inFlight++;
      void this.port.sendCommand("Network.getResponseBody",{requestId:id}).then(result=>{
        const current=this.context();
        if(!this.alive || value.epoch!==current.epoch || this.now()-value.at>TTL || !["JOBS","DETAIL"].includes(bossPageKind(current.url)))return;
        if(typeof result.body!=="string" || result.body.length>MAX_BODY || result.base64Encoded)return;
        const job=parseBossDetailResponse(result.body,new Date(this.now()).toISOString());
        if(job && (this.cache.get(job.url)?.order ?? -1)<value.order){this.cache.delete(job.url);this.cache.set(job.url,{job,epoch:value.epoch,at:this.now(),order:value.order});while(this.cache.size>50)this.cache.delete(this.cache.keys().next().value!);}
      }).catch(()=>{}).finally(()=>{this.inFlight--;});
    }
  };
  dispose(){this.alive=false;this.clear();this.port.removeListener("message",this.message);this.port.removeListener("detach",this.detached);if(this.owned && this.port.isAttached())this.port.detach();}
}
