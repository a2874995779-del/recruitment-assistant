import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync,readdirSync,renameSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {verifyWindowsPackage,archiveWindowsPackage} from './verify-windows-package.mjs';

if(process.platform!=='win32' || process.arch!=='x64')throw new Error('此命令需在 Windows x64 上运行');
const root=resolve(import.meta.dirname,'..');
const metadata=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
const label=`招聘助手-${metadata.version}-CyuBack-Windows-x64`;
let folder=join(root,'releases',label);
if(existsSync(folder) || existsSync(folder+'.zip'))folder+=`-${Date.now()}`;
const output=join(folder,'resources','app');
const runtime=join(root,'node_modules','electron','dist');
if(!existsSync(join(runtime,'electron.exe')))throw new Error('请先运行 npm.cmd run desktop:install');
mkdirSync(folder,{recursive:true});
// Allowlist only the installed Electron runtime; never copy the project root.
cpSync(runtime,folder,{recursive:true,filter:path=>{const rel=relative(runtime,path).replaceAll('\\','/');return rel!=='resources/default_app.asar' && rel!=='version';}});
renameSync(join(folder,'electron.exe'),join(folder,'招聘助手.exe'));
mkdirSync(output,{recursive:true});
writeFileSync(join(output,'package.json'),JSON.stringify({name:'recruitment-assistant',productName:'招聘助手',author:'CyuBack',version:metadata.version,type:'module',main:'dist/apps/desktop/src/main/index.js',dependencies:metadata.dependencies},null,2));
const copyBuild=(source,target)=>{
  cpSync(source,target,{recursive:true,filter:path=>{
    const name=path.split(/[\\/]/).pop();
    return !/\.map$/.test(name) && !/smoke/.test(name) && (readdirSafe(path) || /\.(?:js|cjs|html|css|svg|png|woff2?)$/.test(name));
  }});
};
function readdirSafe(path){try{readdirSync(path);return true;}catch{return false;}}
copyBuild(join(root,'dist','apps','desktop'),join(output,'dist','apps','desktop'));
copyBuild(join(root,'dist','packages'),join(output,'dist','packages'));
copyBuild(join(root,'dist','renderer'),join(output,'dist','renderer'));
// Resolve the installed production graph without downloading or changing dependencies.
const npmCli=process.env.npm_execpath;
const paths=npmCli?execFileSync(process.execPath,[npmCli,'ls','--omit=dev','--all','--parseable'],{cwd:root,encoding:'utf8',windowsHide:true}):execFileSync('cmd.exe',['/d','/c','npm.cmd ls --omit=dev --all --parseable'],{cwd:root,encoding:'utf8',windowsHide:true});
let modules=0;
for(const path of new Set(paths.trim().split(/\r?\n/))){
  if(resolve(path)===root)continue;
  const rel=relative(join(root,'node_modules'),path);
  if(isAbsolute(rel) || rel.startsWith('..') || !rel)throw new Error('依赖路径超出允许目录');
  cpSync(path,join(output,'node_modules',rel),{recursive:true,filter:file=>{const child=relative(path,file);return !child.split(/[\\/]/).some(part=>part==='node_modules' || part==='.cache' || part==='.git');}});
  modules++;
}
writeFileSync(join(folder,'使用说明.txt'),'招聘助手 '+metadata.version+' · Windows x64 免安装版\r\nCyuBack制作，仅个人使用\r\nCyuBack 专属，禁止商用\r\n\r\n1. 解压整个压缩包，保持文件完整。\r\n2. 双击“招聘助手.exe”，无需安装 Node.js。\r\n3. 第一次运行没有账号或岗位数据，请自行登录 BOSS。\r\n4. 个人数据保存在本机 %LOCALAPPDATA%\\RecruitmentAssistant，卸载程序文件不会清除个人数据。\r\n5. 只读辅助，不自动发送消息或投递；岗位变化需手动更新原帖。\r\n6. 本分发包未签名；请从可信的发送者取得并核对文件。\r\n','utf8');
const forbidden=[];let files=0;
function audit(dir){for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name),rel=relative(folder,path);if(entry.isSymbolicLink())throw new Error('分发包禁止符号链接');if(/(?:^|[\\/])(?:electron-profile|database|sessions|resumes|backups|evidence|logs)(?:[\\/]|$)|\.(?:sqlite(?:-wal|-shm)?|db|log)$|(?:^|[\\/])\.env(?:\.|$)/i.test(rel))forbidden.push(rel);if(entry.isDirectory())audit(path);else files++;}}
audit(folder);if(forbidden.length)throw new Error('分发包包含禁止文件：'+forbidden.join(','));
writeFileSync(join(folder,'distribution-manifest.json'),JSON.stringify({version:metadata.version,platform:'win32',arch:'x64',production_modules:modules,files,personal_data_included:false,attribution:'CyuBack制作，仅个人使用',policy:'Only Electron runtime, built application and production npm dependencies. No local runtime directory copied.'},null,2));
console.log(JSON.stringify({folder,exe:join(folder,'招聘助手.exe'),production_modules:modules,files,personal_data_included:false},null,2));
await verifyWindowsPackage(folder);
archiveWindowsPackage(folder);
