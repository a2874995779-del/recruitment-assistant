import {app,BrowserWindow} from 'electron';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {salaryFontFixture} from './salary-font-fixture.js';
import {renderSalary,recognizeSalary} from '../apps/desktop/src/main/salary-ocr.js';
if(process.env.RA_SALARY_SMOKE!=='1')throw new Error('只能在独立薪资测试进程运行');
if(!process.env.RA_DATA_DIR)throw new Error('缺少独立测试数据目录');
mkdirSync(join(process.env.RA_DATA_DIR,'electron-profile'),{recursive:true});
app.setPath('userData',join(process.env.RA_DATA_DIR,'electron-profile'));
async function run() {
await app.whenReady();
console.log('SALARY_TEST_PHASE ready');
const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
try {
  const font=salaryFontFixture();
  console.log('SALARY_TEST_PHASE font');
  const url='https://www.zhipin.com/job_detail/OCRTEST123456.html';
  const html=`<style>@font-face{font-family:LocalSalaryFixture;src:url(data:font/otf;base64,${font.base64})}.salary{font-family:LocalSalaryFixture,Arial}</style><li class="job-card-wrapper"><a href="${url}">本地测试岗位</a><span class="salary">${font.raw}</span></li>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await window.webContents.executeJavaScript('document.fonts.ready.then(()=>true)');
  console.log('SALARY_TEST_PHASE loaded');
  const rendered=await window.webContents.executeJavaScript(`(${renderSalary.toString()})(${JSON.stringify({url,salary:font.raw})})`);
  const result=await recognizeSalary(rendered);
  assert.equal(result.candidate,'15-25K·13薪');assert.equal(result.confirmed,false);
  mkdirSync('docs/qa',{recursive:true});
  writeFileSync('docs/qa/salary-font-ocr.png',Buffer.from(result.preview.split(',')[1]!,'base64'));
  console.log('SALARY_OCR_SMOKE_OK',JSON.stringify({raw_private_use:true,candidate:result.candidate,confidence:result.confidence,local:true,native_capture_used:false,confirmed:false}));
} catch(error){console.error(error);process.exitCode=1;}
finally {window.destroy();app.exit(Number(process.exitCode ?? 0));}
}
void run().catch(error=>{console.error(error);app.exit(1);});
