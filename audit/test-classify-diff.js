// Diff harness: Figma reference classification (per the MD) vs PS host classification.
// Key difference: the Figma reference splits ASCII-roman tokens via a RomanOpener
// that treats a VALID token as one opener unit (its letters are styled together),
// while surrounding whitespace/-/_ stay English. The PS host is char-based, so it
// must reproduce the same per-character RESULT: a char belongs to the roman token
// (CN) only when it is a roman LETTER INSIDE a qualifying token. Whitespace,
// hyphens and underscores around it never become CN.
const fs = require('fs'), vm = require('vm');

// ---- Figma reference (font-mixer.ts, verbatim logic) ----
const figmaSrc = `
function isCJK(ch) {
  return /[\\u3000-\\u303F\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\u3040-\\u30FF\\uFF00-\\uFFEF]/.test(ch);
}
function isSymbol(ch) {
  return /[\\p{P}\\p{S}]/u.test(ch);
}
function isRomanNumeral(ch) {
  return /[\\u2160-\\u216B\\u2170-\\u217B]/u.test(ch);
}
const ASCII_ROMAN_TOKEN = /^(?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))$/;
function romanValue(token) {
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < token.length; i++) {
    const value = values[token[i]] || 0;
    const next = values[token[i + 1]] || 0;
    total += value < next ? -value : value;
  }
  return total;
}
function isAsciiRomanNumeralAt(text, index) {
  if (!/[IVXLCDM]/.test(text[index] || '')) return false;
  let start = index;
  while (start > 0 && /[IVXLCDM]/.test(text[start - 1])) start--;
  let end = index + 1;
  while (end < text.length && /[IVXLCDM]/.test(text[end])) end++;
  const token = text.slice(start, end);
  if (!ASCII_ROMAN_TOKEN.test(token) || !/[IVX]/.test(token)) return false;
  if (romanValue(token) > 25) return false;
  const prev = start > 0 ? text[start - 1] : '';
  const next = end < text.length ? text[end] : '';
  if (/[A-Za-z0-9_-]/.test(prev) || /[A-Za-z0-9_-]/.test(next)) return false;
  if (token.length === 1 && !isCJK(prev) && !isCJK(next)) return false;
  return true;
}
function isChineseSide(ch, symbolFontSide) {
  if (isRomanNumeral(ch)) return true;
  if (symbolFontSide && isSymbol(ch)) return symbolFontSide === 'cn';
  return isCJK(ch);
}
function isChineseSideAt(text, index, symbolFontSide) {
  const ch = String.fromCodePoint(text.codePointAt(index));
  if (isRomanNumeral(ch) || isAsciiRomanNumeralAt(text, index)) return true;
  return isChineseSide(ch, symbolFontSide);
}
`;

// ---- PS host (grabbed from host.jsx) ----
const hostSrc = fs.readFileSync(__dirname + '/../com.figmatoolbox.ps/jsx/host.jsx', 'utf8');
function grab(name) {
  const re = new RegExp('    function ' + name + '\\([\\s\\S]*?\\n    }', 'm');
  const g = hostSrc.match(re);
  return g ? g[0] : null;
}
const hostCode = ['isCJK', 'isUniRomanCN', 'isRomanLetter', 'isAsciiRomanAt', 'romanValue',
  'asciiRomanShape', 'isSymbolChar', 'isBlankChar', 'sideOfCharCtx', 'sideOfChar'].map(grab).filter(Boolean).join('\n');

const fig = {};
vm.createContext(fig); vm.runInContext(figmaSrc, fig);
const host = {};
vm.createContext(host); vm.runInContext(hostCode, host);

const figSide = (text, i, sym) => vm.runInContext(`isChineseSideAt(${JSON.stringify(text)}, ${i}, ${JSON.stringify(sym)})`, fig);
const hostSide = (text, i, sym) => vm.runInContext(`sideOfCharCtx(${JSON.stringify(text.charAt(i))}, ${JSON.stringify(sym)}, ${JSON.stringify(text)}, ${i})`, host);

const cases = [
  '中文', '粉底液', 'かなカナ', '（中文）',
  'ABC', '10MLX2', 'SKU-IV-A', 'MIX123', 'MIX', 'XXVI', 'XXV', 'I',
  'A IV B', '第XIV章',
  'Ⅰ', 'Ⅳ', 'Ⅻ', 'ⅰⅱⅲ', 'ⅬⅭⅮⅯ', 'ↀ',
  'IV_CODE',
  '买就送价值¥120迷你唇膏', '哑光「大子弹头」Ⅰ', '24HⅡ', '气垫Ⅰ',
  '第XIV章 A IV B MIX XXVI 10MLX2 SKU-IV-A',
  'Ⅰ Ⅱ Ⅲ', 'A I B', 'XXV XXVI',
  // symbol switch states over a mixed line
  ['（中文）A-1（完）', 'cn'], ['（中文）A-1（完）', 'en'],
];

let mism = 0;
for (const c of cases) {
  const text = Array.isArray(c) ? c[0] : c;
  const sym = Array.isArray(c) ? c[1] : null;
  for (let i = 0; i < text.length; i++) {
    const a = figSide(text, i, sym);
    const b = hostSide(text, i, sym);
    if (a !== b) {
      mism++;
      console.log('MISMATCH', JSON.stringify(text), 'idx', i, JSON.stringify(text.charAt(i)),
        'figma=', a ? 'CN' : 'EN', 'host=', b ? 'CN' : 'EN');
    }
  }
}
console.log(mism === 0 ? '\nALL CHAR CLASSIFICATIONS MATCH THE FIGMA REFERENCE' : '\n' + mism + ' mismatch(es)');
process.exit(mism ? 1 : 0);
