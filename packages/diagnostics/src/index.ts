import { randomUUID } from 'node:crypto';
import type { Repository } from '../../persistence/src/repository.js';
export function audit(store: Repository, type: string, entityId: string, details: Record<string, unknown> = {}) {
  // Only explicitly approved scalar metadata enters diagnostics. Never serialize a request body.
  const allow = ['code','status','mode','rule_version','count','adapter_version','contract_version'];
  const safe = Object.fromEntries(Object.entries(details).filter(([key, value]) => allow.includes(key) && ['string','number','boolean'].includes(typeof value)));
  store.put('audit', {id: randomUUID(), type, entity_id: entityId, details: safe, created_at: new Date().toISOString()});
}
