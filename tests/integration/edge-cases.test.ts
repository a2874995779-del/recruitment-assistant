import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../helpers.js';
import type { Job, Message } from '../../packages/contracts/src/index.js';
import { Notifications, type NotificationRecord } from '../../packages/notifications/src/index.js';
import { deadlinePassed } from '../../packages/domain/src/matching.js';
import type { Task } from '../../packages/contracts/src/index.js';

test('confirmation requires the unchanged preview snapshot',async()=>{
  const h=await setup();try{
    h.service.updateRule(h.rule.id,{name:'修改后的规则',root:{kind:'condition',field:'locations',op:'EQ',value:'武汉'}});
    assert.throws(()=>h.service.createBatch(h.input),/重新查看批次摘要/);
    assert.equal(h.store.all('batches').length,0);
    assert.equal(h.service.createBatch(h.approve(h.input)).rule_version,2);
  }finally{await h.cleanup();}
});
test('date-only deadlines include the whole day in the source timezone',async()=>{
  const h=await setup();try{
    const job:Job={...h.job,deadline_at:'2026-10-09',deadline_precision:'DATE',deadline_timezone:'Asia/Shanghai'};
    assert.equal(deadlinePassed(job,new Date('2026-10-09T15:59:59Z')),false);
    assert.equal(deadlinePassed(job,new Date('2026-10-09T16:00:00Z')),true);
    const expired={...h.job,deadline_at:'2020-01-01',deadline_precision:'DATE' as const,deadline_timezone:'Asia/Shanghai'};
    const b=h.service.createBatch(h.input);h.store.put('jobs',expired);await h.scheduler.tick({schedule:false});
    assert.equal(h.service.batchDetail(b.id).actions[0]?.status,'SKIPPED');assert.equal(h.store.all('attempts').length,0);
  }finally{await h.cleanup();}
});
test('read failure does not advance the committed checkpoint',async()=>{
  const h=await setup();try{
    const before=h.store.get('sync_cursors',`jobs:${h.account.id}`);
    const original=h.service.adapters.forAccount.bind(h.service.adapters);
    h.service.adapters.forAccount=account=>{const adapter=original(account);adapter.searchJobs=async()=>{throw new Error('SIMULATED_NETWORK_ERROR');};return adapter;};
    h.service.enqueueSync(h.account.id,'SYNC_JOBS');await h.scheduler.tick({schedule:false});
    assert.deepEqual(h.store.get('sync_cursors',`jobs:${h.account.id}`),before);assert.equal(h.store.all('jobs').length,4);
  }finally{await h.cleanup();}
});
test('unread-only coverage and fallback identifiers remain explicit',async()=>{
  const h=await setup();try{
    const original=h.service.adapters.forAccount.bind(h.service.adapters);
    h.service.adapters.forAccount=account=>{const adapter=original(account);adapter.syncMessages=async()=>({messages:[{
      account_id:account.id,source_message_id:null,conversation_id:'summary',sender:'[模拟] 平台摘要',body:null,coverage:'UNREAD_COUNT',unread_count:3,
      source_sent_at:null,source_url:'https://mock.example.com/messages',uncertain:true,mode:'MOCK'
    }],next_cursor:'summary:3'});return adapter;};
    h.service.enqueueSync(h.account.id,'SYNC_MESSAGES');await h.scheduler.tick({schedule:false});h.service.enqueueSync(h.account.id,'SYNC_MESSAGES');await h.scheduler.tick({schedule:false});
    const m=h.store.all<Message>('messages')[0]!;assert.equal(m.coverage,'UNREAD_COUNT');assert.equal(m.body,null);assert.equal(m.source_sent_at,null);assert.equal(m.uncertain,true);assert.equal(h.store.all('messages').length,1);
  }finally{await h.cleanup();}
});
test('desktop quiet hours defer delivery and privacy hides the message body',async()=>{
  const h=await setup();try{
    const sent:{title:string;body:string}[]=[];
    h.service.saveSettings({desktop_enabled:true,quiet_hours:{start:0,end:0},body_preview:false});
    const notifications=new Notifications(h.store,()=>h.service.getSettings(),{async send(title,body){sent.push({title,body});}});
    notifications.emit('unique-message','NEW_MESSAGE','新消息','私密消息正文');await notifications.flush();
    assert.equal(sent.length,0);assert.equal(h.store.all<NotificationRecord>('notifications').filter(n=>n.channel==='IN_APP').length,1);
    h.service.saveSettings({desktop_enabled:true,quiet_hours:null,body_preview:false});await notifications.flush();await notifications.flush();
    assert.equal(sent.length,1);assert.equal(sent[0]?.body,'打开招聘助手查看详情');
  }finally{await h.cleanup();}
});
test('unsupported independent actions do not block supported actions in the same batch',async()=>{
  const h=await setup();try{
    const b=h.service.createBatch(h.approve({...h.input,actions:['APPLY','EXTERNAL_APPLICATION']}));
    assert.equal(b.actions.find(a=>a.type==='APPLY')?.status,'QUEUED');
    assert.equal(b.actions.find(a=>a.type==='EXTERNAL_APPLICATION')?.status,'BLOCKED');
    await h.scheduler.tick({schedule:false});assert.equal(h.service.batchDetail(b.id).actions.find(a=>a.type==='APPLY')?.status,'SUCCEEDED');
  }finally{await h.cleanup();}
});
test('corrected profile can explicitly resume a blocked action before any submission',async()=>{
  const h=await setup();try{
    h.service.saveProfile({education:'本科',major:null,graduation_year:2027,experience_years:1});
    const b=h.service.createBatch(h.approve(h.input));assert.equal(b.actions[0]?.status,'BLOCKED');
    const task=h.store.all<Task>('tasks').find(t=>t.payload.action_id===b.actions[0]?.id)!;
    h.service.saveProfile({education:'本科',major:'计算机科学与技术',graduation_year:2027,experience_years:1});
    h.scheduler.controlTask(task.id,'resume');await h.scheduler.tick({schedule:false});assert.equal(h.service.batchDetail(b.id).actions[0]?.status,'SUCCEEDED');
  }finally{await h.cleanup();}
});
test('increased runtime limit cannot expand an already approved batch quota',async()=>{
  const h=await setup();try{
    h.service.saveSettings({daily_action_limit:1});const b=h.service.createBatch(h.approve({...h.input,actions:['GREETING','SEND_RESUME']}));
    h.service.saveSettings({daily_action_limit:2});await h.scheduler.tick({schedule:false});await h.scheduler.tick({schedule:false});
    assert.equal(h.store.all('attempts').length,1);assert.equal(h.service.batchDetail(b.id).limits.daily_action_limit,1);
  }finally{await h.cleanup();}
});
