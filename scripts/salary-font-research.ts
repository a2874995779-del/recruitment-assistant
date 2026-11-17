import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import opentype from 'opentype.js';
import { salaryFontFixture } from './salary-font-fixture.js';
import { decodeSalaryFont } from './research/salary-font-decoder.js';

// Use this machine's Arial solely in memory. Neither font files nor glyph data
// are written to the repo, and this script never opens BOSS or sends requests.
const bytes = readFileSync(join(process.env.WINDIR ?? 'C:/Windows', 'Fonts', 'arial.ttf'));
const source = opentype.parse(Uint8Array.from(bytes).buffer);
function sample(rotation: number) {
  const glyphs = [new opentype.Glyph({ name: '.notdef', advanceWidth: 600, path: source.glyphs.get(0).path })];
  const code = (digit: number) => 0xE010 + (digit * 7 + rotation) % 10;
  for (let digit = 0; digit < 10; digit++) {
    const original = source.charToGlyph(String(digit));
    for (const [name, unicode] of [[`digit${digit}`, 48 + digit], [`private${digit}`, code(digit)]] as const) {
      glyphs.push(new opentype.Glyph({ name, unicode, advanceWidth: original.advanceWidth, path: original.path }));
    }
  }
  const font = new opentype.Font({ familyName: 'LocalOutlineResearch', styleName: 'Regular', unitsPerEm: source.unitsPerEm, ascender: source.ascender, descender: source.descender, glyphs });
  return { bytes: new Uint8Array(font.toArrayBuffer()), encode: (raw: string) => raw.replace(/\d/g, digit => String.fromCharCode(code(Number(digit)))) };
}
const first = sample(0), rotated = sample(3);
const reports = [];
for (const [label, font] of [['local Arial', first], ['rotated local Arial', rotated]] as const) {
  for (const salary of ['15-25K·13薪', '12.5-20K', '100-200元/天', '20-30万/年']) {
    const result = decodeSalaryFont(font.encode(salary), font.bytes);
    assert.equal(result.status, 'DECODED'); assert.equal(result.salary, salary);
    reports.push({ sample: label, status: result.status, salary: result.salary, font_sha256: result.font_sha256 });
  }
}
assert.notEqual(reports[0]!.font_sha256, reports[4]!.font_sha256);
const noReference = salaryFontFixture();
const rejected = decodeSalaryFont(noReference.raw, Buffer.from(noReference.base64, 'base64'));
assert.equal(rejected.status, 'NO_REFERENCE'); assert.equal(rejected.salary, undefined);
reports.push({ sample: 'PUA-only local Arial', status: rejected.status, salary: undefined, font_sha256: rejected.font_sha256 });
console.log(JSON.stringify({ experiment: 'SALARY_FONT_RESEARCH_OK', live_boss_verified: false, reports }, null, 2));
