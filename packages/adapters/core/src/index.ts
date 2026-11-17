import type { Account, ActionType, CapabilityStatus, Job, JobInput, Message, Platform, Profile, Station } from '../../../contracts/src/index.js';

export type CapabilityName = 'login' | 'jobs' | 'messages' | 'profile' | ActionType | 'verify';
export type Capability = { name: CapabilityName; status: CapabilityStatus; enabled: boolean; verified_at: string | null; limitation: string; mode: 'MOCK' | 'REAL' };
export type Verification = { status: 'SUCCEEDED' | 'FAILED_CONFIRMED' | 'BLOCKED' | 'UNKNOWN'; evidence: string | null; reason: string | null };
export type ExecutionInput = { action_id: string; account_id: string; type: ActionType; job: Job; resume_hash: string | null; greeting: string };
export interface PlatformAdapter {
  platform_id: Platform;
  adapter_version: string;
  contract_version: number;
  describeCapabilities(): Capability[];
  connectAccount(account: Account): Promise<{ status: Account['status']; identity: string | null; instruction: string }>;
  checkSession(account: Account): Promise<Account['status']>;
  syncProfile(account: Account): Promise<Partial<Profile>>;
  searchJobs(account: Account, query: {keywords: string; cities: string[]; budget: number}, cursor: string | null): Promise<{ jobs: JobInput[]; next_cursor: string | null }>;
  fetchJobDetail(job: Job): Promise<JobInput>;
  syncApplications(account: Account, cursor: string | null): Promise<{ records: unknown[]; next_cursor: string | null }>;
  syncMessages(account: Account, cursor: string | null): Promise<{ messages: Omit<Message,'id'|'user_id'|'dedupe_key'|'observed_at'|'local_read'>[]; next_cursor: string | null }>;
  prepareApplication(account: Account, job: Job, type: ActionType): Promise<string[]>;
  executeAction(input: ExecutionInput): Promise<{ reference: string }>;
  verifyAction(input: ExecutionInput): Promise<Verification>;
  disconnectAccount(account: Account): Promise<void>;
}
export function validateStation(platform: Platform, station?: Station) {
  if (platform === 'wllm91' && station) {
    const host = new URL(station.base_url).hostname;
    if (new URL(station.base_url).protocol !== 'https:' || !(host === '91wllm.cn' || host.endsWith('.91wllm.cn'))) throw new Error('91wllm 分站必须是 HTTPS 官方域名，其他来源请使用手动导入');
    if (Object.values(station.route_overrides).some(route => !route.startsWith('/') || route.startsWith('//') || route.includes('\\'))) throw new Error('分站路由只允许站内相对路径');
  }
  if (platform === 'boss' && station) throw new Error('BOSS 不接受学校分站配置');
}
