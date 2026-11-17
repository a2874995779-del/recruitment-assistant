import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSearchConfig, searchConfigSchema, bossSearchUrl, evaluateSearchJob, searchRunSchema } from '../../packages/contracts/src/boss-search.js';
import { BossSearchRunner, SearchBlocked, type SearchPort } from '../../apps/desktop/src/main/boss-search-runner.js';
import { bossBrowserRequest, type BrowserJob } from '../../packages/contracts/src/boss-browser.js';
import { sameBossSearch } from '../../packages/contracts/src/boss-search-config.js';
import { searchEmptyFeedback,searchConditions } from '../../apps/desktop/src/renderer/search-feedback.js';

const job:BrowserJob={url:'https://www.zhipin.com/job_detail/SEARCH123456.html',title:'Java',company:'测试企业',salary:'12.5-18K·13薪',location:'武汉市·江夏区',education:'本科',experience:'应届生',tags:[]};
function harness(overrides:Partial<SearchPort>={}){
  const opened:string[]=[],saved:unknown[]=[];let clock=Date.parse('2026-10-12T00:00:00Z');
  const port:SearchPort={open:async url=>{opened.push(url);},read:async()=>[job],advance:async()=>true,wait:async ms=>{clock+=ms;},now:()=>clock,checkpoint:run=>{saved.push(structuredClone(searchRunSchema.parse(run)));},...overrides};
  return {port,opened,saved};
}
test('search identity allows tracking and encoding changes but rejects real query changes',()=>{
  const expected=bossSearchUrl('武汉','java 后端');
  assert.equal(sameBossSearch(expected+'&ka=normal#list',expected),true);
  assert.equal(sameBossSearch(expected.replace('java+','Java%20'),expected),true);
  for(const url of [bossSearchUrl('上海','java 后端'),bossSearchUrl('武汉','前端'),'https://www.zhipin.com/web/geek/jobs','https://www.zhipin.com/web/passport/zp/security.html',expected.replace('www.zhipin.com','evil.example'),expected+'&city=101280600'])assert.equal(sameBossSearch(url,expected),false);
});
test('empty search feedback distinguishes zero fetched, in progress and empty category',()=>{
  const runner=new BossSearchRunner(defaultSearchConfig,harness().port);
  assert.ok(searchEmptyFeedback(runner.run,'ALL').message.includes('尚未获得第一批'));
  runner.run.status='PARTIAL';runner.run.reason='原网页已变化';runner.run.pairs[0]!.status='BLOCKED';runner.run.pairs[0]!.reason='原网页已变化';
  const failed=searchEmptyFeedback(runner.run,'MATCH');assert.ok(failed.message.includes('尚未进入筛选'));assert.ok(failed.message.includes('原网页已变化'));assert.equal(failed.showAll,false);
  runner.run.results=[{job,observed_at:runner.run.started_at,queries:['武汉 · Java']}];
  const category=searchEmptyFeedback(runner.run,'EXCLUDED');assert.ok(category.message.includes('已读取 1 个'));assert.equal(category.showAll,true);
  assert.ok(searchConditions({...defaultSearchConfig,experience:'ALL'}).includes('不限制经验'));
});
test('search configuration bounds combinations and encodes keywords without extra parameters',()=>{
  const url=new URL(bossSearchUrl('武汉','Java & city=evil'));
  assert.equal(url.searchParams.get('query'),'Java & city=evil');assert.equal(url.searchParams.get('city'),'101200100');assert.equal([...url.searchParams].length,2);
  for(const change of [{cities:['不存在的城市']},{rounds:31},{keywords:[]},{script:'send()'},{salary_min:20,salary_max:10},{keywords:['1','2','3','4','5'],cities:['武汉','北京','上海']}])assert.equal(searchConfigSchema.safeParse({...defaultSearchConfig,...change}).success,false);
  assert.equal(bossBrowserRequest.safeParse({operation:'search.start',payload:{...defaultSearchConfig,key:'secret'}}).success,false);
});
test('search filtering preserves missing information and salary periods rather than claiming matches',()=>{
  const config={...defaultSearchConfig,salary_min:15,salary_max:20};
  assert.equal(evaluateSearchJob(job,config).status,'MATCH');
  assert.equal(evaluateSearchJob({...job,location:'上海'},config).status,'EXCLUDED');
  assert.equal(evaluateSearchJob({...job,location:''},config).status,'UNKNOWN');
  assert.equal(evaluateSearchJob({...job,experience:'3-5年'},config).status,'EXCLUDED');
  for(const salary of ['200元/天','20-30万/年','\uE001-\uE002K','18-12K'])assert.equal(evaluateSearchJob({...job,salary},config).status,'UNKNOWN');
  assert.equal(evaluateSearchJob({...job,salary:'5-10K'},config).status,'EXCLUDED');
  assert.equal(evaluateSearchJob({...job,title:'Java实习'}, {...defaultSearchConfig,experience:'INTERN'}).status,'MATCH');
});
test('Java internship requires direction and affirmative internship evidence, not source recommendations',()=>{
  const config={...defaultSearchConfig,keywords:['Java实习'],experience:'ALL' as const};
  assert.equal(evaluateSearchJob({...job,title:'Java 实习生',experience:'在校/应届'},config).status,'MATCH');
  assert.equal(evaluateSearchJob({...job,title:'Java开发工程师',experience:'3-5年'},config).status,'EXCLUDED');
  assert.equal(evaluateSearchJob({...job,title:'JavaScript实习生'},config).status,'EXCLUDED');
  assert.equal(evaluateSearchJob({...job,title:'Java开发',experience:'经验不限'},config).status,'UNKNOWN');
  const intern={...config,keywords:['Java'],experience:'INTERN' as const};
  assert.equal(evaluateSearchJob({...job,tags:['实习'],experience:'在校/应届'},intern).status,'MATCH');
  for(const title of ['Java 非实习岗位','Java 不接受实习','Java 正式岗位'])assert.equal(evaluateSearchJob({...job,title},intern).status,'EXCLUDED');
  assert.equal(evaluateSearchJob({...job,detail:{description:'正式开发，带教实习生',address:'武汉',observed_at:'2026-10-13T00:00:00Z'}},intern).status,'UNKNOWN');
  assert.equal(evaluateSearchJob({...job,tags:['实习经验优先']},intern).status,'UNKNOWN');
  assert.equal(evaluateSearchJob({...job,title:'销售实习生',company:'Java科技公司'},intern).status,'EXCLUDED');
  assert.equal(evaluateSearchJob({...job,title:'Python实习生'},{...intern,keywords:['Java实习','Python实习']}).status,'MATCH');
});
test('sequential search deduplicates URLs, records query provenance and never inherits history',async()=>{
  const h=harness();const config={...defaultSearchConfig,keywords:['Java','后端'],rounds:1};
  const runner=new BossSearchRunner(config,h.port);await runner.execute();
  assert.equal(h.opened.length,2);assert.equal(runner.run.results.length,1);assert.deepEqual(runner.run.results[0]!.queries,['武汉 · Java','武汉 · 后端']);
  assert.equal(runner.run.status,'PARTIAL');assert.ok(runner.run.finished_at);assert.ok(runner.run.reason.includes('覆盖率未知'));
  assert.equal((h.saved[0] as typeof runner.run).results.length,0);
  const next=new BossSearchRunner(config,h.port);assert.notEqual(next.run.id,runner.run.id);assert.deepEqual(next.run.results,[]);
});
test('three unchanged batches stop with a gap explanation and empty extraction is a failure',async()=>{
  const h=harness(),runner=new BossSearchRunner(defaultSearchConfig,h.port);await runner.execute();
  assert.equal(runner.run.pairs[0]!.rounds,4);assert.equal(runner.run.pairs[0]!.status,'STALLED');
  const empty=new BossSearchRunner(defaultSearchConfig,harness({read:async()=>[]}).port);await empty.execute();
  assert.equal(empty.run.pairs[0]!.status,'FAILED');assert.ok(empty.run.pairs[0]!.reason.includes('不能判定'));
});
test('verification halts pending searches and cancellation discards a late read',async()=>{
  const blocked=new BossSearchRunner({...defaultSearchConfig,keywords:['Java','后端']},harness({open:async()=>{throw new SearchBlocked('需要验证');}}).port);
  await blocked.execute();assert.deepEqual(blocked.run.pairs.map(pair=>pair.status),['BLOCKED','WAITING']);
  let runner:BossSearchRunner;
  runner=new BossSearchRunner(defaultSearchConfig,harness({read:async()=>{runner.stop();return [job];}}).port);
  await runner.execute();assert.equal(runner.run.status,'STOPPED');assert.deepEqual(runner.run.results,[]);assert.ok(runner.cancelled);
});
test('elapsed time bound leaves unscanned queries visible',async()=>{
  let time=0;
  const h=harness({now:()=>time,read:async()=>{time=600001;return [job];}});
  const runner=new BossSearchRunner({...defaultSearchConfig,keywords:['Java','后端']},h.port);await runner.execute();
  assert.equal(runner.run.pairs[0]!.status,'LIMIT');assert.equal(runner.run.pairs[1]!.status,'WAITING');
  assert.equal(runner.run.results.length,0,'late observations do not pretend to be current');
});

const step=(top:number,max=1000)=>({action:'SCROLL' as const,moved:true,at_end:top>=max,top,max,cards:15,target:'div.actual-list',reason:'滚动'});
test('unchanged cards while scrolling the middle do not stop the search before the bottom',async()=>{
  let reads=0,advances=0;const waits:boolean[]=[];
  const h=harness({read:async(_known,wait)=>{waits.push(!!wait);return ++reads>=6?[job,{...job,url:'https://www.zhipin.com/job_detail/NEWSEARCH123456.html'}]:[job];},advance:async()=>++advances<6?step(advances*150):{...step(1000),action:'END',moved:false,reason:'原网页显示没有更多'}});
  const runner=new BossSearchRunner({...defaultSearchConfig,rounds:10,salary_enrichment:false},h.port);await runner.execute();
  assert.equal(runner.run.results.length,2);assert.equal(reads,6);assert.equal(runner.run.pairs[0]!.status,'END');
  assert.equal(waits.slice(1,5).some(Boolean),false);assert.ok(runner.run.reason.includes('覆盖率未知'));
});
test('reaching the bottom waits for new cards; only explicit end is classified as end',async()=>{
  const waits:boolean[]=[];
  const h=harness({read:async(_known,wait)=>{waits.push(!!wait);return [job];},advance:async()=>step(1000)});
  const runner=new BossSearchRunner({...defaultSearchConfig,rounds:10,salary_enrichment:false},h.port);await runner.execute();
  assert.deepEqual(waits,[false,true,true,true]);assert.equal(runner.run.pairs[0]!.status,'STALLED');
});
test('explicit continuation keeps the run, dates and provenance and distinguishes new from refreshed',async()=>{
  const config={...defaultSearchConfig,rounds:1,salary_enrichment:false};
  const first=new BossSearchRunner(config,harness().port);await first.execute();
  const snapshot=structuredClone(first.run),at=first.run.results[0]!.observed_at;
  const untouched={...job,url:'https://www.zhipin.com/job_detail/UNTOUCHED123456.html'};
  first.run.results.push({job:untouched,observed_at:at,queries:['武汉 · Java']});
  let reused=false;
  const nextJob={...job,url:'https://www.zhipin.com/job_detail/NEWSEARCH123456.html'};
  const h=harness({now:()=>Date.parse(at)+60000,open:async(_url,reuse)=>{reused=!!reuse;},read:async()=>[job,nextJob]});
  const continued=new BossSearchRunner(config,h.port,first.run);await continued.execute();
  assert.equal(continued.run.id,first.run.id);assert.equal(continued.run.started_at,first.run.started_at);assert.ok(reused);
  assert.deepEqual(continued.run.segment,{number:2,started_at:continued.run.results[0]!.observed_at,previous_total:2,added:1,refreshed:1});
  assert.equal(continued.run.results.find(item=>item.job.url===untouched.url)!.observed_at,at);
  assert.equal(first.run.results[0]!.observed_at,snapshot.results[0]!.observed_at,'seed is not mutated');
  assert.throws(()=>new BossSearchRunner({...config,keywords:['不同条件']},h.port,first.run));
  assert.throws(()=>new BossSearchRunner(config,h.port,{...first.run,status:'RUNNING'}));
});
test('stopped continuation discards a late read and retains previous jobs and dates',async()=>{
  const config={...defaultSearchConfig,rounds:1,salary_enrichment:false},first=new BossSearchRunner(config,harness().port);await first.execute();
  let next:BossSearchRunner;
  next=new BossSearchRunner(config,harness({read:async()=>{next.stop();return [{...job,salary:'999K'}];}}).port,first.run);await next.execute();
  assert.deepEqual(next.run.results,first.run.results);assert.equal(next.run.segment?.added,0);assert.equal(next.run.status,'STOPPED');
});
test('continuation merges overlapping queries and leaves blocked queries visible',async()=>{
  const config={...defaultSearchConfig,keywords:['Java','后端'],rounds:1,salary_enrichment:false},first=new BossSearchRunner(config,harness().port);await first.execute();
  const h=harness({open:async()=>{throw new SearchBlocked('需要安全验证');}});
  const next=new BossSearchRunner(config,h.port,first.run);await next.execute();
  assert.equal(next.run.results.length,1);assert.deepEqual(next.run.results[0]!.queries,['武汉 · Java','武汉 · 后端']);
  assert.equal(next.run.pairs[1]!.status,'BLOCKED');assert.equal(next.run.pairs[0]!.status,'WAITING');
});
test('normalized duplicate keywords and continuation payload are bounded and cannot change conditions',()=>{
  assert.deepEqual(searchConfigSchema.parse({...defaultSearchConfig,keywords:[' Java ','java','Ｊａｖａ','Java开发']}).keywords,['Java','Java开发']);
  const run_id='12345678-1234-4123-8123-123456789012';
  assert.equal(bossBrowserRequest.safeParse({operation:'search.continue',payload:{run_id}}).success,true);
  assert.equal(bossBrowserRequest.safeParse({operation:'search.continue',payload:{run_id,keywords:['任意改条件']}}).success,false);
});
