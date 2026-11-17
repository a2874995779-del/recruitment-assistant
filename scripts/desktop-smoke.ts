import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
const directory=mkdtempSync(join(tmpdir(),'recruitment-desktop-test-'));
const tempRelative=relative(resolve(tmpdir()),resolve(directory));
if(isAbsolute(tempRelative)||tempRelative.startsWith('..')||!tempRelative.startsWith('recruitment-desktop-test-'))throw new Error('测试目录不在预期临时目录中');
const electron=createRequire(import.meta.url)('electron') as string;
const env:NodeJS.ProcessEnv={...process.env,RA_DATA_DIR:directory,RA_DESKTOP_SMOKE:'1'};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electron,[resolve('dist/apps/desktop/src/main/index.js')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='';let error='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{error+=data;});
// Scroll/pagination regressions include real delayed-load waits; the complete
// isolated suite has a bounded four-minute budget, independent of live profiles.
const timeout=setTimeout(()=>child.kill(),240000);
try {
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
  if(code!==0||!output.includes('DESKTOP_SMOKE_OK'))throw new Error(`桌面入口检查失败 (${code})\n${error}\n${output}`);
  if(!output.includes('BOSS_BROWSER_SMOKE_OK'))throw new Error('内置浏览器检查未完成');
  mkdirSync(resolve('docs/qa'),{recursive:true});
  if(existsSync(join(directory,'boss-helper-smoke.png')))copyFileSync(join(directory,'boss-helper-smoke.png'),resolve('docs/qa/boss-helper-offline.png'));
  if(existsSync(join(directory,'boss-browser-smoke.png')))copyFileSync(join(directory,'boss-browser-smoke.png'),resolve('docs/qa/boss-browser-offline.png'));
  if(existsSync(join(directory,'boss-batch-smoke.png')))copyFileSync(join(directory,'boss-batch-smoke.png'),resolve('docs/qa/boss-batch-offline.png'));
  if(existsSync(join(directory,'boss-search-smoke.png'))){
    const qaDirectory=process.env.RA_QA_DIR || join(tmpdir(),'recruitment-assistant-qa');
    mkdirSync(qaDirectory,{recursive:true});copyFileSync(join(directory,'boss-search-smoke.png'),join(qaDirectory,'boss-search-offline.png'));
    console.log('Search screenshot:',join(qaDirectory,'boss-search-offline.png'));
  }
  if(existsSync(join(directory,'boss-salary-detail-smoke.png'))){
    const qaDirectory=process.env.RA_QA_DIR || join(tmpdir(),'recruitment-assistant-qa');
    mkdirSync(qaDirectory,{recursive:true});copyFileSync(join(directory,'boss-salary-detail-smoke.png'),join(qaDirectory,'boss-salary-detail-offline.png'));
    console.log('Salary screenshot:',join(qaDirectory,'boss-salary-detail-offline.png'));
  }
  if(existsSync(join(directory,'boss-breadth-smoke.png'))){
    const qaDirectory=process.env.RA_QA_DIR || join(tmpdir(),'recruitment-assistant-qa');
    mkdirSync(qaDirectory,{recursive:true});copyFileSync(join(directory,'boss-breadth-smoke.png'),join(qaDirectory,'boss-breadth-offline.png'));
    console.log('Breadth screenshot:',join(qaDirectory,'boss-breadth-offline.png'));
  }
  for(const name of ['boss-filter-form','boss-filter-narrow','boss-comparison','boss-changes','boss-incremental-smoke','boss-incremental-narrow','boss-verification-smoke','boss-saved-skip-smoke','boss-saved-management-smoke','boss-saved-management-narrow'])if(existsSync(join(directory,name+'.png'))){const target=process.env.RA_QA_DIR || join(tmpdir(),'recruitment-assistant-qa');mkdirSync(target,{recursive:true});copyFileSync(join(directory,name+'.png'),join(target,name+'.png'));}
  console.log(output.trim());
} finally {clearTimeout(timeout);rmSync(directory,{recursive:true,force:true});}
