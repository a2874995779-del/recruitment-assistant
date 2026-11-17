import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, mkdirSync } from 'node:fs';
import { setup } from '../helpers.js';
import { Store } from '../../packages/persistence/src/database.js';
import { RecruitmentService } from '../../packages/application/src/service.js';
import { Scheduler } from '../../packages/scheduler/src/index.js';
import type { Action, Task } from '../../packages/contracts/src/index.js';

test('reopened database verifies an interrupted submission receipt without another attempt',async()=>{
  const h=await setup();let reopened:Store|undefined;try{
    const b=h.service.createBatch(h.input);await h.scheduler.tick({schedule:false});
    const action=h.service.batchDetail(b.id).actions[0]!;const task=h.store.all<Task>('tasks').find(t=>t.kind==='ACTION')!;
    h.store.put('actions',{...action,status:'EXECUTING',evidence:null});
    h.store.put('tasks',{...task,state:'RUNNING',owner:'interrupted-process',lease_until:'2020-01-01T00:00:00.000Z'});
    h.store.close();reopened=new Store(join(h.directory,'database','app.sqlite'));
    const service=new RecruitmentService(reopened,h.directory);const scheduler=new Scheduler(service);await scheduler.tick({schedule:false});
    assert.equal(service.get<Action>('actions',action.id).status,'SUCCEEDED');assert.equal(reopened.all('attempts').length,1);await scheduler.stop();
  }finally{reopened?.close();await h.cleanup();}
});
test('a future schema refuses startup without wiping records',async()=>{
  const h=await setup();try{
    h.store.close();const file=join(h.directory,'database','app.sqlite');const future=new DatabaseSync(file);future.exec('PRAGMA user_version=3');future.close();
    assert.throws(()=>new Store(file),/数据库版本高于/);
    const check=new DatabaseSync(file);try{assert.equal(check.prepare('SELECT count(*) n FROM jobs').get()?.n,4);}finally{check.close();}
  }finally{await h.cleanup();}
});
test('failed initial migration rolls back changes and preserves a recoverable backup',async()=>{
  const h=await setup();try{
    const databaseDir=join(h.directory,'migration-failure','database');mkdirSync(databaseDir,{recursive:true});const file=join(databaseDir,'app.sqlite');
    const incompatible=new DatabaseSync(file);incompatible.exec("CREATE TABLE jobs(id TEXT); INSERT INTO jobs VALUES('preserved'); PRAGMA user_version=0");incompatible.close();
    assert.throws(()=>new Store(file),/already exists/);
    const original=new DatabaseSync(file);try{assert.equal(original.prepare('SELECT id FROM jobs').get()?.id,'preserved');assert.equal(original.prepare("SELECT count(*) n FROM sqlite_master WHERE name='profiles'").get()?.n,0);}finally{original.close();}
    assert.ok(readdirSync(join(h.directory,'migration-failure','backups')).some(f=>f.startsWith('pre-migration-')));
  }finally{await h.cleanup();}
});
