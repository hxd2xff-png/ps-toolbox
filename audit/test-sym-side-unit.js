// Unit check: sideOfChar honors symSide for symbols; roman numerals are CN-side.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(__dirname + '/../com.figmatoolbox.ps/jsx/host.jsx', 'utf8');
function grab(name) {
  const re = new RegExp('    function ' + name + '\\([\\s\\S]*?\\n    }', 'm');
  const g = src.match(re);
  return g ? g[0] : null;
}
const code = [grab('isCJK'), grab('isSymbolChar'), grab('sideOfChar')].filter(Boolean).join('\n');
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
check(side('Ⅱ', 'en') === 'EN', 'roman Ⅱ en -> EN (explicit switch still wins)');

console.log('\n' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
