import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { USER_ID } from '../../contracts/src/index.js';
import type { Job, Task } from '../../contracts/src/index.js';
import { parseSavedSalary, type SavedJobQuery } from '../../contracts/src/job-management.js';

export const tables = ['profiles', 'accounts', 'resumes', 'rules', 'jobs', 'job_sources', 'job_revisions', 'batches', 'actions', 'tasks', 'attempts', 'search_plans', 'messages', 'outbox', 'notifications', 'companies', 'sources', 'audit', 'settings', 'sync_cursors', 'notices'] as const;
export type Table = typeof tables[number];
export type JobQuery = {offset?: number; limit?: number; platform?: string; mode?: string; status?: string; search?: string; personal_mark?: string} & Partial<SavedJobQuery> & {saved_management?:boolean};
type Entity = { id: string; user_id?: string };

const generated: Partial<Record<Table, string>> = {
  accounts: ", platform TEXT GENERATED ALWAYS AS (json_extract(body,'$.platform')) STORED, mode TEXT GENERATED ALWAYS AS (json_extract(body,'$.mode')) STORED, station TEXT GENERATED ALWAYS AS (coalesce(json_extract(body,'$.station.base_url'),'')) STORED, UNIQUE(user_id,platform,mode,station)",
  rules: ", rule_id TEXT GENERATED ALWAYS AS (json_extract(body,'$.rule_id')) STORED",
  jobs: ", source_key TEXT GENERATED ALWAYS AS (json_extract(body,'$.source_instance_id') || ':' || json_extract(body,'$.external_job_id')) STORED, mode TEXT GENERATED ALWAYS AS (json_extract(body,'$.mode')) STORED, platform TEXT GENERATED ALWAYS AS (json_extract(body,'$.platform')) STORED, title TEXT GENERATED ALWAYS AS (json_extract(body,'$.title')) STORED, status TEXT GENERATED ALWAYS AS (json_extract(body,'$.status')) STORED, UNIQUE(user_id,mode,source_key)",
  batches: ", idempotency_key TEXT GENERATED ALWAYS AS (json_extract(body,'$.idempotency_key')) STORED, UNIQUE(user_id,idempotency_key)",
  actions: ", account_id TEXT GENERATED ALWAYS AS (json_extract(body,'$.account_id')) STORED, source_key TEXT GENERATED ALWAYS AS (json_extract(body,'$.source_key')) STORED, action_type TEXT GENERATED ALWAYS AS (json_extract(body,'$.type')) STORED, batch_id TEXT GENERATED ALWAYS AS (json_extract(body,'$.batch_id')) STORED, status TEXT GENERATED ALWAYS AS (json_extract(body,'$.status')) STORED, UNIQUE(user_id,account_id,source_key,action_type)",
  tasks: ", account_id TEXT GENERATED ALWAYS AS (json_extract(body,'$.account_id')) STORED, state TEXT GENERATED ALWAYS AS (json_extract(body,'$.state')) STORED, kind TEXT GENERATED ALWAYS AS (json_extract(body,'$.kind')) STORED, priority INTEGER GENERATED ALWAYS AS (json_extract(body,'$.priority')) STORED, run_after TEXT GENERATED ALWAYS AS (json_extract(body,'$.run_after')) STORED, lease_until TEXT GENERATED ALWAYS AS (json_extract(body,'$.lease_until')) STORED",
  messages: ", account_id TEXT GENERATED ALWAYS AS (json_extract(body,'$.account_id')) STORED, dedupe_key TEXT GENERATED ALWAYS AS (json_extract(body,'$.dedupe_key')) STORED, UNIQUE(user_id,account_id,dedupe_key)",
  outbox: ", event_key TEXT GENERATED ALWAYS AS (json_extract(body,'$.event_key')) STORED, UNIQUE(user_id,event_key)",
  notifications: ", event_id TEXT GENERATED ALWAYS AS (json_extract(body,'$.event_id')) STORED, channel TEXT GENERATED ALWAYS AS (json_extract(body,'$.channel')) STORED, UNIQUE(user_id,event_id,channel)"
};

export class Store {
  readonly db: DatabaseSync;
  private inTransaction = false;
  private closed = false;
  constructor(readonly filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.function('saved_salary_min',{deterministic:true},raw=>parseSavedSalary(typeof raw==='string'?raw:null)?.min??null);
    this.db.function('saved_salary_max',{deterministic:true},raw=>parseSavedSalary(typeof raw==='string'?raw:null)?.max??null);
    this.db.function('saved_salary_period',{deterministic:true},raw=>parseSavedSalary(typeof raw==='string'?raw:null)?.period??null);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    try { this.migrate(); } catch (error) { this.db.close(); throw error; }
  }
  private migrate() {
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (version > 2) throw new Error('数据库版本高于应用版本，请使用兼容应用或恢复已验证备份');
    if (version === 2) return;
    if (this.filename !== ':memory:' && existsSync(this.filename)) {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      mkdirSync(join(dirname(this.filename), '..', 'backups'), { recursive: true, mode: 0o700 });
      copyFileSync(this.filename, join(dirname(this.filename), '..', 'backups', `pre-migration-${Date.now()}.sqlite`));
    }
    this.transaction(() => {
      if(version===0) {
      for (const table of tables.filter(t=>t!=='notices')) this.db.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), updated_at TEXT NOT NULL${generated[table] ?? ''})`);
      this.db.exec(`CREATE TABLE account_locks(account_id TEXT PRIMARY KEY, owner TEXT NOT NULL, lease_until TEXT NOT NULL);
        CREATE INDEX idx_tasks_ready ON tasks(user_id,state,run_after,priority);
        CREATE INDEX idx_jobs_list ON jobs(user_id,mode,platform,status,title);
        CREATE INDEX idx_actions_batch ON actions(user_id,batch_id,status);
        CREATE INDEX idx_messages_account ON messages(user_id,account_id);
        PRAGMA user_version=1;`);
      }
      this.db.exec("CREATE TABLE notices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,body TEXT NOT NULL CHECK(json_valid(body)),updated_at TEXT NOT NULL); PRAGMA user_version=2;");
    });
  }
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  put<T extends Entity>(table: Table, value: T): T {
    const user = value.user_id ?? USER_ID;
    this.db.prepare(`INSERT INTO ${table}(id,user_id,body,updated_at) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at WHERE ${table}.user_id=excluded.user_id`)
      .run(value.id, user, JSON.stringify({...value, user_id: user}), new Date().toISOString());
    return value;
  }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT body FROM ${table} WHERE id=? AND user_id=?`).get(id, USER_ID);
    return row ? JSON.parse(String(row.body)) as T : undefined;
  }
  all<T>(table: Table): T[] { return this.db.prepare(`SELECT body FROM ${table} WHERE user_id=? ORDER BY rowid`).all(USER_ID).map(r => JSON.parse(String(r.body)) as T); }
  settingsByPrefix<T>(prefix:string):T[]{return this.db.prepare("SELECT body FROM settings WHERE user_id=? AND id>=? AND id<? ORDER BY id").all(USER_ID,prefix,prefix+'\uffff').map(r=>JSON.parse(String(r.body)) as T);}
  find<T>(table: Table, predicate: (value: T) => boolean): T | undefined { return this.all<T>(table).find(predicate); }
  remove(table: Table, id: string) { this.db.prepare(`DELETE FROM ${table} WHERE id=? AND user_id=?`).run(id, USER_ID); }
  findSourceJob(mode: string, sourceKey: string): Job | undefined {
    const row=this.db.prepare('SELECT body FROM jobs WHERE user_id=? AND mode=? AND source_key=?').get(USER_ID,mode,sourceKey);
    return row?JSON.parse(String(row.body)) as Job:undefined;
  }
  savedBossUrls(): string[] {
    return this.db.prepare("SELECT DISTINCT json_extract(body,'$.source_url') AS url FROM jobs WHERE user_id=? AND platform='boss' AND mode='IMPORT'").all(USER_ID).map(row=>String(row.url ?? ''));
  }
  queryJobs(options: JobQuery = {}) {
    const {offset=0,limit=50}=options;let sql='SELECT body FROM jobs WHERE user_id=?';const args:(string|number)[]=[USER_ID];
    for(const field of ['platform','mode','status'] as const)if(options[field]){sql+=` AND ${field}=?`;args.push(options[field]!);}
    if(options.search){sql+=options.saved_management?" AND instr(lower(title || ' ' || json_extract(body,'$.company_name') || ' ' || coalesce((SELECT json_extract(s.body,'$.note') FROM settings s WHERE s.id='job-note:'||jobs.id AND s.user_id=jobs.user_id),'')),lower(?))>0":' AND instr(lower(title),lower(?))>0';args.push(options.search.trim());}
    if(options.company){sql+=" AND instr(lower(json_extract(body,'$.company_name')),lower(?))>0";args.push(options.company.trim());}
    if(options.city){sql+=" AND EXISTS(SELECT 1 FROM json_each(json_extract(jobs.body,'$.locations')) WHERE instr(replace(value,'市',''),replace(?,'市',''))>0)";args.push(options.city.trim());}
    const salary="json_extract(body,'$.salary_raw')";
    if(options.salary_period){sql+=` AND saved_salary_period(${salary})=?`;args.push(options.salary_period);}
    if(options.salary_min!==undefined){sql+=` AND saved_salary_max(${salary})>=?`;args.push(options.salary_min);}
    if(options.salary_max!==undefined){sql+=` AND saved_salary_min(${salary})<=?`;args.push(options.salary_max);}
    if(options.personal_mark){sql+=" AND coalesce((SELECT json_extract(s.body,'$.mark') FROM settings s WHERE s.id='job-mark:'||jobs.id AND s.user_id=jobs.user_id),'CONSIDERING')=?";args.push(options.personal_mark);}
    const total=Number(this.db.prepare(sql.replace('SELECT body','SELECT count(*) AS n')).get(...args)?.n??0);
    const sorts:Record<string,string>={SAVED_DESC:"json_extract(body,'$.first_seen_at') DESC,id",SAVED_ASC:"json_extract(body,'$.first_seen_at') ASC,id",SALARY_DESC:`saved_salary_min(${salary}) DESC,saved_salary_max(${salary}) DESC,id`,SALARY_ASC:`saved_salary_min(${salary}) ASC,saved_salary_max(${salary}) ASC,id`};
    const order=options.saved_management?(sorts[options.sort??'SAVED_DESC']??sorts.SAVED_DESC):'updated_at DESC,id';
    const items=this.db.prepare(`${sql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args,limit,offset).map(r=>JSON.parse(String(r.body)) as Job);
    return {total,offset,limit,items};
  }
  readyTasks(time: string): Task[] { return this.db.prepare("SELECT body FROM tasks WHERE user_id=? AND state='QUEUED' AND run_after<=? ORDER BY priority DESC,rowid LIMIT 100").all(USER_ID,time).map(r=>JSON.parse(String(r.body)) as Task); }
  acquireAccountLock(accountId: string,owner: string,lease: string,time: string): boolean {
    const result=this.db.prepare('INSERT INTO account_locks VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until WHERE account_locks.lease_until<=?').run(accountId,owner,lease,time);
    return Number(result.changes)>0;
  }
  extendAccountLock(accountId: string,owner: string,lease: string) {this.db.prepare('UPDATE account_locks SET lease_until=? WHERE account_id=? AND owner=?').run(lease,accountId,owner);}
  releaseAccountLock(accountId: string,owner: string) {this.db.prepare('DELETE FROM account_locks WHERE account_id=? AND owner=?').run(accountId,owner);}
  expireAccountLocks(time: string) {this.db.prepare('DELETE FROM account_locks WHERE lease_until<=?').run(time);}
  async backup(destination: string) { mkdirSync(dirname(destination), {recursive: true, mode: 0o700}); await backup(this.db, destination); }
  close() { if (!this.closed) {this.db.close();this.closed=true;} }
}
