import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../helpers.js';
import { Store } from '../../packages/persistence/src/database.js';
import { RecruitmentService } from '../../packages/application/src/service.js';
import { desktopCommand } from '../../packages/application/src/desktop-commands.js';
import { browserJobInput } from '../../apps/desktop/src/main/boss-reader.js';

const observation = {url:'https://www.zhipin.com/job_detail/LOCALTEST12345.html',title:'本地测试开发',company:'测试企业',salary:'7-12K',location:'武汉',education:'本科',experience:'经验不限',tags:['本科']};
test('detail persists through later list saves and observation-only updates create no revision',async()=>{
  const h=await setup();
  try {
    const detail={description:'岗位职责：Java SQL',address:'武汉市',observed_at:'2026-10-10T01:00:00Z'};
    const first=h.service.importJobs([browserJobInput({...observation,detail},detail.observed_at)])[0]!;
    const revisions=h.store.all('job_revisions').length;
    const next=h.service.importJobs([browserJobInput({...observation,detail:{...detail,observed_at:'2026-10-11T01:00:00Z'}},'2026-10-11T01:00:00Z')])[0]!;
    assert.equal(next.id,first.id);assert.equal(h.store.all('job_revisions').length,revisions);
    const list=h.service.importJobs([browserJobInput(observation,'2026-10-11T02:00:00Z')])[0]!;
    assert.equal(list.description,detail.description);assert.equal(h.store.all('job_revisions').length,revisions);
    const stale=h.service.importJobs([browserJobInput({...observation,detail:{...detail,description:'过期描述'}},detail.observed_at)])[0]!;
    assert.equal(stale.description,detail.description);assert.equal(h.store.all('job_revisions').length,revisions);
    const prefs={enabled:true,title:'Java',city:'武汉',skills:'SQL',exclude:'销售'};
    assert.equal((await desktopCommand(h.service,h.scheduler,'matching.save',prefs)).ok,true);
    assert.deepEqual(h.service.getMatchingPreferences(),prefs);
    assert.equal((await desktopCommand(h.service,h.scheduler,'matching.save',{...prefs,send:true})).ok,false);
    assert.equal((await desktopCommand(h.service,h.scheduler,'matching.get',{token:'secret'})).ok,false);
  } finally {await h.cleanup();}
});
test('repeated BOSS observations keep ID, mark and first seen without spurious content revisions', async()=>{
  const h=await setup();
  try {
    const before=['actions','attempts','messages','tasks'].map(t=>h.store.all(t as 'actions').length);
    const first=h.service.importJobs([browserJobInput(observation,'2026-10-10T00:00:00Z')])[0]!;
    h.service.markJob(first.id,'CONTACTED');
    const revisions=h.store.all('job_revisions').length;
    const second=h.service.importJobs([browserJobInput(observation,'2026-10-11T00:00:00Z')])[0]!;
    assert.equal(first.id,second.id);assert.equal(first.first_seen_at,second.first_seen_at);
    assert.equal(h.service.jobMark(first.id),'CONTACTED');
    assert.equal(h.store.all('job_revisions').length,revisions);
    h.service.importJobs([browserJobInput({...observation,title:'已更新的开发岗位'},'2026-10-11T01:00:00Z')]);
    assert.equal(h.store.all('job_revisions').length,revisions+1);
    assert.equal(h.service.jobMark(first.id),'CONTACTED');
    assert.deepEqual(['actions','attempts','messages','tasks'].map(t=>h.store.all(t as 'actions').length),before);
    assert.equal(h.service.listJobs({platform:'boss',mode:'IMPORT'}).total,1);
  } finally {await h.cleanup();}
});
test('personal mark filters count before pagination and preserve recruitment status',async()=>{
  const h=await setup();
  try {
    const jobs=h.service.importJobs([browserJobInput(observation,'2026-10-11T00:00:00Z'),browserJobInput({...observation,url:'https://www.zhipin.com/job_detail/LOCALTEST67890.html'},'2026-10-11T00:00:00Z')]);
    h.service.markJob(jobs[0]!.id,'INTERESTED');
    const page=h.service.listJobs({mode:'IMPORT',platform:'boss',personal_mark:'INTERESTED',limit:1});
    assert.equal(page.total,1);assert.equal(page.items[0]!.id,jobs[0]!.id);assert.equal(page.items[0]!.status,'UNVERIFIED');
    assert.equal(h.service.listJobs({mode:'IMPORT',personal_mark:'CONSIDERING'}).total,1);
    assert.equal(h.service.listJobs({mode:'IMPORT',personal_mark:'REJECTED'}).total,0);
    assert.throws(()=>h.service.markJob(h.job.id,'INTERESTED'));
    assert.equal((await desktopCommand(h.service,h.scheduler,'job.mark',{id:jobs[0]!.id,mark:'APPLY'})).ok,false);
    assert.equal((await desktopCommand(h.service,h.scheduler,'job.mark',{id:jobs[0]!.id,mark:'REJECTED',send:true})).ok,false);
  } finally {await h.cleanup();}
});
test('filter preferences and manual marks survive reopening database without altering scheduler settings',async()=>{
  const h=await setup(); let reopened: Store | undefined;
  try {
    const first=h.service.importJobs([browserJobInput(observation,'2026-10-11T00:00:00Z')])[0]!;
    h.service.markJob(first.id,'REJECTED');
    const settings=h.service.getSettings();
    const filter={keyword:'Java 双休',city:'武汉',education:'本科',exclude:'销售'};
    assert.equal((await desktopCommand(h.service,h.scheduler,'browser-filter.save',filter)).ok,true);
    assert.deepEqual(h.service.getSettings(),settings);
    assert.equal((await desktopCommand(h.service,h.scheduler,'browser-filter.save',{...filter,cookies:'secret'})).ok,false);
    h.store.close();reopened=new Store(h.store.filename);
    const service=new RecruitmentService(reopened,h.directory);
    assert.deepEqual(service.getBrowserFilter(),filter);
    assert.equal(service.listJobs({mode:'IMPORT'}).items[0]!.personal_mark,'REJECTED');
    service.saveBrowserFilter({keyword:'',city:'',education:'',exclude:''});
    assert.equal(service.getBrowserFilter().keyword,'');
  } finally {reopened?.close();await h.cleanup();}
});
test('new observations never reuse an old OCR digit map because website fonts can rotate',async()=>{
  const h=await setup();
  try {
    const raw='\uE011\uE015-\uE012\uE015K';
    const input=browserJobInput({...observation,salary:raw,salary_ocr:{candidate:'15-25K',confidence:89,preview:'data:image/png;base64,AA==',confirmed:true}},'2026-10-11T00:00:00Z');
    const first=h.service.importJobs([input])[0]!;
    const repeated=h.service.importJobs([browserJobInput({...observation,salary:raw},'2026-10-11T01:00:00Z')])[0]!;
    assert.equal(repeated.id,first.id);assert.equal(repeated.salary_raw,raw);assert.equal(repeated.extra.salary_source,undefined);
    const changed=h.service.importJobs([browserJobInput({...observation,salary:'\uE013-\uE014K'},'2026-10-11T02:00:00Z')])[0]!;
    assert.equal(changed.extra.salary_source,undefined);assert.equal(changed.salary_raw,'\uE013-\uE014K');
  } finally {await h.cleanup();}
});
