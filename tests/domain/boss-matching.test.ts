import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreBrowserJob,emptyMatchingPreferences,matchingPreferencesSchema} from '../../packages/contracts/src/boss-matching.js';
import {mergeBrowserRead} from '../../apps/desktop/src/main/boss-reader.js';
const job={url:'https://www.zhipin.com/job_detail/MATCHTEST12345.html',title:'Java 后端开发',company:'测试企业',salary:'20-30K',location:'武汉市·江夏区',education:'本科',experience:'应届生',tags:['Java']};
const preferences={...emptyMatchingPreferences,enabled:true,title:'Java',city:'武汉',skills:'Java SQL',exclude:'销售'};
test('matching exposes unknown detail evidence and never scores salary',()=>{
  const result=scoreBrowserJob(job,preferences);
  assert.equal(result.score,85);assert.equal(result.coverage,85);
  assert.ok(result.reasons.some(r=>r.includes('sql') && r.includes('待核实')));
  assert.deepEqual(scoreBrowserJob({...job,salary:'\uE100\uE101K'},preferences),result);
  assert.equal(scoreBrowserJob(job,emptyMatchingPreferences).score,null);
});
test('detail matching gives transparent positive and negative reasons with word boundaries',()=>{
  const detail={description:'Java 后端岗位，熟悉 SQL。',address:'武汉市江夏区',observed_at:'2026-10-11T01:00:00Z'};
  assert.equal(scoreBrowserJob({...job,detail},preferences).score,100);
  const missing=scoreBrowserJob({...job,detail:{...detail,description:'仅需 JavaScript'}},{...preferences,skills:'SQL'});
  assert.equal(missing.score,70);assert.equal(missing.coverage,100);
  assert.ok(missing.reasons.some(r=>r.includes('未命中技能词')));
  assert.equal(scoreBrowserJob({...job,title:'JavaScript 工程师',tags:[],detail:{...detail,description:'JavaScript'}},{...preferences,title:'Java',city:'',skills:'Java',exclude:''}).score,0);
});
test('exclusions inspect description and do not turn missing city into a mismatch',()=>{
  const result=scoreBrowserJob({...job,location:'',detail:{description:'销售岗位',address:'',observed_at:'2026-10-11T01:00:00Z'}},preferences);
  assert.equal(result.excluded,true);assert.ok(result.reasons.some(r=>r.includes('地点未读取')));
  assert.ok(result.coverage<100);
  assert.throws(()=>matchingPreferencesSchema.parse({...preferences,send:true}));
});
test('list refresh preserves separately dated detail but replaces salary OCR',()=>{
  const detail={description:'SQL 职责',address:'武汉',observed_at:'2026-10-10T01:00:00Z'};
  const previous={id:'fixture',page_url:job.url,observed_at:detail.observed_at,jobs:[{...job,detail}]};
  const merged=mergeBrowserRead(previous,[{...job,salary:'新薪资'}],{page_url:'https://www.zhipin.com/web/geek/jobs',observed_at:'2026-10-11T01:00:00Z'},false);
  assert.deepEqual(merged.jobs[0]!.detail,detail);assert.equal(merged.jobs[0]!.salary,'新薪资');
});
