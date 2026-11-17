import type { Account } from '../../../contracts/src/index.js';
import { MockAdapter } from '../../mock/src/index.js';
import { BossAdapter } from '../../boss/src/index.js';
import { Wllm91Adapter } from '../../wllm91/src/index.js';
import type { PlatformAdapter } from './index.js';
export class AdapterRegistry {
  constructor(private directory: string) {}
  forAccount(account: Account): PlatformAdapter { return account.mode === 'MOCK' ? new MockAdapter(account.platform, this.directory) : account.platform === 'boss' ? new BossAdapter() : new Wllm91Adapter(); }
}
