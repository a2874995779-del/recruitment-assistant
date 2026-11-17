import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../packages/persistence/src/database.js';
import { RecruitmentService } from '../packages/application/src/service.js';
import { Scheduler } from '../packages/scheduler/src/index.js';
import type { Job } from '../packages/contracts/src/index.js';

const directory=mkdtempSync(join(tmpdir(),'recruitment-demo-'));
const store=new Store(join(directory,'database','app.sqlite'));const service=new RecruitmentService(store,directory);const scheduler=new Scheduler(service);
try {
  service.saveProfile({education:'本科',major:'计算机科学与技术',graduation_year:2027,experience_years:1});
  for(const platform of ['boss','wllm91'] as const) {
    const account=service.createAccount({platform,mode:'MOCK',nickname:`[模拟] ${platform}`,...(platform==='wllm91'?{station:{base_url:'https://gyjy.91wllm.cn',school_id:'demo-school'}}:{})});
    await service.connectAccount(account.id);service.enqueueSync(account.id,'SYNC_JOBS');await scheduler.tick({schedule:false});
    service.enqueueSync(account.id,'SYNC_MESSAGES');await scheduler.tick({schedule:false});
  }
  const rule=service.createRule({name:'武汉月薪下限 10K，未知需确认',root:{kind:'group',op:'AND',children:[{kind:'condition',field:'locations',op:'IN',value:['武汉']},{kind:'condition',field:'salary',op:'LOWER_BOUND',value:10000,currency:'CNY',salary_period:'MONTH',unknown:'CONFIRM'}]}});
  const resume=service.importResume({name:'[模拟] 后端开发简历',filename:'demo.pdf',content_base64:Buffer.from('%PDF-1.4\n% DEMO ONLY\n%%EOF').toString('base64')});
  const jobs=store.all<Job>('jobs');const job=jobs[0]!;const account=store.all<{id:string}>('accounts')[0]!;
  const preview={job_ids:[job.id,jobs[1]!.id,jobs[2]!.id],account_id:account.id,resume_id:resume.id,rule_id:rule.id,actions:['GREETING','SEND_RESUME'],greeting:'[模拟] 您好，我对这个岗位感兴趣。'};
  console.log('批次预览：',JSON.stringify(service.previewBatch(preview),null,2));
  const batch=service.createBatch({...preview,preview_hash:service.previewBatch(preview).preview_hash,approved:true,idempotency_key:'demo-batch-approved-001'});
  for(let i=0;i<4;i++)await scheduler.tick({schedule:false});
  console.log('模拟批次结果：',JSON.stringify(service.batchDetail(batch.id),null,2));
  service.enqueueSync(account.id,'SYNC_MESSAGES');await scheduler.tick({schedule:false});
  console.log('验收概览：',JSON.stringify(service.overview(),null,2));
  console.log(`演示数据库保留在：${directory}\n所有岗位和结果均为 MOCK；未访问 BOSS 或 91wllm。`);
} finally {await scheduler.stop();store.close();}
