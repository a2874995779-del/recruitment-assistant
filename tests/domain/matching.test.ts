import test from 'node:test';
import assert from 'node:assert/strict';
import { jobInput, ruleInput, type Job, type Rule, type RuleNode } from '../../packages/contracts/src/index.js';
import { matchJob, qualificationIssues } from '../../packages/domain/src/matching.js';
import { csvCell } from '../../packages/adapters/import/src/index.js';

const fixture=(overrides:Record<string,unknown>={}):Job=>({...jobInput.parse({external_job_id:'1',source_instance_id:'test',source_url:'https://example.com/job',platform:'boss',mode:'MOCK',title:'工程师',company_name:'测试企业',locations:['武汉'],salary_min:12000,salary_max:20000,currency:'CNY',salary_period:'MONTH',apply_target:{kind:'IN_PLATFORM'},...overrides}),id:'job',user_id:'local-user',schema_version:1,content_hash:'hash',first_seen_at:'2026-10-09T00:00:00.000Z',last_seen_at:'2026-10-09T00:00:00.000Z',last_verified_at:null});
const rule=(root:unknown):Rule=>({...ruleInput.parse({name:'test',root}),id:'rule',version:3,user_id:'local-user',created_at:'2026-10-09T00:00:00.000Z'});

for (const [policy,expected] of [['ALLOW','PASS'],['EXCLUDE','EXCLUDED'],['CONFIRM','PENDING']] as const) test(`unknown salary policy ${policy}`,()=>{
  const r=rule({kind:'condition',field:'salary',op:'LOWER_BOUND',value:10000,currency:'CNY',salary_period:'MONTH',unknown:policy});
  assert.equal(matchJob(fixture({salary_min:null,salary_max:null}),r).status,expected);
  assert.equal(matchJob(fixture({currency:'USD'}),r).status,expected);
  assert.equal(matchJob(fixture({salary_period:'YEAR'}),r).status,expected);
});
test('salary lower bound, overlap and original units are distinct',()=>{
  const lower=rule({kind:'condition',field:'salary',op:'LOWER_BOUND',value:15000,currency:'CNY',salary_period:'MONTH'});
  const overlap=rule({kind:'condition',field:'salary',op:'INTERSECTS',value:[15000,25000],currency:'CNY',salary_period:'MONTH'});
  assert.equal(matchJob(fixture(),lower).status,'EXCLUDED');assert.equal(matchJob(fixture(),overlap).status,'PASS');
  assert.equal(matchJob(fixture(),overlap).rule_version,3);
});
test('hard rules cannot be bypassed by preferences in OR, including nested groups',()=>{
  const hard={kind:'condition',field:'locations',op:'EQ',value:'上海'};
  const preference={kind:'condition',field:'title',op:'CONTAINS',value:'工程师',effect:'PREFER',weight:100};
  for(const root of [{kind:'group',op:'AND',children:[hard,preference]},{kind:'group',op:'OR',children:[hard,preference]},{kind:'group',op:'OR',children:[hard,{kind:'group',op:'AND',children:[preference]}]}]) {
    const result=matchJob(fixture(),rule(root));assert.equal(result.status,'EXCLUDED');assert.equal(result.score,100);
  }
});
test('AND and OR expose unknown reasons; company nature requires verified evidence',()=>{
  const known={kind:'condition',field:'locations',op:'EQ',value:'武汉'};const unknown={kind:'condition',field:'majors',op:'IN',value:['计算机']};
  assert.equal(matchJob(fixture(),rule({kind:'group',op:'AND',children:[known,unknown]})).status,'PENDING');
  assert.equal(matchJob(fixture(),rule({kind:'group',op:'OR',children:[known,unknown]})).status,'PASS');
  const nature=rule({kind:'condition',field:'company_nature',op:'IN',value:['国企']});
  assert.equal(matchJob(fixture({company_nature:['国企'],nature_verified:false}),nature).status,'PENDING');
  assert.equal(matchJob(fixture({company_nature:['国企'],nature_verified:true,nature_evidence_url:'https://example.com/evidence'}),nature).status,'PASS');
});
test('exclusions, dates and invalid operators retain strict semantics',()=>{
  assert.equal(matchJob(fixture(),rule({kind:'condition',field:'company_name',op:'CONTAINS',value:'测试',effect:'EXCLUDE'})).status,'EXCLUDED');
  assert.throws(()=>rule({kind:'condition',field:'locations',op:'GTE',value:10}));
  assert.throws(()=>rule({kind:'condition',field:'salary',op:'INTERSECTS',value:[20,10],currency:'CNY',salary_period:'MONTH'}));
  assert.throws(()=>fixture({salary_min:20000,salary_max:10000}));
  const date=fixture({deadline_at:'2026-12-01',deadline_precision:'DATE',deadline_timezone:'Asia/Shanghai'});assert.equal(date.deadline_at,'2026-12-01');
  assert.throws(()=>fixture({deadline_at:'2026-12-01'}));
  assert.equal(qualificationIssues(fixture({recruitment_type:'CAMPUS'}),{major:null,graduation_year:null,education:null,experience_years:null}).length,1);
});
test('100 labelled salary cases cover boundaries, unknown values and salary units',()=>{
  const rows=[
    {min:0,max:5000,currency:'CNY',period:'MONTH',expected:'EXCLUDED'},
    {min:9999,max:20000,currency:'CNY',period:'MONTH',expected:'EXCLUDED'},
    {min:10000,max:10000,currency:'CNY',period:'MONTH',expected:'PASS'},
    {min:12000,max:20000,currency:'CNY',period:'MONTH',expected:'PASS'},
    {min:null,max:null,currency:'CNY',period:'MONTH',expected:'PENDING'},
    {min:10000,max:null,currency:'CNY',period:'MONTH',expected:'PASS'},
    {min:null,max:20000,currency:'CNY',period:'MONTH',expected:'PENDING'},
    {min:20000,max:30000,currency:'USD',period:'MONTH',expected:'PENDING'},
    {min:100000,max:200000,currency:'CNY',period:'YEAR',expected:'PENDING'},
    {min:10000,max:20000,currency:null,period:null,expected:'PENDING'}
  ];
  const r=rule({kind:'condition',field:'salary',op:'LOWER_BOUND',value:10000,currency:'CNY',salary_period:'MONTH'});
  let count=0;
  for(const row of rows)for(const raw of ['面议','10K起','10-20K·13薪','10000元/月','按年','约12K','税前','薪资未注明','范围待核实','来源原文']) {
    const j=fixture({salary_min:row.min,salary_max:row.max,currency:row.currency,salary_period:row.period,salary_raw:raw});
    assert.equal(matchJob(j,r).status,row.expected,`${raw} / ${JSON.stringify(row)}`);count++;
  }
  assert.equal(count,100);
});
test('rules reject excessive depth and CSV export blocks formula injection',()=>{
  let node:RuleNode={kind:'condition',field:'title',op:'EQ',value:'x',effect:'MUST',unknown:'CONFIRM',weight:1};
  for(let i=0;i<11;i++)node={kind:'group',op:'AND',children:[node]};assert.throws(()=>rule(node));
  assert.equal(csvCell('=1+1'),'"\'=1+1"');assert.equal(csvCell('"quoted"'),'"""quoted"""');
});
