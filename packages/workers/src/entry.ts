import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerCommand } from './client.js';

// This file represents a mock external platform. It has no access to the main database.
// Its durable receipts survive a crash between external submission and local acknowledgement.
process.once('message', (command: WorkerCommand) => {
  try {
    if (!['execute','verify'].includes(command.kind) || command.input.job.mode !== 'MOCK') throw new Error('MOCK_ONLY');
    mkdirSync(command.directory, {recursive: true, mode: 0o700});
    const db = new DatabaseSync(join(command.directory, 'receipts.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS receipts(action_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, type TEXT NOT NULL, reference TEXT NOT NULL, created_at TEXT NOT NULL)');
    const { input } = command;
    let result;
    if (command.kind === 'execute') {
      const scenario = input.job.extra.mock_scenario;
      if (scenario === 'timeout_unknown') throw new Error('SIMULATED_TIMEOUT_NO_RECEIPT');
      db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?)').run(input.action_id, input.account_id, input.type, `mock:${input.action_id}`, new Date().toISOString());
      db.close();
      if (scenario === 'timeout_after_submit') throw new Error('SIMULATED_TIMEOUT_AFTER_SUBMIT');
      result = { reference: `mock:${input.action_id}` };
    } else {
      const receipt = db.prepare('SELECT * FROM receipts WHERE action_id=? AND account_id=? AND type=?').get(input.action_id, input.account_id, input.type);
      result = receipt ? {status: 'SUCCEEDED', evidence: `模拟平台持久化记录 ${String(receipt.reference)}`, reason: null}
        : {status: 'UNKNOWN', evidence: null, reason: '模拟来源没有可核实的成功或明确失败信号'};
      db.close();
    }
    process.send?.({ok: true, result});
  } catch (error) { process.send?.({ok: false, error: error instanceof Error ? error.message : 'WORKER_ERROR'}); }
});
