import type { Repository } from '../../persistence/src/repository.js';
import { companyInput, sourceInput } from '../../contracts/src/index.js';
import { randomUUID } from 'node:crypto';
import { requireCondition } from '../../domain/src/errors.js';
export class SourceRegistry {
  constructor(private store: Repository) {}
  createCompany(raw: unknown) {
    const input = companyInput.parse(raw);
    if (input.parent_id) requireCondition(this.store.get('companies', input.parent_id), 'NOT_FOUND', '母公司不存在', 404);
    return this.store.put('companies', {id: randomUUID(), ...input, verified_at: input.verified ? new Date().toISOString() : null, scope: '基础目录/待扩展'});
  }
  createSource(raw: unknown) {
    const input = sourceInput.parse(raw);
    requireCondition(this.store.get('companies', input.company_id), 'NOT_FOUND', '企业不存在', 404);
    return this.store.put('sources', {id: randomUUID(), ...input, collection_enabled: false, status: input.verified ? 'USER_VERIFIED' : 'UNVERIFIED', verified_at: input.verified ? new Date().toISOString() : null});
  }
}
