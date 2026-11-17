import { randomUUID, createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { RecruitmentService } from '../../application/src/service.js';
import type { Resume, Account, Task, Action } from '../../contracts/src/index.js';
import { Store } from './database.js';
import { DatabaseSync } from 'node:sqlite';
import { requireCondition } from '../../domain/src/errors.js';

export async function createBackup(service: RecruitmentService) {
  const id=`snapshot-${Date.now()}-${randomUUID()}`;const directory=join(service.directory,'backups',id);
  mkdirSync(join(directory,'resumes'),{recursive:true,mode:0o700});
  await service.store.backup(join(directory,'app.sqlite'));
  const snapshot=new Store(join(directory,'app.sqlite'));
  let resumes: Resume[];
  try {resumes=snapshot.all<Resume>('resumes');} finally {snapshot.close();}
  for (const resume of resumes) copyFileSync(join(service.directory,'resumes',resume.file_ref),join(directory,'resumes',resume.file_ref));
  const hash=createHash('sha256').update(readFileSync(join(directory,'app.sqlite'))).digest('hex');
  writeFileSync(join(directory,'manifest.json'),JSON.stringify({schema_version:2,created_at:new Date().toISOString(),database_hash:hash,resumes:resumes.map(r=>({file_ref:r.file_ref,file_hash:r.file_hash})),excludes:['sessions','api-token','evidence','logs','mock-external']},null,2),{mode:0o600,flag:'wx'});
  return {id,resumes:resumes.length,includes:['database','resumes'],excludes:['sessions','api-token','evidence','logs','mock-external']};
}
export function restoreBackup(sourceDirectory: string, targetDirectory: string) {
  const source=resolve(sourceDirectory),target=resolve(targetDirectory);
  requireCondition(source!==target,'INVALID_RESTORE','备份与目标目录不能相同');
  requireCondition(existsSync(join(source,'manifest.json')) && existsSync(join(source,'app.sqlite')),'INVALID_BACKUP','备份不完整');
  const manifest=JSON.parse(readFileSync(join(source,'manifest.json'),'utf8')) as {schema_version:number;database_hash:string;resumes:{file_ref:string;file_hash:string}[]};
  requireCondition([1,2].includes(manifest.schema_version),'SCHEMA_INCOMPATIBLE','备份版本不兼容');
  requireCondition(createHash('sha256').update(readFileSync(join(source,'app.sqlite'))).digest('hex')===manifest.database_hash,'BACKUP_CHECKSUM','备份数据库校验失败');
  for (const r of manifest.resumes) {
    requireCondition(/^[a-f0-9-]+\.pdf$/.test(r.file_ref),'INVALID_BACKUP','备份含非法文件名');
    requireCondition(createHash('sha256').update(readFileSync(join(source,'resumes',r.file_ref))).digest('hex')===r.file_hash,'BACKUP_CHECKSUM','备份简历校验失败');
  }
  const lockFile=join(target,'instance-lock');
  if (existsSync(lockFile)) {
    const lock=JSON.parse(readFileSync(lockFile,'utf8')) as {pid:number};
    let alive=false;try {process.kill(lock.pid,0);alive=true;} catch {}
    requireCondition(!alive,'SERVICE_RUNNING','恢复前必须关闭后端和桌面应用',409);
  }
  // Check the source without migrating it. Only the restored destination is upgraded.
  const check=new DatabaseSync(join(source,'app.sqlite'),{readOnly:true});
  try {
    requireCondition(check.prepare('PRAGMA integrity_check').get()?.integrity_check==='ok','BACKUP_CORRUPT','备份数据库不完整');
    requireCondition(Number(check.prepare('PRAGMA user_version').get()?.user_version)===manifest.schema_version,'SCHEMA_INCOMPATIBLE','备份数据库与清单版本不一致');
  } finally {check.close();}
  // Destination backups stay inside the explicitly chosen runtime directory.
  const databaseDir=join(target,'database'); const rel=relative(target,databaseDir);
  requireCondition(rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel),'INVALID_RESTORE','目标路径不合法');
  mkdirSync(databaseDir,{recursive:true,mode:0o700});mkdirSync(join(target,'resumes'),{recursive:true,mode:0o700});
  mkdirSync(join(target,'backups'),{recursive:true,mode:0o700});
  const file=join(databaseDir,'app.sqlite');
  if (existsSync(file)) {
    const current=new Store(file);
    try {current.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');copyFileSync(file,join(target,'backups',`before-restore-${Date.now()}.sqlite`));} finally {current.close();}
  }
  copyFileSync(join(source,'app.sqlite'),file);
  for (const r of manifest.resumes) copyFileSync(join(source,'resumes',r.file_ref),join(target,'resumes',r.file_ref));
  const restored=new Store(file);
  try {restored.transaction(()=>{
    for (const account of restored.all<Account>('accounts')) restored.put('accounts',{...account,status:'DISCONNECTED',generation:account.generation+1});
    for (const task of restored.all<Task>('tasks').filter(t=>!['DONE','CANCELLED'].includes(t.state))) restored.put('tasks',{...task,state:'BLOCKED',owner:null,lease_until:null,error:'RESTORE_REQUIRES_IDENTITY_CONFIRMATION'});
    for (const action of restored.all<Action>('actions')) if (['EXECUTING','VERIFYING','RECONCILING'].includes(action.status)) restored.put('actions',{...action,status:'UNKNOWN',reason:'备份恢复后的提交必须人工核实',updated_at:new Date().toISOString()});
    restored.db.exec('DELETE FROM account_locks');restored.put('settings',{id:'scheduler-control',paused:true});
  });} finally {restored.close();}
  return {restored:true,queue_paused:true,accounts_disconnected:true};
}
