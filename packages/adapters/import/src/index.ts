import { createHash } from 'node:crypto';
export function stableHash(value: unknown) {
  const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,normalize(x)])) : v;
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}
export function csvCell(value: unknown) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
