import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const root=mkdtempSync(join(tmpdir(),'recruitment-http-test-'));const directory=join(root,'private-runtime');
const probe=createServer();await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
const port=(probe.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
const child=spawn(process.execPath,[resolve('dist/apps/api/src/index.js')],{env:{...process.env,RA_DATA_DIR:directory,RA_PORT:String(port),RA_API_TOKEN:undefined},windowsHide:true,stdio:['ignore','ignore','pipe']});
let error='';child.stderr.on('data',data=>{error+=data;});
const base=`http://127.0.0.1:${port}`;const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  let ready=false;
  for(let i=0;i<100;i++){try{if((await fetch(`${base}/health`)).ok){ready=true;break;}}catch{}if(child.exitCode!==null)break;await sleep(100);}
  assert.equal(ready,true,`后端启动失败：${error}`);
  assert.equal((await fetch(`${base}/api/v1/profile`)).status,401);
  const token=readFileSync(join(directory,'api-token'),'utf8').trim();
  async function request(path:string,method='GET',payload?:unknown):Promise<any>{
    const response=await fetch(`${base}/api/v1${path}`,{method,headers:{authorization:`Bearer ${token}`,...(payload===undefined?{}:{'content-type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    assert.ok(response.ok,await response.clone().text());return response.json();
  }
  await request('/profile','PUT',{education:'本科',major:'计算机科学与技术',graduation_year:2027,experience_years:1});
  const account=await request('/accounts','POST',{platform:'boss',mode:'MOCK',nickname:'[模拟] HTTP 验收'});
  await request(`/accounts/${account.id}/connect`,'POST');await request(`/accounts/${account.id}/sync`,'POST',{kind:'SYNC_JOBS'});
  let jobs:any[]=[];
  for(let i=0;i<50;i++){jobs=(await request('/jobs')).items;if(jobs.length===4)break;await sleep(100);}
  assert.equal(jobs.length,4);
  const job=jobs.find(j=>j.external_job_id==='sample-1');
  const resume=await request('/resumes','POST',{name:'HTTP 模拟简历',filename:'demo.pdf',content_base64:Buffer.from('%PDF-1.4\n% MOCK\n%%EOF').toString('base64')});
  const rule=await request('/rules','POST',{name:'武汉',root:{kind:'condition',field:'locations',op:'IN',value:['武汉']}});
  const input={job_ids:[job.id],account_id:account.id,resume_id:resume.id,rule_id:rule.id,actions:['APPLY']};
  const preview=await request('/batches/preview','POST',input);
  const batch=await request('/batches','POST',{...input,approved:true,idempotency_key:'http-smoke-batch-001',preview_hash:preview.preview_hash});
  let result:any;
  for(let i=0;i<70;i++){result=await request(`/batches/${batch.id}`);if(result.actions[0].status==='SUCCEEDED')break;await sleep(100);}
  assert.equal(result.actions[0].status,'SUCCEEDED');assert.equal(result.actions[0].evidence_kind,'MOCK_VERIFIED');
  console.log('API_SMOKE_OK：实际 HTTP 进程、令牌鉴权、岗位同步、预览确认、隔离工作进程及模拟结果核实通过。');
}finally{
  const exit=new Promise<void>(resolve=>child.once('exit',()=>resolve()));if(child.exitCode===null){child.kill();await exit;}
  rmSync(root,{recursive:true,force:true});
}
