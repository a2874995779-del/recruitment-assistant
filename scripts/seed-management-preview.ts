// Local UI acceptance samples only, in a fixed separate preview data directory.
import { join } from 'node:path';
import {readFileSync} from 'node:fs';
import { Store } from '../packages/persistence/src/database.js';
import { RecruitmentService } from '../packages/application/src/service.js';
import { browserJobInput } from '../apps/desktop/src/main/boss-reader.js';
const directory = join(process.env.LOCALAPPDATA!, 'RecruitmentAssistantPreview-4323');
if (!process.env.LOCALAPPDATA) throw new Error('缺少本地应用数据目录');
const store = new Store(join(directory,'database','app.sqlite'));
try {
  const service = new RecruitmentService(store,directory);
  service.importJobs(['Java 开发（验收样本）','前端开发（验收样本）'].map((title,i)=>browserJobInput({url:`https://www.zhipin.com/job_detail/QAONLY123456${i}.html`,title,company:'本地验收虚构企业',salary:'',location:'武汉',education:'本科',experience:'经验不限',tags:['本科']},new Date().toISOString())));
  console.log('已建立独立预览样本；未访问招聘网站。');
  try {
    const preview=`data:image/png;base64,${readFileSync(join(process.cwd(),'docs','qa','salary-font-ocr.png')).toString('base64')}`;
    service.importJobs([browserJobInput({url:'https://www.zhipin.com/job_detail/QAONLYSALARY123.html',title:'薪资 OCR（验收样本）',company:'本地验收虚构企业',salary:'\uE011\uE015-\uE012\uE015K·13薪',location:'武汉',education:'本科',experience:'经验不限',tags:[],salary_ocr:{candidate:'15-25K·13薪',confidence:89,preview,confirmed:true}},new Date().toISOString())]);
  } catch { /* OCR sample is optional until salary:smoke generates its proof. */ }
} finally {store.close();}
