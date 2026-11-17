import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/persistence/src/database.js';
import { RecruitmentService } from '../packages/application/src/service.js';
import { Scheduler } from '../packages/scheduler/src/index.js';
import { createServer } from '../apps/api/src/server.js';
import type { Job } from '../packages/contracts/src/index.js';

export async function setup() {
  const directory=mkdtempSync(join(tmpdir(),'recruitment-test-'));
  const store=new Store(join(directory,'database','app.sqlite'));
  const service=new RecruitmentService(store,directory);const scheduler=new Scheduler(service);
  const account=service.createAccount({platform:'boss',mode:'MOCK',nickname:'模拟测试账号'});
  await service.connectAccount(account.id);
  service.saveProfile({education:'本科',major:'计算机科学与技术',graduation_year:2027,experience_years:1});
  service.enqueueSync(account.id,'SYNC_JOBS');await scheduler.tick({schedule:false});
  const job=store.all<Job>('jobs')[0]!;
  const rule=service.createRule({name:'武汉岗位',root:{kind:'condition',field:'locations',op:'IN',value:['武汉'],effect:'MUST',unknown:'CONFIRM'}});
  const resume=service.importResume({name:'测试简历',filename:'resume.pdf',content_base64:Buffer.from('%PDF-1.4\n% mock-only\n%%EOF').toString('base64')});
  const approve=(raw:Record<string,unknown>)=>{const {approved:_approved,idempotency_key:_key,preview_hash:_hash,...preview}=raw;return {...raw,preview_hash:service.previewBatch(preview).preview_hash};};
  const input=approve({job_ids:[job.id],account_id:account.id,resume_id:resume.id,rule_id:rule.id,actions:['APPLY'],approved:true,idempotency_key:'test-batch-0001'});
  const token='test-token-abcdefghijklmnopqrstuvwxyz123456';
  const app=createServer(service,scheduler,token);
  return {directory,store,service,scheduler,account,job,rule,resume,input,approve,app,headers:{authorization:`Bearer ${token}`},async cleanup(){await scheduler.stop();await app.close();store.close();rmSync(directory,{recursive:true,force:true});}};
}
