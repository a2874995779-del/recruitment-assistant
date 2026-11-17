import type { PlatformAdapter, Capability, CapabilityName, ExecutionInput } from './index.js';
import type { Account, ActionType, Job, Platform } from '../../../contracts/src/index.js';
import { AppError } from '../../../domain/src/errors.js';

export class UnverifiedAdapter implements PlatformAdapter {
  adapter_version = '0.1.0'; contract_version = 1;
  constructor(public platform_id: Platform) {}
  describeCapabilities(): Capability[] {
    return (['login','jobs','messages','profile','GREETING','SEND_RESUME','APPLY','EXTERNAL_APPLICATION','verify'] as CapabilityName[]).map(name => ({ name, status: 'UNVERIFIED', enabled: false, verified_at: null, limitation: '尚未完成授权路径和真实平台验证；请在原平台人工操作', mode: 'REAL' }));
  }
  async connectAccount(_account: Account) { return {status: 'ACTION_REQUIRED' as const, identity: null, instruction: '真实登录和自动操作尚未接通；需验证授权路径、原站手动登录及身份后启用'}; }
  async checkSession(_account: Account) { return 'ACTION_REQUIRED' as const; }
  private unavailable(): never { throw new AppError('CAPABILITY_UNVERIFIED', '真实平台能力待验证，当前仅支持模拟闭环和手动导入', 409); }
  async syncProfile(_account: Account): Promise<never> { return this.unavailable(); }
  async searchJobs(): Promise<never> { return this.unavailable(); }
  async fetchJobDetail(): Promise<never> { return this.unavailable(); }
  async syncApplications(): Promise<never> { return this.unavailable(); }
  async syncMessages(): Promise<never> { return this.unavailable(); }
  async prepareApplication(_account: Account, _job: Job, _type: ActionType) { return ['真实提交能力待验证，请在原平台处理']; }
  async executeAction(_input: ExecutionInput): Promise<never> { return this.unavailable(); }
  async verifyAction(_input: ExecutionInput) { return { status: 'UNKNOWN' as const, evidence: null, reason: '没有已验证的真实结果读取能力' }; }
  async disconnectAccount(_account: Account) {}
}
