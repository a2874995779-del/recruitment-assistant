import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../helpers.js';
import { Store } from '../../packages/persistence/src/database.js';
import { RecruitmentService } from '../../packages/application/src/service.js';
import { desktopCommand } from '../../packages/application/src/desktop-commands.js';
import { defaultSearchConfig, searchCriteriaKey } from '../../packages/contracts/src/boss-search.js';
import { BossSearchRunner } from '../../apps/desktop/src/main/boss-search-runner.js';
import { browserJobInput } from '../../apps/desktop/src/main/boss-reader.js';

const job={url:'https://www.zhipin.com/job_detail/INCREMENTAL123456.html',title:'Java开发',company:'测试企业',salary:'5k-6k',location:'武汉',education:'本科',experience:'应届生',tags:[]};
const config={...defaultSearchConfig,rounds:1,salary_enrichment:false};
test('incremental processing is durable, criteria scoped, and pending fields remain eligible',async()=>{
  const h=await setup();
  try{
    let clock=Date.parse('2026-10-12T00:00:00Z');
    const scan=async(c=config,jobs=[job])=>{
      const runner=new BossSearchRunner(c,{now:()=>clock,open:async()=>{},read:async()=>jobs,advance:async()=>false,wait:async()=>{},checkpoint:run=>h.service.saveBossSearchRun(run),processedUrls:()=>h.service.processedBossUrls(c),seenJobs:()=>h.service.seenBossJobs()});
      await runner.execute();return runner.run;
    };
    const first=await scan();assert.equal(first.results[0]!.discovery,'NEW');assert.equal(h.service.processedBossUrls(config).length,1);
    clock+=60000;const second=await scan();assert.equal(second.results.length,0);assert.equal(second.skipped_processed,1);
    const changed={...config,salary_min:10};const third=await scan(changed);assert.equal(third.results.length,1);assert.equal(third.results[0]!.discovery,'SEEN');assert.equal(third.results[0]!.first_read_at,first.started_at);
    const missing={...job,url:job.url.replace('INCREMENTAL','PENDING'),salary:'\uE001K'};const pending=await scan(config,[missing]);assert.equal(pending.results.length,1);assert.ok(!h.service.processedBossUrls(config).includes(missing.url));
    const retry=await scan(config,[missing]);assert.equal(retry.results[0]!.discovery,'SEEN');
    const fresh=await scan({...config,skip_processed:false},[{...job,salary:'8-9K'}]);assert.equal(fresh.results[0]!.job.salary,'8-9K');assert.equal(fresh.results[0]!.first_read_at,first.started_at);
    assert.equal(searchCriteriaKey(config),searchCriteriaKey({...config,keywords:[' java '],rounds:30,skip_processed:false}));
    const reopened=new Store(h.store.filename);
    try{const service=new RecruitmentService(reopened,h.directory);assert.equal(service.processedBossUrls(config).length,1);assert.equal(service.seenBossJobs().length,2);}finally{reopened.close();}
    for(const table of ['messages','actions','attempts'] as const)assert.equal(h.store.all(table).length,0);
  }finally{await h.cleanup();}
});

test('named search presets validate limits, persist and never start a task',async()=>{
  const h=await setup();
  try{
    const tasks=h.store.all('tasks').length;
    const result=await desktopCommand(h.service,h.scheduler,'search-presets.save',{name:'武汉 Java 应届',config});assert.ok(result.ok);
    const first=h.service.listSearchPresets()[0]!;assert.equal(first.name,'武汉 Java 应届');
    h.service.saveSearchPreset({id:first.id,name:'日薪岗位',config:{...config,salary_period:'DAY',salary_min:200}});
    assert.equal(h.service.listSearchPresets().length,1);
    assert.throws(()=>h.service.saveSearchPreset({name:' ',config}));
    assert.throws(()=>h.service.saveSearchPreset({name:'bad',config:{...config,script:'send()'}}));
    for(let i=1;i<20;i++)h.service.saveSearchPreset({name:`条件${i}`,config});
    assert.throws(()=>h.service.saveSearchPreset({name:'超限',config}));
    const reopened=new Store(h.store.filename);
    try{const service=new RecruitmentService(reopened,h.directory);assert.equal(service.listSearchPresets().length,20);assert.equal(service.listSearchPresets().find(value=>value.id===first.id)!.config.salary_period,'DAY');}finally{reopened.close();}
    const removed=await desktopCommand(h.service,h.scheduler,'search-presets.delete',{id:first.id});assert.ok(removed.ok);assert.equal(h.service.listSearchPresets().length,19);
    const invalid=await desktopCommand(h.service,h.scheduler,'search-presets.delete',{id:first.id,url:job.url});assert.equal(invalid.ok,false);
    assert.equal(h.store.all('tasks').length,tasks);for(const table of ['messages','actions','attempts'] as const)assert.equal(h.store.all(table).length,0);
  }finally{await h.cleanup();}
});

test('legacy saved observations seed discovery history and cancelled results never enter it',async()=>{
  const h=await setup();
  try{
    const at='2026-10-12T00:00:00.000Z';h.service.importJobs([browserJobInput(job,at)]);const saved=h.service.savedBossUrls();h.service.prepareSearchHistory();
    assert.equal(h.service.seenBossJobs()[0]!.first_read_at,at);assert.equal(h.service.processedBossUrls(config).length,0);assert.deepEqual(h.service.savedBossUrls(),saved);
    let runner:BossSearchRunner;
    runner=new BossSearchRunner(config,{now:()=>Date.parse(at)+60000,open:async()=>{},read:async()=>{runner.stop();return [{...job,url:job.url.replace('INCREMENTAL','CANCELLED')}];},advance:async()=>false,wait:async()=>{},checkpoint:run=>h.service.saveBossSearchRun(run)});
    await runner.execute();assert.equal(h.service.seenBossJobs().length,1);assert.equal(runner.run.results.length,0);
    const success=new BossSearchRunner(config,{now:()=>Date.parse(at)+120000,open:async()=>{},read:async()=>[job],advance:async()=>false,wait:async()=>{},checkpoint:run=>h.service.saveBossSearchRun(run)});await success.execute();assert.equal(h.service.processedBossUrls(config).length,1);
    const failed=new BossSearchRunner({...config,skip_processed:false},{now:()=>Date.parse(at)+180000,open:async()=>{},read:async()=>[{...job,salary:''}],advance:async()=>false,wait:async()=>{},checkpoint:run=>h.service.saveBossSearchRun(run)});await failed.execute();assert.equal(h.service.processedBossUrls(config).length,0,'new incomplete observation invalidates old completed screening');
    assert.deepEqual(h.service.savedBossUrls(),saved);assert.equal(h.service.listJobs({mode:'IMPORT',platform:'boss'}).items[0]!.salary_raw,'5k-6k','history tracking never overwrites saved job');
  }finally{await h.cleanup();}
});
