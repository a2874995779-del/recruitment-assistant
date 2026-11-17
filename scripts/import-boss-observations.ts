import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { jobInput } from '../packages/contracts/src/index.js';

// Imports saved public observations into the loopback backend. This script has no
// browser control, platform credentials, message sending or external network calls.
const port = Number(process.argv[2] ?? 4322);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('请指定本机预览端口');
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error('缺少 LOCALAPPDATA');
const directory = port === 4319 ? 'RecruitmentAssistantPreview' : `RecruitmentAssistantPreview-${port}`;
const token = readFileSync(join(localAppData, directory, 'api-token'), 'utf8').trim();
const jobs = z.array(jobInput).min(1).parse(JSON.parse(readFileSync(resolve('config/templates/boss-readonly-observations.json'), 'utf8')));
if (jobs.some(job => job.platform !== 'boss' || job.mode !== 'IMPORT' || job.status !== 'UNVERIFIED')) throw new Error('本脚本仅导入未核实的 BOSS 手动观察样本');
const response = await fetch(`http://127.0.0.1:${port}/api/v1/jobs/import`, {
  method: 'POST', headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'},
  body: JSON.stringify(jobs), signal: AbortSignal.timeout(5000),
});
if (!response.ok) throw new Error(`本机导入失败 (${response.status})`);
const imported = await response.json() as {id: string}[];
console.log(JSON.stringify({count: imported.length, platform: 'boss', mode: 'IMPORT', communication: 'NOT_EXECUTED'}));
