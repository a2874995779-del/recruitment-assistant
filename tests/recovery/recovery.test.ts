import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../helpers.js';
import { Scheduler } from '../../packages/scheduler/src/index.js';
import type { Action, Task, Job } from '../../packages/contracts/src/index.js';

test('timeout after submission reconciles a durable receipt without submitting twice',async()=>{
  const h=await setup();try{
    h.store.put('jobs',{...h.job,extra:{mock_scenario:'timeout_after_submit'}});
    const b=h.service.createBatch(h.input);await h.scheduler.tick({schedule:false});
    assert.equal(h.service.batchDetail(b.id).actions[0]?.status,'UNKNOWN');
    await h.scheduler.tick({schedule:false});assert.equal(h.service.batchDetail(b.id).actions[0]?.status,'SUCCEEDED');
    assert.equal(h.store.all('attempts').length,1);
  }finally{await h.cleanup();}
});
test('unverifiable timeout stays unknown after repeated verification, never requeued for submission',async()=>{
  const h=await setup();try{
    h.store.put('jobs',{...h.job,extra:{mock_scenario:'timeout_unknown'}});
    const b=h.service.createBatch(h.input);await h.scheduler.tick({schedule:false});await h.scheduler.tick({schedule:false});
    const action=h.service.batchDetail(b.id).actions[0]!;assert.equal(action.status,'UNKNOWN');
    h.service.reconcile(action.id);await h.scheduler.tick({schedule:false});assert.equal(h.service.get<Action>('actions',action.id).status,'UNKNOWN');
    assert.equal(h.store.all('attempts').length,1);
    h.service.reportAction(action.id,{status:'SUCCEEDED',evidence:'人工查看平台申请记录'});
    assert.equal(h.service.get<Action>('actions',action.id).evidence_kind,'USER_REPORTED');
  }finally{await h.cleanup();}
});
test('expired external lease enters reconciliation while pre-submit lease is safely requeued',async()=>{
  const h=await setup();try{
    const batch=h.service.createBatch(h.approve({...h.input,actions:['GREETING','SEND_RESUME']}));const [a,b]=batch.actions;
    const tasks=h.store.all<Task>('tasks').filter(t=>t.kind==='ACTION');
    h.store.put('actions',{...a!,status:'EXECUTING'});h.store.put('actions',{...b!,status:'PRECHECKING'});
    for(const task of tasks)h.store.put('tasks',{...task,state:'RUNNING',owner:'dead-process',lease_until:'2020-01-01T00:00:00.000Z'});
    const recovery=new Scheduler(h.service);recovery.recoverExpired();
    assert.equal(h.service.get<Action>('actions',a!.id).status,'UNKNOWN');assert.equal(h.service.get<Action>('actions',b!.id).status,'QUEUED');
    assert.equal(h.store.all<Task>('tasks').filter(t=>t.kind==='RECONCILE').length,1);
    recovery.recoverExpired();assert.equal(h.store.all<Task>('tasks').filter(t=>t.kind==='RECONCILE').length,1);
  }finally{await h.cleanup();}
});
test('two schedulers serialize all account operations with a shared lease',async()=>{
  const h=await setup();try{
    const b=h.service.createBatch(h.approve({...h.input,actions:['GREETING','SEND_RESUME']}));const second=new Scheduler(h.service);
    await Promise.all([h.scheduler.tick({schedule:false}),second.tick({schedule:false})]);
    assert.equal(h.store.all('attempts').length,1);
    await second.tick({schedule:false});assert.equal(h.store.all('attempts').length,2);assert.ok(h.service.batchDetail(b.id).actions.every(a=>a.status==='SUCCEEDED'));
  }finally{await h.cleanup();}
});
test('redelivery and incompatible task contracts do not submit',async()=>{
  const h=await setup();try{
    const b=h.service.createBatch(h.input);await h.scheduler.tick({schedule:false});
    const task=h.store.all<Task>('tasks').find(t=>t.kind==='ACTION')!;
    h.store.put('tasks',{...task,state:'QUEUED'});await h.scheduler.tick({schedule:false});assert.equal(h.store.all('attempts').length,1);
    const obsolete=h.service.enqueue(h.account.id,'SYNC_JOBS',{});h.store.put('tasks',{...obsolete,contract_version:2});await h.scheduler.tick({schedule:false});
    assert.equal(h.service.get<Task>('tasks',obsolete.id).state,'BLOCKED');assert.equal(h.service.batchDetail(b.id).actions[0]?.status,'SUCCEEDED');
  }finally{await h.cleanup();}
});
