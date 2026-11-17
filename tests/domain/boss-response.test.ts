import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BossResponseObserver, enrichBrowserJob, isBossDetailResponse, parseBossDetailResponse } from "../../apps/desktop/src/main/boss-response.js";
import { mergeBrowserRead, browserJobInput } from "../../apps/desktop/src/main/boss-reader.js";
import { bossBrowserRequest, type BrowserJob } from "../../packages/contracts/src/boss-browser.js";

const time="2026-10-11T00:00:00.000Z";
const payload={code:0,zpData:{jobInfo:{encryptId:"RESPONSE123456",jobName:"Java 开发",salaryDesc:"12.5-18K·13薪",locationName:"武汉·江夏区",degreeName:"本科",experienceName:"应届生",postDescription:"Java SQL",address:"武汉市测试路"},brandComInfo:{brandName:"测试企业"},bossInfo:{name:"不应保存",encryptUserId:"private"}},token:"secret"};
const parse=()=>parseBossDetailResponse(JSON.stringify(payload),time)!;
const dom:BrowserJob={url:"https://www.zhipin.com/job_detail/RESPONSE123456.html",title:"Java 开发",company:"测试企业",salary:"\uE001-\uE002K",location:"",education:"",experience:"",tags:[]};
test("Detail response parser retains salary units and selects job fields without auth or recruiter data",()=>{
  const job=parse();assert.equal(job.salary,"12.5-18K·13薪");assert.equal(job.location,"武汉·江夏区");
  assert.equal(job.detail?.description,"Java SQL");
  assert.equal(JSON.stringify(job).includes("private"),false);assert.equal(JSON.stringify(job).includes("secret"),false);
  for(const body of ["invalid",JSON.stringify({...payload,code:37}),JSON.stringify({...payload,zpData:{}}),"x".repeat(1024*1024+1)])assert.equal(parseBossDetailResponse(body,time),null);
  assert.equal(isBossDetailResponse("https://www.zhipin.com/wapi/zpgeek/job/detail.json?securityId=secret"),true);
  for(const url of ["https://evil.example/wapi/zpgeek/job/detail.json","https://www.zhipin.com/wapi/zpgeek/chat.json","https://user:pass@www.zhipin.com/wapi/zpgeek/job/detail.json"])assert.equal(isBossDetailResponse(url),false);
});
test("Detail enrichment requires job, title and company identity and drops superseded OCR",()=>{
  const merged=enrichBrowserJob(dom,parse());assert.equal(merged.salary,"12.5-18K·13薪");assert.equal(merged.education,"本科");
  for(const response of [{...parse(),title:"其他岗位"},{...parse(),company:"其他企业"},{...parse(),url:"https://www.zhipin.com/job_detail/OTHERJOB123456.html"}])assert.equal(enrichBrowserJob(dom,response),dom);
  const raw=JSON.stringify({...payload,zpData:{...payload.zpData,jobInfo:{...payload.zpData.jobInfo,salaryDesc:"\uE123K"}}});
  assert.equal(enrichBrowserJob(dom,parseBossDetailResponse(raw,time)).salary,dom.salary);
});
test("List refresh retains response evidence, and saved input labels salary provenance",()=>{
  const old=enrichBrowserJob(dom,parse()),observation={observed_at:time,page_url:"https://www.zhipin.com/web/geek/jobs"};
  const merged=mergeBrowserRead({id:"old",jobs:[old],...observation},[dom],observation,true);
  assert.equal(merged.jobs[0]!.salary,old.salary);assert.equal(merged.jobs[0]!.detail_response?.observed_at,time);
  assert.equal(browserJobInput(merged.jobs[0]!,time).extra.salary_source,"BROWSER_DETAIL_RESPONSE");
  assert.equal(mergeBrowserRead({id:"old",jobs:[old],...observation},[{...dom,title:"新名称"}],observation,true).jobs[0]!.detail_response,undefined);
});

class Port extends EventEmitter {
  attached=false;commands:string[]=[];body=JSON.stringify(payload);getBody:()=>Promise<any>=async()=>({body:this.body,base64Encoded:false});
  isAttached(){return this.attached;}attach(){this.attached=true;}detach(){this.attached=false;}
  async sendCommand(method:string){this.commands.push(method);return method==="Network.getResponseBody"?this.getBody():{};}
  event(method:string,params:unknown){this.emit("message",{},method,params);}
}
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function response(port:Port,id="1",url="https://www.zhipin.com/wapi/zpgeek/job/detail.json"){
  port.event("Network.requestWillBeSent",{requestId:id,request:{url,method:"GET"}});
  port.event("Network.responseReceived",{requestId:id,response:{url,status:200,mimeType:"application/json"}});
  port.event("Network.loadingFinished",{requestId:id,encodedDataLength:100});
}
test("Observer only reads allowed browser response bodies and expires observations",async()=>{
  const port=new Port();let now=Date.parse(time);const context={epoch:1,url:"https://www.zhipin.com/web/geek/jobs"};
  const observer=new BossResponseObserver(port,()=>context,()=>now);await tick();
  response(port);await tick();assert.equal(observer.get(dom.url)?.salary,"12.5-18K·13薪");
  response(port,"2","https://www.zhipin.com/wapi/zpgeek/chat.json");await tick();
  assert.deepEqual(port.commands,["Network.enable","Network.getResponseBody"]);
  now+=120001;assert.equal(observer.get(dom.url),null);observer.dispose();assert.equal(port.attached,false);
});
test("Navigation, verification pages and disposal discard late responses",async()=>{
  for(const action of ["navigate","verify","dispose"]){
    const port=new Port(),context={epoch:1,url:"https://www.zhipin.com/web/geek/jobs"};let resolve!:(value:any)=>void;
    port.getBody=()=>new Promise(r=>{resolve=r;});const observer=new BossResponseObserver(port,()=>context);await tick();response(port);
    if(action==="navigate")context.epoch++;else if(action==="verify")context.url="https://www.zhipin.com/web/passport/zp/security.html";else observer.dispose();
    resolve({body:JSON.stringify(payload),base64Encoded:false});await tick();assert.equal(observer.get(dom.url),null);observer.dispose();
  }
});
test("Observer does not take over an existing debugger and IPC has no arbitrary batch parameters",async()=>{
  const port=new Port();port.attached=true;const observer=new BossResponseObserver(port,()=>({epoch:1,url:dom.url}));await tick();response(port);await tick();
  assert.deepEqual(port.commands,[]);observer.dispose();assert.equal(port.attached,true);
  assert.equal(bossBrowserRequest.safeParse({operation:"batch.start",payload:{}}).success,true);
  assert.equal(bossBrowserRequest.safeParse({operation:"batch.start",payload:{limit:100000,send:true}}).success,false);
});
test("Older in-flight response cannot replace newer data for the same job",async()=>{
  const port=new Port(),waiting:Array<(value:any)=>void>=[];
  port.getBody=()=>new Promise(resolve=>waiting.push(resolve));
  const observer=new BossResponseObserver(port,()=>({epoch:1,url:"https://www.zhipin.com/web/geek/jobs"}));await tick();
  response(port,"old");response(port,"new");
  waiting[1]!({body:JSON.stringify(payload).replace('12.5-18K','20-25K'),base64Encoded:false});await tick();
  waiting[0]!({body:JSON.stringify(payload),base64Encoded:false});await tick();
  assert.equal(observer.get(dom.url)?.salary,"20-25K·13薪");observer.dispose();
});
