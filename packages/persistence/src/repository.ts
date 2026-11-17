import type { Store } from './database.js';
// Structural contract: alternate implementations need the same transactional semantics,
// scoped uniqueness and durable lease operations. The application cannot access raw SQLite.
export interface Repository extends Omit<Store,'db'|'filename'> {}
