import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from '../helpers.js';
import { defaultSearchConfig } from '../../packages/contracts/src/boss-search.js';
import { BossSearchRunner } from '../../apps/desktop/src/main/boss-search-runner.js';
import { browserJobInput } from '../../apps/desktop/src/main/boss-reader.js';
import { Store } from '../../packages/persistence/src/database.js';
import { RecruitmentService } from '../../packages/application/src/service.js';
import { desktopCommand } from '../../packages/application/src/desktop-commands.js';

test('search settings and interrupted run restore independently of saved jobs without any communication',async()=>{
  const h=await setup();
  try {
    assert.deepEqual(h.service.getBossSearchConfig(),defaultSearchConfig);
    const config={...defaultSearchConfig,keywords:['后端','Java'],salary_min:8};h.service.saveBossSearchConfig(config);
    assert.deepEqual(h.service.getBossSearchConfig(),config);
    const jobCount=h.store.all('jobs').length,tasks=h.store.all('tasks').length;
    const runner=new BossSearchRunner(config,{now:Date.now,open:async()=>{},read:async()=>[],advance:async()=>false,wait:async()=>{},checkpoint:run=>h.service.saveBossSearchRun(run)});
    h.service.saveBossSearchRun(runner.run);
    assert.equal(h.service.getBossSearchRun()?.status,'INTERRUPTED');
    await runner.execute();assert.equal(h.service.getBossSearchRun()?.status,'PARTIAL');
    assert.equal(h.store.all('jobs').length,jobCount);assert.equal(h.store.all('tasks').length,tasks);
    for(const table of ['messages','attempts','actions'] as const)assert.equal(h.store.all(table).length,0);
    assert.throws(()=>h.service.saveBossSearchRun({...runner.run,results:[{job:{url:'file:///secret',title:'test',company:'test',salary:'',location:'',education:'',experience:'',tags:[]},observed_at:new Date().toISOString(),queries:[]}]}));
  }finally{await h.cleanup();}
});

test('saved BOSS URLs survive database reopen, exclude mock jobs and persist daily/skip preferences',async()=>{
  const h=await setup();
  try{
    const job={url:'https://www.zhipin.com/job_detail/SAVEDPERSIST123456.html',title:'Java',company:'测试企业',salary:'200-220元/天',location:'武汉',education:'本科',experience:'应届生',tags:[]};
    h.service.importJobs([browserJobInput(job,new Date().toISOString())]);
    h.service.saveBossSearchConfig({...defaultSearchConfig,salary_period:'DAY',salary_min:200,salary_max:220,skip_saved:true});
    const reopened=new Store(h.store.filename);
    try{
      const service=new RecruitmentService(reopened,h.directory);
      assert.deepEqual(service.savedBossUrls(),[job.url]);assert.equal(service.getBossSearchConfig().salary_period,'DAY');assert.equal(service.getBossSearchConfig().skip_saved,true);
      const result=await desktopCommand(service,h.scheduler,'search-saved.get');assert.ok(result.ok);if(result.ok)assert.deepEqual(result.data,[job.url]);
      const count=reopened.all('jobs').length;service.importJobs([browserJobInput(job,new Date().toISOString())]);assert.equal(reopened.all('jobs').length,count);
      for(const table of ['messages','attempts','actions'] as const)assert.equal(reopened.all(table).length,0);
    }finally{reopened.close();}
  }finally{await h.cleanup();}
});

test('explicit continuation survives checkpoints without refreshing untouched history or creating communications',async()=>{
  const h=await setup();
  try{
    const taskCount=h.store.all('tasks').length;
    const config={...defaultSearchConfig,rounds:1,salary_enrichment:false},at='2026-10-12T00:00:00.000Z';
    const job={url:'https://www.zhipin.com/job_detail/PERSIST123456.html',title:'Java',company:'测试企业',salary:'5K-6K',location:'武汉',education:'本科',experience:'应届生',tags:[]};
    const first=new BossSearchRunner(config,{now:()=>Date.parse(at),open:async()=>{},read:async()=>[job],advance:async()=>false,wait:async()=>{},checkpoint:run=>h.service.saveBossSearchRun(run)});await first.execute();
    const previous=h.service.getBossSearchRun()!;
    const next=new BossSearchRunner(config,{now:()=>Date.parse(at)+60000,open:async()=>{},read:async()=>[{...job,url:'https://www.zhipin.com/job_detail/PERSISTNEW123456.html'}],advance:async()=>false,wait:async()=>{},checkpoint:run=>h.service.saveBossSearchRun(run)},previous);
    h.service.saveBossSearchRun(next.run);assert.equal(h.service.getBossSearchRun()!.status,'INTERRUPTED');
    await next.execute();
    const stored=h.service.getBossSearchRun()!;assert.equal(stored.id,previous.id);assert.equal(stored.results.length,2);assert.equal(stored.results[0]!.observed_at,at);assert.equal(stored.segment!.added,1);assert.equal(stored.segment!.refreshed,0);
    for(const table of ['messages','attempts','actions'] as const)assert.equal(h.store.all(table).length,0);
    assert.equal(h.store.all('tasks').length,taskCount);
  }finally{await h.cleanup();}
});
