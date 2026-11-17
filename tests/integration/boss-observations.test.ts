import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from '../helpers.js';
import { browserJobInput } from '../../apps/desktop/src/main/boss-reader.js';
import { parseBossDetailResponse } from '../../apps/desktop/src/main/boss-response.js';
import { defaultSearchConfig } from '../../packages/contracts/src/boss-search.js';

test('salary enrichment preference persists and legacy search configuration receives the default',async()=>{
  const h=await setup();
  try {
    const {salary_enrichment,...legacy}=defaultSearchConfig;
    h.store.put('settings',{id:'boss-search-config',...legacy});
    assert.equal(h.service.getBossSearchConfig().salary_enrichment,true);
    h.service.saveBossSearchConfig({...defaultSearchConfig,salary_enrichment:false});
    assert.equal(h.service.getBossSearchConfig().salary_enrichment,false);
  }finally{await h.cleanup();}
});

test('detail response evidence persists and observation time alone creates no job revision',async()=>{
  const h=await setup();
  try {
    const body=JSON.stringify({code:0,zpData:{jobInfo:{encryptId:'RESPONSE123456',jobName:'Java 测试',salaryDesc:'12.5-18K·13薪',locationName:'武汉',degreeName:'本科'},brandComInfo:{brandName:'测试企业'}}});
    const first=parseBossDetailResponse(body,'2026-10-11T00:00:00.000Z')!;
    const saved=h.service.importJobs([browserJobInput(first,first.detail_response!.observed_at)])[0]!;
    const count=h.store.all('job_revisions').length;
    const next=parseBossDetailResponse(body,'2026-10-11T00:01:00.000Z')!;
    const again=h.service.importJobs([browserJobInput(next,next.detail_response!.observed_at)])[0]!;
    assert.equal(saved.id,again.id);assert.equal(again.salary_raw,'12.5-18K·13薪');assert.equal(again.extra.salary_source,'BROWSER_DETAIL_RESPONSE');
    assert.equal(h.store.all('job_revisions').length,count);assert.equal(h.store.all('messages').length,0);
    const changed=parseBossDetailResponse(body.replace('12.5-18K','13-20K'),'2026-10-11T00:02:00.000Z')!;
    h.service.importJobs([browserJobInput(changed,changed.detail_response!.observed_at)]);
    assert.equal(h.store.all('job_revisions').length,count+1);
    const stale=h.service.importJobs([browserJobInput(first,first.detail_response!.observed_at)])[0]!;
    assert.equal(stale.salary_raw,'13-20K·13薪');assert.equal(h.store.all('job_revisions').length,count+1);
  }finally{await h.cleanup();}
});

test('saved BOSS observations dedupe without creating communication tasks, and salary periods stay distinct', async () => {
  const h = await setup();
  try {
    const raw = JSON.parse(readFileSync(new URL('../../config/templates/boss-readonly-observations.json', import.meta.url), 'utf8'));
    const beforeTasks = h.store.all('tasks').length;
    const first = h.service.importJobs(raw);
    const second = h.service.importJobs(raw);
    assert.deepEqual(second.map(job => job.id), first.map(job => job.id));
    assert.ok(second.every(job => job.platform === 'boss' && job.mode === 'IMPORT' && job.status === 'UNVERIFIED' && job.last_verified_at === null));
    assert.ok(second.every(job => new URL(job.source_url).search === ''));
    assert.equal(h.store.all('tasks').length, beforeTasks);
    assert.equal(h.store.all('actions').length, 0);
    assert.equal(h.store.all('attempts').length, 0);
    assert.equal(h.store.all('messages').length, 0);
    const rule = h.service.createRule({name:'月薪筛选验证',root:{kind:'condition',field:'salary',op:'LOWER_BOUND',value:5000,currency:'CNY',salary_period:'MONTH',effect:'MUST',unknown:'CONFIRM'}});
    assert.equal(first[0]!.salary_period, 'DAY');
    for (const job of first) assert.equal(h.service.match(job.id, rule.id).status, 'PENDING');
  } finally { await h.cleanup(); }
});
