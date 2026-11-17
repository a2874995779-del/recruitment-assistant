import { join } from 'node:path';
import type { Account, ActionType, Job, Message, Platform } from '../../../contracts/src/index.js';
import { jobInput } from '../../../contracts/src/index.js';
import type { Capability, CapabilityName, ExecutionInput, PlatformAdapter, Verification } from '../../core/src/index.js';
import { runIsolated } from '../../../workers/src/client.js';

export class MockAdapter implements PlatformAdapter {
  adapter_version = '0.1.0'; contract_version = 1;
  constructor(public platform_id: Platform, private directory: string) {}
  describeCapabilities(): Capability[] {
    return (['login','jobs','messages','profile','GREETING','SEND_RESUME','APPLY','EXTERNAL_APPLICATION','verify'] as CapabilityName[]).map(name => ({name, status: name === 'EXTERNAL_APPLICATION' ? 'UNSUPPORTED' : 'VERIFIED', enabled: name !== 'EXTERNAL_APPLICATION', verified_at: '2026-10-09T00:00:00.000Z', limitation: '仅模拟；不代表真实平台能力，绝不访问招聘网站', mode: 'MOCK'}));
  }
  async connectAccount(account: Account) { return {status: 'CONNECTED' as const, identity: `mock-user:${account.id}`, instruction: '模拟账号已连接；未登录真实招聘平台'}; }
  async checkSession(account: Account) { return account.status; }
  async syncProfile(_account: Account) { return {education: '本科', major: '计算机科学与技术', graduation_year: 2027}; }
  async searchJobs(account: Account, query: { keywords: string; cities: string[]; budget: number }, cursor: string | null) {
    const jobs = [
      {title: '[模拟] 后端开发工程师', salary_min: 12000, salary_max: 20000},
      {title: '[模拟] 校招软件工程师', salary_raw: '面议', salary_min: null, salary_max: null, recruitment_type: 'CAMPUS', majors: null, graduation_years: null},
      {title: '[模拟] 企业官网申请岗位', apply_target: {kind: 'EXTERNAL', url: 'https://careers.example.com/apply'}},
      {title: '[模拟] 数据开发工程师', salary_raw: '8K-15K/月', salary_min: 8000, salary_max: 15000}
    ].map((overrides, i) => jobInput.parse({
      external_job_id: `sample-${i + 1}`, source_instance_id: `mock:${account.id}`, source_url: `https://mock.example.com/${this.platform_id}/jobs/${i + 1}`,
      platform: this.platform_id, mode: 'MOCK', company_name: '[模拟] 示例科技公司', locations: ['武汉'],
      salary_raw: '12K-20K/月', salary_min: 12000, salary_max: 20000, currency: 'CNY', salary_period: 'MONTH', salary_months: 12,
      education: '本科', experience_range: [0, 3], majors: ['计算机科学与技术'], graduation_years: [2027],
      recruitment_type: 'SOCIAL', employment_type: '全职', description: '仅用于本地开发验收的模拟数据。',
      published_at: null, status: 'ACTIVE', apply_target: { kind: 'IN_PLATFORM', url: null }, ...overrides
    })).filter(j => (!query.keywords || j.title.includes(query.keywords)) && (!query.cities.length || query.cities.some(city => j.locations?.includes(city))));
    const offset = cursor?.startsWith('page:') ? Number(cursor.slice(5)) : 0;
    const page = jobs.slice(offset, offset + query.budget);
    return { jobs: page, next_cursor: offset + page.length < jobs.length ? `page:${offset + page.length}` : 'cycle:complete' };
  }
  async fetchJobDetail(job: Job) { return jobInput.parse(Object.fromEntries(Object.entries(job).filter(([key]) => !['id','user_id','schema_version','content_hash','first_seen_at','last_seen_at','last_verified_at'].includes(key)))); }
  async syncApplications(_account: Account, cursor: string | null) { return { records: [], next_cursor: cursor }; }
  async syncMessages(account: Account, cursor: string | null) {
    const message: Omit<Message,'id'|'user_id'|'dedupe_key'|'observed_at'|'local_read'> = {
      account_id: account.id, source_message_id: cursor ? 'new-1' : 'history-1', conversation_id: 'mock-conversation', sender: '[模拟] 招聘方',
      body: cursor ? '[模拟] 您好，请查看原平台的面试邀请。' : '[模拟] 历史消息，不产生逐条通知。', coverage: 'FULL_TEXT', unread_count: null,
      source_sent_at: null, source_url: 'https://mock.example.com/messages', uncertain: false, mode: 'MOCK'
    };
    return {messages: [message], next_cursor: 'messages:live'};
  }
  async prepareApplication(_account: Account, job: Job, type: ActionType) { return job.apply_target.kind !== 'IN_PLATFORM' || type === 'EXTERNAL_APPLICATION' ? ['外链网申/未知入口需要用户人工完成，跳转不计成功'] : []; }
  async executeAction(input: ExecutionInput) { return await runIsolated({ kind: 'execute', directory: join(this.directory, 'mock-external'), input }) as {reference: string}; }
  async verifyAction(input: ExecutionInput) { return await runIsolated({ kind: 'verify', directory: join(this.directory, 'mock-external'), input }) as Verification; }
  async disconnectAccount(_account: Account) {}
}
