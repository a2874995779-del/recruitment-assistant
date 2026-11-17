import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExecutionInput, Verification } from '../../adapters/core/src/index.js';

export type WorkerCommand = { kind: 'execute' | 'verify'; directory: string; input: ExecutionInput };
export function runIsolated(command: WorkerCommand): Promise<{reference: string} | Verification> {
  return new Promise((resolve, reject) => {
    const js = fileURLToPath(new URL('./entry.js', import.meta.url));
    const entry = existsSync(js) ? js : fileURLToPath(new URL('./entry.ts', import.meta.url));
    const child = fork(entry, [], { stdio: ['ignore','ignore','pipe','ipc'], windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, execArgv: process.execArgv });
    const timeout = setTimeout(() => { child.kill(); reject(new Error('WORKER_TIMEOUT')); }, 10000);
    let settled = false;
    child.once('message', (result: {ok: boolean; result?: {reference: string} | Verification; error?: string}) => {
      settled = true; clearTimeout(timeout); child.disconnect();
      if (result.ok && result.result) resolve(result.result); else reject(new Error(result.error ?? 'WORKER_ERROR'));
    });
    child.once('error', error => { clearTimeout(timeout); settled = true; reject(error); });
    child.once('exit', code => { if (!settled) {clearTimeout(timeout); reject(new Error(`WORKER_EXIT_${code}`));} });
    child.send(command);
  });
}
