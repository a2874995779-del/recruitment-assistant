import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function runtimeDirectory() {
  const directory = resolve(process.env.RA_DATA_DIR ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'share'), 'RecruitmentAssistant'));
  const workspaceRelative = relative(process.cwd(), directory);
  if (workspaceRelative === '' || (!workspaceRelative.startsWith('..') && !isAbsolute(workspaceRelative))) throw new Error('运行数据目录必须位于源码目录之外');
  const fresh = !existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32' && fresh) {
    const principal = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    const acl = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${principal}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { windowsHide: true });
    if (acl.status !== 0) throw new Error('无法设置私有运行目录权限');
  } else if (process.platform !== 'win32') chmodSync(directory, 0o700);
  for (const folder of ['database','resumes','sessions','logs','evidence','backups','mock-external']) mkdirSync(join(directory, folder), { recursive: true, mode: 0o700 });
  return directory;
}
export function apiToken(directory: string) {
  if (process.env.RA_API_TOKEN) {
    if (process.env.RA_API_TOKEN.length < 32) throw new Error('RA_API_TOKEN 至少 32 字符');
    return process.env.RA_API_TOKEN;
  }
  const file = join(directory, 'api-token');
  if (existsSync(file)) { const token = readFileSync(file, 'utf8').trim(); if (token.length < 32) throw new Error('本地 API 令牌文件不合法'); return token; }
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, token, {mode: 0o600, flag: 'wx'}); return token;
}
