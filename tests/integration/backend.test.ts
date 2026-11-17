import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from '../helpers.js';
import type { Action, Job, Message, Rule } from '../../packages/contracts/src/index.js';
import { createBackup, restoreBackup } from '../../packages/persistence/src/backup.js';
import { Store } from '../../packages/persistence/src/database.js';

test('HTTP authentication, origin rejection and strict validation',async()=>{
  const h=await setup();try{
    assert.equal((await h.app.inject({url:'/health'})).statusCode,200);
    assert.equal((await h.app.inject({url:'/api/v1/profile'})).statusCode,401);
    assert.equal((await h.app.inject({url:'/api/v1/profile',headers:{...h.headers,origin:'https://evil.example'}})).statusCode,403);
    assert.equal((await h.app.inject({url:'/api/v1/profile',headers:{...h.headers,host:'evil.example'}})).statusCode,403);
    assert.equal((await h.app.inject({method:'PUT',url:'/api/v1/profile',headers:h.headers,payload:{graduation_year:'invalid'}})).statusCode,400);
    assert.equal((await h.app.inject({method:'POST',url:'/api/v1/accounts',headers:h.headers,payload:{platform:'boss',nickname:'x',password:'secret'}})).statusCode,400);
  }finally{await h.cleanup();}
});
test('sync deduplicates source jobs, preserves source time and stores revisions',async()=>{
  const h=await setup();try{
    h.service.enqueueSync(h.account.id,'SYNC_JOBS');await h.scheduler.tick({schedule:false});
    assert.equal(h.store.all('jobs').length,4);
    assert.equal(h.service.get<Job>('jobs',h.job.id).published_at,null);
    const raw=await h.service.adapters.forAccount(h.account).fetchJobDetail(h.job);
    h.service.importJobs([{...raw,salary_min:14000}],true);
    assert.equal(h.store.all('job_revisions').length,1);
    assert.equal(h.service.get<Job>('jobs',h.job.id).first_seen_at,h.job.first_seen_at);
    assert.throws(()=>h.service.importJobs([raw]),/IMPORT/);
    const imported=h.service.importJobs([{...raw,mode:'IMPORT',source_instance_id:'manual',external_job_id:'manual-1'}])[0]!;
    assert.equal(imported.last_verified_at,null);
  }finally{await h.cleanup();}
});
test('confirmed batch executes and records frozen resume and distinct actions',async()=>{
  const h=await setup();try{
    const response=await h.app.inject({method:'POST',url:'/api/v1/batches',headers:h.headers,payload:h.approve({...h.input,actions:['GREETING','SEND_RESUME']})});
    assert.equal(response.statusCode,201,response.body);const batch=response.json();
    assert.equal(batch.resume_hash,h.resume.file_hash);
    await h.scheduler.tick({schedule:false});
    let actions=h.service.batchDetail(batch.id).actions;
    assert.equal(actions.find(a=>a.type==='GREETING')?.status,'SUCCEEDED');
    assert.equal(actions.find(a=>a.type==='SEND_RESUME')?.status,'QUEUED');
    await h.scheduler.tick({schedule:false});actions=h.service.batchDetail(batch.id).actions;
    assert.ok(actions.every(a=>a.status==='SUCCEEDED' && a.evidence_kind==='MOCK_VERIFIED'));
    assert.equal(h.store.all('attempts').length,2);
    const csv=await h.app.inject({url:'/api/v1/ledger.csv',headers:h.headers});assert.match(csv.body,/GREETING/);assert.match(csv.body,/SEND_RESUME/);
  }finally{await h.cleanup();}
});
test('batch idempotency rejects duplicates and rolls back all partial inserts',async()=>{
  const h=await setup();try{
    const batch=h.service.createBatch(h.input);assert.equal(h.service.createBatch(h.input).id,batch.id);
    assert.throws(()=>h.service.createBatch({...h.input,greeting:'changed'}),/幂等键/);
    assert.throws(()=>h.service.createBatch({...h.input,idempotency_key:'different-key-1'}),/已存在/);
    assert.equal(h.store.all('batches').length,1);assert.equal(h.store.all('actions').length,1);
    assert.throws(()=>h.service.createBatch({...h.input,job_ids:[h.job.id,h.job.id],idempotency_key:'dup-jobs-1'}),/不能重复/);
  }finally{await h.cleanup();}
});
test('latest rule recheck can skip queued submission without changing approved version',async()=>{
  const h=await setup();try{
    const batch=h.service.createBatch(h.input);
    h.service.updateRule(h.rule.id,{name:'上海岗位',root:{kind:'condition',field:'locations',op:'IN',value:['上海']}});
    await h.scheduler.tick({schedule:false});
    assert.equal(h.service.batchDetail(batch.id).actions[0]?.status,'SKIPPED');
    assert.equal(h.service.batchDetail(batch.id).rule_version,1);
    assert.equal(h.store.all<Rule>('rules').find(r=>r.id===`${h.rule.id}@1`)?.version,1);
    assert.equal(h.store.all('attempts').length,0);
  }finally{await h.cleanup();}
});
test('resume tampering blocks execution before external submission',async()=>{
  const h=await setup();try{
    const batch=h.service.createBatch(h.input);
    writeFileSync(join(h.directory,'resumes',h.resume.file_ref),'modified');
    await h.scheduler.tick({schedule:false});
    assert.equal(h.service.batchDetail(batch.id).actions[0]?.status,'BLOCKED');assert.equal(h.store.all('attempts').length,0);
  }finally{await h.cleanup();}
});
test('external applications and uncertain campus eligibility stay blocked',async()=>{
  const h=await setup();try{
    const jobs=h.store.all<Job>('jobs');const batch=h.service.createBatch(h.approve({...h.input,job_ids:[jobs[1]!.id,jobs[2]!.id]}));
    assert.ok(batch.actions.every(a=>a.status==='BLOCKED'));
    await h.scheduler.tick({schedule:false});assert.equal(h.store.all('attempts').length,0);
  }finally{await h.cleanup();}
});
test('disconnect invalidates old approved batches, reconnect does not silently resume',async()=>{
  const h=await setup();try{
    const batch=h.service.createBatch(h.input);await h.service.disconnectAccount(h.account.id);await h.service.connectAccount(h.account.id);
    assert.throws(()=>h.service.controlBatch(batch.id,'resume'),/身份代次/);
    await h.scheduler.tick({schedule:false});assert.equal(h.store.all('attempts').length,0);assert.equal(h.service.batchDetail(batch.id).actions[0]?.status,'BLOCKED');
  }finally{await h.cleanup();}
});
test('history is quiet, live messages notify once, source time remains unknown',async()=>{
  const h=await setup();try{
    h.service.enqueueSync(h.account.id,'SYNC_MESSAGES');await h.scheduler.tick({schedule:false});
    assert.equal(h.store.all('messages').length,1);assert.equal(h.store.all('notifications').length,0);
    h.service.enqueueSync(h.account.id,'SYNC_MESSAGES');await h.scheduler.tick({schedule:false});
    h.service.enqueueSync(h.account.id,'SYNC_MESSAGES');await h.scheduler.tick({schedule:false});
    assert.equal(h.store.all('messages').length,2);assert.equal(h.store.all('notifications').length,1);
    const message=h.store.all<Message>('messages')[1]!;assert.equal(message.source_sent_at,null);assert.ok(message.observed_at);
    await h.app.inject({method:'POST',url:`/api/v1/messages/${message.id}/read`,headers:h.headers});
    assert.equal(h.service.get<Message>('messages',message.id).local_read,true);
  }finally{await h.cleanup();}
});
test('queue stop, resume and cancelled actions never accidentally execute',async()=>{
  const h=await setup();try{
    const batch=h.service.createBatch(h.input);h.scheduler.pause(true);await h.scheduler.tick({schedule:false});assert.equal(h.store.all('attempts').length,0);
    h.service.controlBatch(batch.id,'pause');h.scheduler.pause(false);await h.scheduler.tick({schedule:false});assert.equal(h.store.all('attempts').length,0);
    h.service.controlBatch(batch.id,'resume');h.service.controlBatch(batch.id,'cancel');await h.scheduler.tick({schedule:false});
    assert.equal(h.service.batchDetail(batch.id).actions[0]?.status,'CANCELLED');assert.equal(h.store.all('attempts').length,0);
  }finally{await h.cleanup();}
});
test('daily action limit counts only submitted intents',async()=>{
  const h=await setup();try{
    h.service.saveSettings({daily_action_limit:1});const b=h.service.createBatch(h.approve({...h.input,actions:['GREETING','SEND_RESUME']}));
    await h.scheduler.tick({schedule:false});await h.scheduler.tick({schedule:false});
    assert.equal(h.store.all('attempts').length,1);assert.equal(h.service.batchDetail(b.id).actions[1]?.status,'QUEUED');
  }finally{await h.cleanup();}
});
test('backup restores database and immutable resumes, pauses queue and disconnects identity',async()=>{
  const h=await setup();try{
    h.service.createBatch(h.input);const backup=await createBackup(h.service);
    const target=join(h.directory,'restored');const result=restoreBackup(join(h.directory,'backups',backup.id),target);assert.equal(result.queue_paused,true);
    const restored=new Store(join(target,'database','app.sqlite'));
    try{assert.equal(restored.all('jobs').length,4);assert.equal(restored.all('resumes').length,1);assert.equal(restored.all<{status:string}>('accounts')[0]?.status,'DISCONNECTED');assert.equal(restored.all<{state:string}>('tasks')[1]?.state,'BLOCKED');}finally{restored.close();}
  }finally{await h.cleanup();}
});
test('company source catalogue preserves evidence and does not enable scraping',async()=>{
  const h=await setup();try{
    assert.throws(()=>h.service.sources.createCompany({name:'某集团',nature_tags:['央企'],verified:true}),/证据/);
    const company=h.service.sources.createCompany({name:'某集团',nature_tags:['央企'],evidence_url:'https://example.com/official',verified:true});
    const source=h.service.sources.createSource({company_id:company.id,url:'https://example.com/careers',type:'OFFICIAL'});
    assert.equal(source.collection_enabled,false);assert.equal(source.status,'UNVERIFIED');
  }finally{await h.cleanup();}
});
