// Ephemeral test font: remap Windows' local Arial digits to private-use codepoints.
// Font bytes stay in the temporary smoke process; no font asset is redistributed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import opentype from 'opentype.js';
const {parse,Glyph,Font}=opentype;
export function salaryFontFixture() {
  const bytes=readFileSync(join(process.env.WINDIR ?? 'C:/Windows','Fonts','arial.ttf'));
  const source=parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const glyphs=[new Glyph({name:'.notdef',advanceWidth:600,path:source.glyphs.get(0).path})];
  for(let digit=0;digit<10;digit++){
    const sourceGlyph=source.charToGlyph(String(digit));
    glyphs.push(new Glyph({name:`encoded${digit}`,unicode:0xE010+(digit*7)%10,advanceWidth:sourceGlyph.advanceWidth,path:sourceGlyph.path}));
  }
  const font=new Font({familyName:'LocalSalaryFixture',styleName:'Regular',unitsPerEm:source.unitsPerEm,ascender:source.ascender,descender:source.descender,glyphs});
  const encode=(digits:string)=>digits.replace(/\d/g,d=>String.fromCharCode(0xE010+(Number(d)*7)%10));
  return {base64:Buffer.from(font.toArrayBuffer()).toString('base64'),raw:`${encode('15')}-${encode('25')}K·${encode('13')}薪`};
}
