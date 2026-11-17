import test from 'node:test';
import assert from 'node:assert/strict';
import opentype from 'opentype.js';
import { decodeSalaryFont } from '../../scripts/research/salary-font-decoder.js';

function fixture(options: { rotation?: number; references?: boolean; ambiguous?: boolean; unmatched?: boolean } = {}) {
  const path = (digit: number) => {
    const result = new opentype.Path();
    result.moveTo(0, 0); result.lineTo(300, 0); result.lineTo(200 + digit * 7, 700); result.close();
    return result;
  };
  const glyphs = [new opentype.Glyph({ name: '.notdef', advanceWidth: 600, path: new opentype.Path() })];
  if (options.references !== false) for (let digit = 0; digit < 10; digit++) {
    glyphs.push(new opentype.Glyph({ name: `digit${digit}`, unicode: 48 + digit, advanceWidth: 600, path: path(options.ambiguous && digit === 2 ? 1 : digit) }));
  }
  const code = (digit: number) => 0xE010 + (digit + (options.rotation ?? 0)) % 10;
  for (let digit = 0; digit < 10; digit++) glyphs.push(new opentype.Glyph({ name: `private${digit}`, unicode: code(digit), advanceWidth: 600, path: path(options.unmatched && digit === 1 ? 30 : digit) }));
  const font = new opentype.Font({ familyName: 'SyntheticResearch', styleName: 'Regular', unitsPerEm: 1000, ascender: 800, descender: -200, glyphs });
  return { bytes: new Uint8Array(font.toArrayBuffer()), encode: (raw: string) => raw.replace(/\d/g, digit => String.fromCharCode(code(Number(digit)))) };
}

test('font experiment decodes same-font outlines, preserving decimals, units and ordinary digits', () => {
  const font = fixture();
  for (const salary of ['15-25K·13薪', '12.5-20K', '100-200元/天', '20-30万/年']) {
    const raw = font.encode(salary);
    const result = decodeSalaryFont(raw, font.bytes);
    assert.equal(result.status, 'DECODED'); assert.equal(result.salary, salary); assert.equal(result.raw, raw);
  }
  assert.equal(decodeSalaryFont(`${font.encode('15')}-25K·13薪`, font.bytes).salary, '15-25K·13薪');
  const padded = Buffer.concat([Buffer.from('prefix'), Buffer.from(font.bytes), Buffer.from('suffix')]);
  assert.equal(decodeSalaryFont(font.encode('15K'), padded.subarray(6, padded.length - 6)).salary, '15K');
});

test('font rotation recomputes from bytes rather than using old codepoint mappings', () => {
  const first = fixture(), next = fixture({ rotation: 3 });
  const raw = first.encode('15-25K');
  const before = decodeSalaryFont(raw, first.bytes), after = decodeSalaryFont(raw, next.bytes);
  assert.equal(before.salary, '15-25K'); assert.equal(after.salary, '82-92K');
  assert.notEqual(before.font_sha256, after.font_sha256);
  assert.equal(decodeSalaryFont(next.encode('15-25K'), next.bytes).salary, '15-25K');
});

test('missing references, ambiguous shapes and incomplete mapping never yield a salary', () => {
  for (const [options, expected] of [[{ references: false }, 'NO_REFERENCE'], [{ ambiguous: true }, 'AMBIGUOUS'], [{ unmatched: true }, 'UNMATCHED']] as const) {
    const font = fixture(options), raw = font.encode('15-25K');
    const result = decodeSalaryFont(raw, font.bytes);
    assert.equal(result.status, expected); assert.equal(result.salary, undefined); assert.equal(result.raw, raw);
  }
});

test('font experiment rejects unsupported WOFF2, malformed bytes and invalid inputs', () => {
  const font = fixture(), raw = font.encode('15K');
  assert.equal(decodeSalaryFont(raw, Buffer.from('wOF2abcdefgh')).status, 'UNSUPPORTED');
  assert.equal(decodeSalaryFont(raw, Buffer.from('OTTOabcdefgh')).status, 'INVALID');
  assert.equal(decodeSalaryFont(raw, new Uint8Array(1024 * 1024 + 1)).status, 'INVALID');
  assert.equal(decodeSalaryFont(font.encode('15'), font.bytes).status, 'INVALID');
  assert.equal(decodeSalaryFont('15K', font.bytes).status, 'INVALID');
});
