/** Offline feasibility experiment. Not connected to browser reads or saved jobs.
 * The caller must establish which font actually rendered the salary before this
 * can be used in production. A decoded string alone is not that evidence.
 */
import { createHash } from 'node:crypto';
import opentype, { type Glyph } from 'opentype.js';

export type FontSalaryResult = {
  status: 'DECODED' | 'NO_REFERENCE' | 'AMBIGUOUS' | 'UNMATCHED' | 'UNSUPPORTED' | 'INVALID';
  raw: string;
  font_sha256: string;
  salary?: string;
};
const isPrivate = (character: string) => /^[\uE000-\uF8FF]$/u.test(character);
const MAX_FONT_BYTES = 1024 * 1024;

function outline(glyph: Glyph): string | null {
  const commands = glyph.path.commands;
  if (commands.length < 3 || commands.length > 2000) return null;
  const points: [number, number][] = [];
  for (const command of commands) {
    if ('x' in command) points.push([command.x, command.y]);
    if ('x1' in command) points.push([command.x1, command.y1]);
    if ('x2' in command) points.push([command.x2, command.y2]);
  }
  if (points.length < 3 || points.some(point => point.some(value => !Number.isFinite(value)))) return null;
  const left = Math.min(...points.map(point => point[0]));
  const bottom = Math.min(...points.map(point => point[1]));
  const span = Math.max(Math.max(...points.map(point => point[0])) - left, Math.max(...points.map(point => point[1])) - bottom);
  if (!(span > 0)) return null;
  // Preserve operators, control points and aspect ratio. No coarse rounding:
  // uncertain near matches fail rather than silently collapsing different digits.
  return JSON.stringify(commands.map(command => {
    const normalized: (number | string)[] = [command.type];
    if ('x' in command) normalized.push((command.x - left) / span, (command.y - bottom) / span);
    if ('x1' in command) normalized.push((command.x1 - left) / span, (command.y1 - bottom) / span);
    if ('x2' in command) normalized.push((command.x2 - left) / span, (command.y2 - bottom) / span);
    return normalized;
  }));
}

export function decodeSalaryFont(raw: string, bytes: Uint8Array): FontSalaryResult {
  const font_sha256 = createHash('sha256').update(bytes).digest('hex');
  const failure = (status: FontSalaryResult['status']): FontSalaryResult => ({ status, raw, font_sha256 });
  if (!raw || raw.length > 200 || bytes.length < 12 || bytes.length > MAX_FONT_BYTES) return failure('INVALID');
  const privateCharacters = [...new Set([...raw].filter(isPrivate))];
  if (!privateCharacters.length || !/(?:[Kk]|万|千|元|薪)/u.test(raw)) return failure('INVALID');
  const signature = Buffer.from(bytes.subarray(0, 4)).toString('latin1');
  if (signature === 'wOF2') return failure('UNSUPPORTED');
  if (!['OTTO', 'wOFF', '\x00\x01\x00\x00', 'true'].includes(signature)) return failure('UNSUPPORTED');
  try {
    // Copy exactly this byte range, not the entire backing buffer of a Node Buffer.
    const font = opentype.parse(Uint8Array.from(bytes).buffer);
    if (font.glyphs.length > 4096) return failure('INVALID');
    const references = new Map<string, string[]>();
    for (const digit of '0123456789') {
      if (!font.charToGlyphIndex(digit)) return failure('NO_REFERENCE');
      const shape = outline(font.charToGlyph(digit));
      if (!shape) return failure('NO_REFERENCE');
      references.set(shape, [...(references.get(shape) ?? []), digit]);
    }
    const mapping = new Map<string, string>();
    for (const character of privateCharacters) {
      if (!font.charToGlyphIndex(character)) return failure('UNMATCHED');
      const shape = outline(font.charToGlyph(character));
      const matches = shape ? references.get(shape) : undefined;
      if (!matches?.length) return failure('UNMATCHED');
      if (matches.length !== 1) return failure('AMBIGUOUS');
      mapping.set(character, matches[0]!);
    }
    const salary = [...raw].map(character => mapping.get(character) ?? character).join('');
    if ([...salary].some(isPrivate) || !/\d/.test(salary)) return failure('UNMATCHED');
    return { status: 'DECODED', raw, salary, font_sha256 };
  } catch {
    return failure('INVALID');
  }
}
