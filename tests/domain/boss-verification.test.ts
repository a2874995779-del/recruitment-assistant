import test from 'node:test';
import assert from 'node:assert/strict';
import { BossSearchRunner, SearchBlocked } from '../../apps/desktop/src/main/boss-search-runner.js';
import { BossVerificationRunner } from '../../apps/desktop/src/main/boss-verification-runner.js';
import { mergeVerifiedDetail } from '../../apps/desktop/src/main/boss-salary-detail.js';
import { defaultSearchConfig, evaluateSearchJob, searchConfigSchema } from '../../packages/contracts/src/boss-search.js';
import { bossBrowserRequest } from '../../packages/contracts/src/boss-browser.js';

const job={url:'https://www.zhipin.com/job_detail/VERIFY123456.html',title:'Java实习',company:'验证企业',salary:'\uE001K',location:'',education:'',experience:'',tags:[]};
async function seed(){const runner=new BossSearchRunner({...defaultSearchConfig,rounds:1,salary_enrichment:false},{now:()=>0,open:async()=>{},read:async()=>[job],advance:async()=>false,wait:async()=>{},checkpoint:()=>{}});await runner.execute();return runner.run;}
test('day and month filters compare only their original units and range endpoints',()=>{
  const daily={...defaultSearchConfig,experience:'ALL' as const,salary_period:'DAY' as const,salary_min:200,salary_max:220};
  for(const salary of ['200-220元/天','每日200-220','日结200-220元','210-230元/天'])assert.equal(evaluateSearchJob({...job,location:'武汉',salary},daily).status,'MATCH');
  assert.equal(evaluateSearchJob({...job,location:'武汉',salary:'80-150元/天'},daily).status,'EXCLUDED');
  for(const salary of ['5K-6K','20-30万/年','200-220','220-200元/天',job.salary])assert.equal(evaluateSearchJob({...job,location:'武汉',salary},daily).status,'UNKNOWN');
  assert.equal(searchConfigSchema.parse({...defaultSearchConfig,salary_period:'DAY',salary_max:2000}).salary_max,2000);
  assert.equal(searchConfigSchema.safeParse({...defaultSearchConfig,salary_max:2000}).success,false);
});
test('verified details preserve good fields and refuse another job or company',()=>{
  const input={...job,salary:'5K-6K',location:'武汉'};
  const detail={...job,salary:'200-220元/天',location:'上海',education:'本科',experience:'应届生'};
  const merged=mergeVerifiedDetail(input,detail,'DETAIL_DOM',new Date(1).toISOString())!;
  assert.equal(merged.salary,input.salary);assert.equal(merged.location,input.location);assert.equal(merged.education,'本科');
  assert.equal(mergeVerifiedDetail(input,{...detail,company:'其他企业'},'DETAIL_DOM',new Date(1).toISOString()),null);
});
test('repair updates only missing jobs and keeps scan dates, identity, rounds and seed immutable',async()=>{
  const previous=await seed(),before=structuredClone(previous);let time=1000,reads=0;
  const runner=new BossVerificationRunner(previous,{now:()=>time,wait:async ms=>{time+=ms;},checkpoint:()=>{},savedUrls:()=>[],read:async input=>{reads++;return mergeVerifiedDetail(input,{...input,salary:'200-220元/天',location:'武汉',education:'本科',experience:'应届生'},'DETAIL_DOM',new Date(time).toISOString());}});
  await runner.execute();assert.equal(reads,1);assert.equal(runner.run.id,previous.id);assert.equal(runner.run.results[0]!.observed_at,previous.results[0]!.observed_at);
  assert.deepEqual(runner.run.pairs,previous.pairs);assert.deepEqual(previous,before);assert.equal(runner.run.detail_progress!.updated,1);assert.equal(runner.run.results[0]!.verification?.status,'DONE');
});
test('repair skips saved jobs; stop and security discard late mutations and retain partial results',async()=>{
  const previous=await seed();let reads=0;
  const skipped=new BossVerificationRunner(previous,{now:()=>1000,wait:async()=>{},checkpoint:()=>{},savedUrls:()=>[job.url],read:async()=>{reads++;return job;}});await skipped.execute();assert.equal(reads,0);
  let stopped:BossVerificationRunner;
  stopped=new BossVerificationRunner(previous,{now:()=>1000,wait:async()=>{},checkpoint:()=>{},savedUrls:()=>[],read:async()=>{stopped.stop();return {...job,salary:'999K'};}});await stopped.execute();assert.deepEqual(stopped.run.results,previous.results);
  const blocked=new BossVerificationRunner(previous,{now:()=>1000,wait:async()=>{},checkpoint:()=>{},savedUrls:()=>[],read:async()=>{throw new SearchBlocked('需要验证');}});await blocked.execute();assert.equal(blocked.run.status,'STOPPED');assert.equal(blocked.run.results[0]!.verification?.status,'BLOCKED');
});
test('repair cap leaves unchecked jobs available and retries them before failures',async()=>{
  const previous=await seed();previous.results=Array.from({length:52},(_,i)=>({...previous.results[0]!,job:{...job,url:`https://www.zhipin.com/job_detail/VERIFYJOB${String(i).padStart(8,'0')}.html`}}));
  const port={now:()=>1000,wait:async()=>{},checkpoint:()=>{},savedUrls:()=>[],read:async()=>null};
  const first=new BossVerificationRunner(previous,port);await first.execute();assert.equal(first.run.detail_progress?.checked,50);assert.equal(first.run.results.filter(item=>!item.verification).length,2);
  const order:string[]=[];const next=new BossVerificationRunner(first.run,{...port,read:async input=>{order.push(input.url);return null;}});await next.execute();assert.deepEqual(order.slice(0,2),previous.results.slice(50).map(item=>item.job.url));
});
test('saved links never enter new search results or salary work and an explicit override can rescan',async()=>{
  let reads=0,salaries=0;const port={now:()=>1000,open:async()=>{},read:async()=>{reads++;return [job];},advance:async()=>false,wait:async()=>{},checkpoint:()=>{},savedUrls:()=>[job.url],salary:async()=>{salaries++;return null;}};
  const runner=new BossSearchRunner(defaultSearchConfig,port);await runner.execute();assert.equal(runner.run.results.length,0);assert.equal(salaries,0);assert.equal(reads,1);
  const override=new BossSearchRunner({...defaultSearchConfig,skip_saved:false},port);await override.execute();assert.equal(override.run.results.length,1);assert.equal(salaries,1);
  assert.equal(bossBrowserRequest.safeParse({operation:'search.verify',payload:{run_id:runner.run.id,script:'send()'}}).success,false);
});
