import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from '../helpers.js';
import {Store} from '../../packages/persistence/src/database.js';
import {RecruitmentService} from '../../packages/application/src/service.js';
import {desktopCommand} from '../../packages/application/src/desktop-commands.js';
import {browserJobInput} from '../../apps/desktop/src/main/boss-reader.js';
import {savedJobQuerySchema,parseSavedSalary} from '../../packages/contracts/src/job-management.js';
import {mergeFreshDetail} from '../../apps/desktop/src/main/boss-salary-detail.js';
import {BossSavedRefresh} from '../../apps/desktop/src/main/boss-saved-refresh.js';
import {bossBrowserRequest} from '../../packages/contracts/src/boss-browser.js';

const seed={url:'https://www.zhipin.com/job_detail/SAVEDTEST123456.html',title:'Java 开发',company:'本地示例企业',salary:'5k-6k',location:'武汉市',education:'本科',experience:'应届生',tags:[]};
test('saved queries filter before pagination, use explicit salary units and literal text, and sort across pages',async()=>{
  const h=await setup();try{
    const inputs=Array.from({length:55},(_,i)=>browserJobInput({...seed,url:`https://www.zhipin.com/job_detail/SAVEDTEST${String(i).padStart(6,'0')}.html`,salary:i%2?'200-220元/天':`${5+i}-${6+i}K`,company:i<4?'重点企业':seed.company,location:i===54?'上海':'武汉市'},'2026-10-12T00:00:00Z'));
    const jobs=h.service.importJobs(inputs);h.service.noteJob(jobs[1]!.id,"重点查看 O'Reilly %_ Java");h.service.markJob(jobs[1]!.id,'INTERESTED');
    const month=h.service.listSavedJobs(savedJobQuerySchema.parse({city:'武汉',salary_period:'MONTH',salary_min:20,sort:'SALARY_DESC',limit:2}));
    assert.equal(month.items.length,2);assert.equal(month.items[0]!.salary_raw,'57-58K');assert.equal(month.total,20);
    const daily=h.service.listSavedJobs(savedJobQuerySchema.parse({salary_period:'DAY',salary_min:210,salary_max:215,limit:1,offset:25}));assert.equal(daily.total,27);assert.equal(daily.items.length,1);
    assert.equal(h.service.listSavedJobs(savedJobQuerySchema.parse({company:'重点',personal_mark:'INTERESTED'})).total,1);
    assert.equal(h.service.listSavedJobs(savedJobQuerySchema.parse({search:"O'Reilly %_"})).items[0]!.id,jobs[1]!.id);
    assert.equal(h.service.listSavedJobs(savedJobQuerySchema.parse({company:"' OR 1=1 --"})).total,0);
    assert.equal(savedJobQuerySchema.safeParse({sort:'SALARY_DESC'}).success,false);assert.equal(savedJobQuerySchema.safeParse({salary_period:'DAY',salary_min:220,salary_max:200}).success,false);
    assert.deepEqual(parseSavedSalary('每日200-220'),{period:'DAY',min:200,max:220});assert.equal(parseSavedSalary('200-220'),null);assert.equal(parseSavedSalary('220-200元/天'),null);
  }finally{await h.cleanup();}
});
test('notes, classification and successful/failing refresh survive restart without replacing old data or creating communications',async()=>{
  const h=await setup();let reopened:Store|undefined;try{
    const communications=()=>['actions','attempts','messages','tasks'].map(table=>h.store.all(table as 'actions').length);
    const before=communications();
    const first=h.service.importJobs([browserJobInput(seed,'2026-10-11T00:00:00Z')])[0]!;h.service.noteJob(first.id,'优先看交通与薪资');h.service.markJob(first.id,'CONTACTED');
    const fresh=mergeFreshDetail(seed,{...seed,salary:'7-9K',detail:{description:'新的职位职责',address:'武汉',observed_at:'2026-10-12T00:00:00Z'}},'DETAIL_DOM','2026-10-12T00:00:00Z')!;
    const updated=h.service.refreshSavedJob(first.id,fresh,'2026-10-12T00:00:00Z');assert.equal(updated.salary_raw,'7-9K');assert.equal(updated.first_seen_at,first.first_seen_at);assert.equal(updated.personal_mark,'CONTACTED');assert.equal(updated.personal_note,'优先看交通与薪资');assert.equal(updated.status,'UNVERIFIED');
    assert.equal(updated.change_check?.status,'CHANGED');assert.deepEqual(updated.change_check?.changes.find(x=>x.field==='薪资'),{field:'薪资',before:'5k-6k',after:'7-9K'});assert.equal(updated.change_history?.length,1);
    const revisions=h.store.all('job_revisions').length;
    h.service.refreshSavedJob(first.id,{...fresh,salary_detail:{...fresh.salary_detail!,observed_at:'2026-10-12T01:00:00Z'}},'2026-10-12T01:00:00Z');assert.equal(h.store.all('job_revisions').length,revisions);
    const unchanged=h.service.managedJob(h.service.get('jobs',first.id));assert.equal(unchanged.change_check?.status,'UNCHANGED');assert.equal(unchanged.change_history?.length,1);
    assert.throws(()=>h.service.refreshSavedJob(first.id,{...fresh,company:'其他企业'},'2026-10-12T02:00:00Z'));
    assert.throws(()=>h.service.refreshSavedJob(first.id,fresh,'2026-10-11T00:00:00Z'));
    h.service.recordSavedRefresh(first.id,'FAILED','网络失败，旧记录保留','2026-10-12T02:00:00Z');
    assert.equal((await desktopCommand(h.service,h.scheduler,'job.note',{id:first.id,note:'x'.repeat(2001)})).ok,false);assert.equal((await desktopCommand(h.service,h.scheduler,'saved.list',{cookies:'secret'})).ok,false);
    assert.deepEqual(communications(),before);
    h.store.close();reopened=new Store(h.store.filename);const service=new RecruitmentService(reopened,h.directory);const row=service.listSavedJobs(savedJobQuerySchema.parse({})).items[0]!;
    assert.equal(row.salary_raw,'7-9K');assert.equal(row.personal_note,'优先看交通与薪资');assert.equal(row.personal_mark,'CONTACTED');assert.equal(row.refresh?.status,'FAILED');assert.equal(row.refresh?.last_success_at,'2026-10-12T01:00:00Z');
    assert.equal(service.savedBossUrls().length,1);
    assert.equal(row.change_check?.status,'UNCHANGED');assert.equal(row.change_history?.[0]?.changes.find(x=>x.field==='薪资')?.before,'5k-6k');
  }finally{reopened?.close();await h.cleanup();}
});
test('saved refresh discards late/cancelled results, stops on repeated failures and caps strict IPC input',async()=>{
  let time=0,saves=0,records=0;const jobs=Array.from({length:5},(_,i)=>({id:String(i),job:seed}));
  const runner=new BossSavedRefresh(jobs,{now:()=>time,wait:async ms=>{time+=ms;},read:async()=>{throw new Error('网络不可用');},save:()=>{saves++;},record:()=>{records++;}});await runner.execute();assert.equal(runner.progress.failed,3);assert.equal(records,3);assert.equal(saves,0);
  const cancelled=new BossSavedRefresh(jobs,{now:()=>time,wait:async()=>{},read:async()=>{cancelled.stop();return seed;},save:()=>{saves++;},record:()=>{records++;}});await cancelled.execute();assert.equal(cancelled.progress.checked,0);assert.equal(saves,0);
  const late=new BossSavedRefresh(jobs,{now:()=>time,wait:async()=>{},read:async()=>{time+=120001;return seed;},save:()=>{saves++;},record:()=>{records++;}});await late.execute();assert.equal(late.progress.checked,0);assert.equal(saves,0);
  assert.equal(mergeFreshDetail(seed,{...seed,salary:'\uE001-\uE002K'},'DETAIL_DOM','2026-10-12T00:00:00Z'),null);assert.equal(mergeFreshDetail(seed,{...seed,location:''},'DETAIL_DOM','2026-10-12T00:00:00Z'),null);
  const id='9c4cfc60-3ec5-4e04-b650-18d0a88c9590';assert.equal(bossBrowserRequest.safeParse({operation:'saved.refresh',payload:{ids:[id,id]}}).success,false);assert.equal(bossBrowserRequest.safeParse({operation:'saved.refresh',payload:{ids:[id],send:true}}).success,false);
});
test('change history is bounded and missing detail fields cannot erase the saved baseline',async()=>{
  const h=await setup();try{
    const at='2026-10-13T00:00:00Z';
    const first=h.service.importJobs([browserJobInput({...seed,detail:{description:'Java 服务开发',address:'武汉原地址',observed_at:at}},at)])[0]!;
    const missing={...seed,education:'',experience:'',detail:{description:'',address:'',observed_at:at}};
    const same=h.service.refreshSavedJob(first.id,missing,at);
    assert.equal(same.change_check?.status,'UNCHANGED');assert.equal((same.extra.boss_detail as {description:string}).description,'Java 服务开发');
    for(let i=1;i<=25;i++)h.service.refreshSavedJob(first.id,{...seed,salary:`${i+6}-${i+7}K`},new Date(Date.parse(at)+i*1000).toISOString());
    const row=h.service.managedJob(h.service.get('jobs',first.id));assert.equal(row.change_history?.length,20);assert.equal(row.change_history?.[0]?.changes[0]?.after,'31-32K');
    h.service.recordSavedRefresh(first.id,'FAILED','网络失败',new Date(Date.parse(at)+30000).toISOString());
    assert.deepEqual(h.service.managedJob(h.service.get('jobs',first.id)).change_history,row.change_history);
    assert.equal(h.store.all('messages').length,0);assert.equal(h.store.all('actions').length,0);
  }finally{await h.cleanup();}
});
