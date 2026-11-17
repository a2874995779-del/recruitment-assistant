import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSalaryDetail, needsSalary, parseDetailDom } from '../../apps/desktop/src/main/boss-salary-detail.js';
import { BossSearchRunner, SearchBlocked, type SearchPort } from '../../apps/desktop/src/main/boss-search-runner.js';
import { browserJobInput } from '../../apps/desktop/src/main/boss-reader.js';
import { defaultSearchConfig, evaluateSearchJob } from '../../packages/contracts/src/boss-search.js';
import type { BrowserJob } from '../../packages/contracts/src/boss-browser.js';

const at='2026-10-12T00:00:00Z';
const job:BrowserJob={url:'https://www.zhipin.com/job_detail/SALARY123456.html',title:'Java开发',company:'测试企业',salary:'\uE001-\uE002K',location:'武汉',education:'本科',experience:'经验不限',tags:[]};
const detail={...job,salary:'5k-6k'};
function harness(salary:SearchPort['salary'], jobs=[job]){
  let time=0;const saves:unknown[]=[];
  const port:SearchPort={open:async()=>{},read:async()=>jobs,advance:async()=>false,wait:async ms=>{time+=ms;},now:()=>time,checkpoint:run=>saves.push(structuredClone(run)),salary};
  return {port,saves,setTime:(value:number)=>{time=value;}};
}
test('detail salary requires matching identity and readable text, preserving source and original',()=>{
  const updated=mergeSalaryDetail(job,detail,'DETAIL_DOM',at)!;
  assert.equal(updated.salary,'5k-6k');assert.equal(updated.salary_detail?.original,job.salary);
  const saved=browserJobInput(updated,at);assert.equal(saved.extra.salary_source,'BROWSER_DETAIL_DOM');assert.equal(saved.extra.salary_original,job.salary);
  for(const changed of [{...detail,url:'https://www.zhipin.com/job_detail/OTHER123456.html'},{...detail,title:'别的岗位'},{...detail,company:'其他企业'},{...detail,salary:job.salary},{...detail,salary:''}])assert.equal(mergeSalaryDetail(job,changed,'DETAIL_DOM',at),null);
  assert.equal(mergeSalaryDetail(job,detail,'DETAIL_RESPONSE',at),null);
  const response={...detail,detail_response:{salary:detail.salary,location:detail.location,education:detail.education,experience:detail.experience,observed_at:at}};
  assert.equal(mergeSalaryDetail(job,response,'DETAIL_RESPONSE',at)?.salary_detail?.source,'DETAIL_RESPONSE');
  assert.equal(parseDetailDom({...detail,description:'开发服务',address:'武汉',script:'send()'},at),null);
});
test('monthly K on both endpoints is comparable; daily salaries preserve units and never become monthly',()=>{
  const config={...defaultSearchConfig,experience:'ALL' as const,salary_min:5,salary_max:6};
  for(const salary of ['5k-6k','5K–6K','5-6K','5.5K-6.5K·13薪'])assert.equal(evaluateSearchJob({...job,salary},config).status,'MATCH');
  for(const salary of ['200-220元/天','每日200-220','日结200-220元']){
    const enriched=mergeSalaryDetail(job,{...detail,salary},'DETAIL_DOM',at)!;
    assert.equal(enriched.salary,salary);assert.equal(evaluateSearchJob(enriched,config).status,'UNKNOWN');
  }
  assert.equal(needsSalary({...job,salary:'5k-6k'}),false);assert.equal(needsSalary({...job,salary:''}),true);
});
test('search publishes original jobs first, then updates salary without mixing runs or sources',async()=>{
  const h=harness(async input=>mergeSalaryDetail(input,detail,'DETAIL_DOM',at));
  const runner=new BossSearchRunner({...defaultSearchConfig,rounds:1},h.port);await runner.execute();
  assert.equal(runner.run.results[0]?.job.salary,'5k-6k');assert.equal(runner.run.salary_progress?.updated,1);
  assert.equal(runner.run.salary_progress?.running,false);
  assert.ok(h.saves.some(value=>(value as typeof runner.run).results[0]?.job.salary===job.salary));
  const disabled=new BossSearchRunner({...defaultSearchConfig,rounds:1,salary_enrichment:false},h.port);await disabled.execute();
  assert.equal(disabled.run.results[0]?.job.salary,job.salary);assert.equal(disabled.run.salary_progress,undefined);
});
test('salary navigation block and cancellation retain the original job and discard late results',async()=>{
  const blocked=new BossSearchRunner({...defaultSearchConfig,rounds:1},harness(async()=>{throw new SearchBlocked('详情需要安全验证');}).port);
  await blocked.execute();assert.equal(blocked.run.status,'STOPPED');assert.equal(blocked.run.results[0]?.job.salary,job.salary);assert.equal(blocked.run.salary_progress?.failed,1);
  let stopped:BossSearchRunner;
  stopped=new BossSearchRunner({...defaultSearchConfig,rounds:1},harness(async input=>{stopped.stop();return mergeSalaryDetail(input,detail,'DETAIL_DOM',at);}).port);
  await stopped.execute();assert.equal(stopped.run.salary_progress?.updated,0);assert.equal(stopped.run.results[0]?.job.salary,job.salary);
});
test('salary queue caps attempts, rejects expired results and stops repeated transport failures',async()=>{
  const jobs=Array.from({length:60},(_,i)=>({...job,url:`https://www.zhipin.com/job_detail/SALARY${String(i).padStart(8,'0')}.html`}));
  const h=harness(async input=>mergeSalaryDetail(input,{...input,salary:'5K-6K'},'DETAIL_DOM',at),jobs);
  const capped=new BossSearchRunner({...defaultSearchConfig,rounds:1},h.port);await capped.execute();
  assert.equal(capped.run.salary_progress?.total,60);assert.equal(capped.run.salary_progress?.checked,50);assert.equal(capped.run.salary_progress?.updated,50);
  const expired=harness(async input=>{expired.setTime(120001);return mergeSalaryDetail(input,detail,'DETAIL_DOM',at);});
  const late=new BossSearchRunner({...defaultSearchConfig,rounds:1},expired.port);await late.execute();assert.equal(late.run.results[0]?.job.salary,job.salary);
  const failures=new BossSearchRunner({...defaultSearchConfig,rounds:1},harness(async()=>{throw new Error('timeout');},jobs).port);await failures.execute();
  assert.equal(failures.run.salary_progress?.checked,3);assert.equal(failures.run.results.length,60);
});
