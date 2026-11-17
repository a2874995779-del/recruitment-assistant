import opentype from 'opentype.js';
import { createHash } from 'node:crypto';
import { decodeSalaryFont } from './salary-font-decoder.js';

// This URL was found in the public Wuhan SEO page's stylesheet, 2026-10-12.
// It is not evidence of the font in a user's logged-in search page.
const url = 'https://img.bosszhipin.com/static/file/2022/16a48d9v961651026858984.ttf';
const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
if (!response.ok || !response.body) throw new Error(`Public sample unavailable: ${response.status}`);
const chunks: Uint8Array[] = [];
let size = 0;
for await (const chunk of response.body) {
  size += chunk.length;
  if (size > 1024 * 1024) throw new Error('Public sample exceeds 1 MiB research limit');
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
const font = opentype.parse(Uint8Array.from(bytes).buffer);
const privateCharacters: string[] = [];
for (let code = 0xE000; code <= 0xF8FF; code++) {
  const character = String.fromCharCode(code);
  if (font.charToGlyphIndex(character)) privateCharacters.push(character);
}
const statuses: Record<string, number> = {};
// Probe only a bounded subset; this is a font compatibility check, not salaries.
for (const character of privateCharacters.slice(0, 16)) {
  const status = decodeSalaryFont(`${character}K`, bytes).status;
  statuses[status] = (statuses[status] ?? 0) + 1;
}
console.log(JSON.stringify({ source: url, public_seo_sample_only: true, bytes: bytes.length, glyphs: font.glyphs.length,
  ascii_digits: [...'0123456789'].filter(digit => font.charToGlyphIndex(digit)).length,
  private_characters: privateCharacters.length, probed: Math.min(privateCharacters.length, 16), statuses,
  font_sha256: createHash('sha256').update(bytes).digest('hex') }, null, 2));
