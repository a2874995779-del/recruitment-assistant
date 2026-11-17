import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
const directory=mkdtempSync(join(tmpdir(),'recruitment-salary-test-'));
const checked=relative(resolve(tmpdir()),resolve(directory));
if(isAbsolute(checked)||checked.startsWith('..')||!checked.startsWith('recruitment-salary-test-'))throw new Error('非法测试目录');
const env={...process.env,RA_SALARY_SMOKE:'1',RA_DATA_DIR:directory};delete (env as NodeJS.ProcessEnv).ELECTRON_RUN_AS_NODE;
const child=spawn(createRequire(import.meta.url)('electron'),[resolve('dist/scripts/salary-ocr-worker.js')],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let output='',errors='';child.stdout.on('data',d=>{output+=d;process.stdout.write(d);});child.stderr.on('data',d=>errors+=d);
const timer=setTimeout(()=>child.kill(),45000);
try {const code=await new Promise<number|null>((r,j)=>{child.once('exit',r);child.once('error',j);});if(code!==0||!output.includes('SALARY_OCR_SMOKE_OK'))throw new Error(`${output}\n${errors}`);}
finally {clearTimeout(timer);rmSync(directory,{recursive:true,force:true});}
