import {mkdtempSync,existsSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

export async function verifyWindowsPackage(folder){
  const data=mkdtempSync(join(tmpdir(),'recruitment-package-qa-'));
  const env={...process.env,RA_DATA_DIR:data,RA_PACKAGE_SMOKE:'1'};
  for(const key of ['ELECTRON_RUN_AS_NODE','RA_DESKTOP_SMOKE','RA_INCREMENTAL_SMOKE','RA_FILTER_SMOKE','RA_SAVED_SMOKE','RA_SALARY_SMOKE'])delete env[key];
  const child=spawn(join(folder,'招聘助手.exe'),[],{cwd:data,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',value=>{logs+=value;});child.stderr.on('data',value=>{logs+=value;});
  const timer=setTimeout(()=>child.kill(),45000);
  const code=await new Promise((accept,reject)=>{child.once('exit',accept);child.once('error',reject);}).finally(()=>clearTimeout(timer));
  writeFileSync(join(data,'launch.log'),logs);
  const resultFile=join(data,'package-smoke-result.json');
  if(code!==0 || !existsSync(resultFile))throw new Error(`打包启动验收失败 (${code})，日志：${join(data,'launch.log')}\n${logs.slice(-2500)}`);
  const result=JSON.parse(readFileSync(resultFile,'utf8'));
  if(!result.packaged || result.cookies!==0 || Object.values(result.counts).some(value=>value!==0))throw new Error('空数据检查未通过');
  const manifestPath=join(folder,'distribution-manifest.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  writeFileSync(manifestPath,JSON.stringify({...manifest,clean_start_verified:result},null,2));
  // App startup must not place any profile or databases inside the shipped tree.
  function check(dir){for(const item of readdirSync(dir,{withFileTypes:true})){if(/^(?:electron-profile|database|sessions|resumes|backups|evidence|logs)$|\.(?:sqlite(?:-wal|-shm)?|db|log)$/i.test(item.name))throw new Error('程序运行后污染了分发目录');if(item.isDirectory())check(join(dir,item.name));}}
  check(folder);console.log('PACKAGE_CLEAN_START_OK',JSON.stringify(result));
  return result;
}
export function archiveWindowsPackage(folder){
  const zip=folder+'.zip';if(existsSync(zip))throw new Error('不覆盖已有分发包：'+zip);
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath ${quote(folder)} -DestinationPath ${quote(zip)} -CompressionLevel Optimal`],{windowsHide:true,stdio:'pipe',timeout:180000});
  const hash=createHash('sha256').update(readFileSync(zip)).digest('hex');
  writeFileSync(zip+'.sha256.txt',hash+'  '+zip.split(/[\\/]/).pop()+'\r\n');
  console.log('PACKAGE_ZIP_READY',zip);console.log('SHA256',hash);
}
if(process.argv[1] && resolve(process.argv[1])===resolve(import.meta.filename)){
  const folder=resolve(process.argv[2]??'');
  if(!process.argv[2] || !existsSync(join(folder,'distribution-manifest.json')))throw new Error('请选择已有程序分发目录');
  await verifyWindowsPackage(folder);archiveWindowsPackage(folder);
}
