// Unit check: sideOfChar honors symSide for symbols; roman numerals are CN-side.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(__dirname + '/../com.figmatoolbox.ps/jsx/host.jsx', 'utf8');
function grab(name) {
  const re = new RegExp('    function ' + name + '\\([\\s\\S]*?\\n    }', 'm');
  const g = src.match(re);
  return g ? g[0] : null;
}
const code = [grab('isCJK'), grab('isUniRomanCN'), grab('isRomanLetter'), grab('isAsciiRomanAt'), grab('romanValue'), grab('asciiRomanShape'), grab('isSymbolChar'), grab('sideOfCharCtx'), grab('sideOfChar')].filter(Boolean).join('\n');
if (!code.includes('sideOfChar')) { console.log('GRAB FAILED'); process.exit(1); }
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code + '\nfunction sideOf(ch, m){ return sideOfChar(ch, m); }', sandbox);

let pass = 0, fail = 0;
function check(cond, name) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}
const side = (ch, m) => vm.runInContext(`sideOf(${JSON.stringify(ch)}, ${JSON.stringify(m)})`, sandbox) ? 'CN' : 'EN';
const sideCtx = (ch, t, i) => vm.runInContext(`sideOfCharCtx(${JSON.stringify(ch)}, null, ${JSON.stringify(t)}, ${i})`, sandbox) ? 'CN' : 'EN';

// halfwidth symbols
check(side('(', 'auto') === 'CN', 'halfwidth ( auto -> CN (v4.6 default: symbols ride with CN)');
check(side('(', 'cn') === 'CN', 'halfwidth ( cn -> CN (switch honored)');
check(side('(', 'en') === 'EN', 'halfwidth ( en -> EN');
// fullwidth symbols
check(side('（', 'auto') === 'CN', 'fullwidth （ auto -> CN');
check(side('（', 'en') === 'EN', 'fullwidth （ en -> EN (switch honored)');
// letters/digits never move
check(side('H', 'cn') === 'EN', 'latin H cn -> still EN');
check(side('中', 'en') === 'CN', 'ideograph en -> still CN');
// roman numerals now default to the Chinese side (Chinese fonts carry the glyphs)
check(side('Ⅰ', 'auto') === 'CN', 'roman Ⅰ auto -> CN');
check(side('Ⅷ', 'auto') === 'CN', 'roman Ⅷ auto -> CN');
check(side('Ⅱ', 'cn') === 'CN', 'roman Ⅱ cn -> CN');
check(side('Ⅱ', 'en') === 'CN', 'roman Ⅱ en -> CN (spec §6: roman priority beats the symbol switch)');
// ASCII roman: contextual rules (spec §5)
check(side('X', 'auto') === 'EN', 'lone X without CJK context stays EN (lone-letter rule)');
check(side('M', 'auto') === 'EN', 'M alone stays EN');
{
  const t = '第XIV章';
  check(sideCtx('X', t, 1) === 'CN', 'XIV inside CJK context -> CN');
}
{
  const t = 'SKU-IV-A';
  check(sideCtx('I', t, 4) === 'EN', 'IV inside SKU-IV-A code stays EN (hyphen rule)');
}
{
  const t = 'MIX';
  check(sideCtx('I', t, 1) === 'EN', 'MIX stays EN (value/ambiguity rule)');
}
{
  const t = 'XXVI';
  check(sideCtx('I', t, 3) === 'EN', 'XXVI stays EN (value > 25)');
}

console.log('\n' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
