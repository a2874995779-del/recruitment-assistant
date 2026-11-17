import test from 'node:test';
import assert from 'node:assert/strict';
import {assembleSalary,renderedSalarySchema} from '../../apps/desktop/src/main/salary-ocr.js';
import {browserJobInput} from '../../apps/desktop/src/main/boss-reader.js';
const raw='\uE011\uE012-\uE013\uE012K·13薪';
test('OCR replaces only private-use numeric runs and preserves original units',()=>{
  assert.equal(assembleSalary(raw,[{raw:'\uE011\uE012',digits:'15',confidence:95},{raw:'\uE013\uE012',digits:'25',confidence:96}]),'15-25K·13薪');
  assert.equal(assembleSalary('\uE01100-\uE01300元/天',[{raw:'\uE01100',digits:'100',confidence:90},{raw:'\uE01300',digits:'200',confidence:95}]),'100-200元/天');
});
test('OCR rejects missing digits, mismatched runs, low confidence and unsupported payloads',()=>{
  for(const readings of [[],[{raw:'wrong',digits:'15',confidence:99}],[{raw:'\uE011\uE012',digits:'1',confidence:99}],[{raw:'\uE011\uE012',digits:'15',confidence:40}]])assert.throws(()=>assembleSalary(raw,readings));
  assert.equal(renderedSalarySchema.safeParse({raw,preview:'https://evil.example/img.png',runs:[]}).success,false);
  assert.throws(()=>assembleSalary('\uE01100元/天',[{raw:'\uE01100',digits:'101',confidence:99}]));
});
test('pending OCR never replaces saved salary; confirmation preserves original and provenance',()=>{
  const job={url:'https://www.zhipin.com/job_detail/OCRTEST123456.html',title:'测试',company:'企业',salary:raw,location:'武汉',education:'本科',experience:'',tags:[],salary_ocr:{candidate:'15-25K·13薪',confidence:95,preview:'data:image/png;base64,AA==',confirmed:false}};
  assert.equal(browserJobInput(job,'2026-10-11T00:00:00Z').salary_raw,raw);
  const saved=browserJobInput({...job,salary_ocr:{...job.salary_ocr,confirmed:true}},'2026-10-11T00:00:00Z');
  assert.equal(saved.salary_raw,'15-25K·13薪');assert.equal(saved.extra.salary_original,raw);assert.equal(saved.extra.salary_source,'LOCAL_FONT_OCR_CONFIRMED');
  assert.equal(saved.salary_min,null);assert.equal(saved.salary_period,null);
});
