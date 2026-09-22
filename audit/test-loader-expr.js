/* 校验面板真实构造出的两段 ExtendScript 表达式是否可解析、路径是否正确 */
const fs = require('fs');
const path = require('path');
// 相对本文件定位，任何 cwd 下都能跑（此前依赖仓库根目录，换目录即崩）
const html = fs.readFileSync(path.join(__dirname, '..', 'com.figmatoolbox.ps', 'index.html'), 'utf8');
const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()[1];
const block = inline.slice(inline.indexOf('    const CEP ='), inline.indexOf('setTimeout(() => ensureHost(), 200);'));

const sandbox = new Function(
  'window', 'cs', 'SystemPath', 'document', 'figmaNotify', 'setTimeout',
  block + '\n; return { hostLoaderExpr: hostLoaderExpr, hostCallExpr: hostCallExpr, diagLog: diagLog, HOST_EXPECT: HOST_EXPECT };'
);

const stub = {
  window: {},
  cs: {
    getSystemPath: () => 'C:\\Users\\x\\AppData\\Roaming\\Adobe\\CEP\\extensions\\com.figmatoolbox.ps',
    evalScript: () => {},
  },
  SystemPath: { EXTENSION: 'extension' },
  document: { getElementById: () => null },
  figmaNotify: () => {},
  setTimeout: () => {},
};

const api = sandbox(stub.window, stub.cs, stub.SystemPath, stub.document, stub.figmaNotify, stub.setTimeout);

const loader = api.hostLoaderExpr();
const call = api.hostCallExpr('font-mixer', '%7B%22a%22%3A1%7D');
api.diagLog('test', 'hello');

console.log('--- loader expr (len %d) ---', loader.length);
console.log(loader);
console.log('--- call expr ---');
console.log(call);
console.log('--- checks ---');
try { new Function(loader); console.log('PASS loader parses'); } catch (e) { console.log('FAIL loader parse:', e.message); }
try { new Function(call); console.log('PASS call parses'); } catch (e) { console.log('FAIL call parse:', e.message); }
console.log(/jsx[\\/]+host\.jsx/.test(loader) ? 'PASS host.jsx path present' : 'FAIL path');
console.log(loader.includes('|') ? 'PASS error line echo present' : 'FAIL error line echo');
console.log(loader.includes('65279') ? 'PASS BOM strip present' : 'FAIL BOM strip');
console.log(call.includes('__NOHOST__') ? 'PASS missing-host sentinel' : 'FAIL sentinel');
console.log(loader.includes('$.global.cephostDispatch=cephostDispatch') ? 'PASS global export' : 'FAIL global export');

/* ES3 面：加载器内部不得出现 ES5+ 语法 */
const es3bad = [
  [/\b(let|const)\b/, 'let/const'],
  [/=>/, 'arrow'],
  [/`/, 'template literal'],
  [/\?\./, 'optional chaining'],
  [/catch\s*\{/, 'catch without binding'],
  [/\.forEach\(|\.map\(|\.indexOf\(|\.filter\(/, 'ES5 array extras'],
  [/,\s*[}\]]/, 'trailing comma'],
];
for (const [re, name] of es3bad) {
  const hit = re.test(loader) || re.test(call);
  console.log((hit ? 'FAIL' : 'PASS') + ' ES3: no ' + name);
}

/* ---------- 版本守卫：真的执行那段加载器表达式 ---------- */
const hostVer = (fs.readFileSync(path.join(__dirname, '..', 'com.figmatoolbox.ps', 'jsx', 'host.jsx'), 'utf8')
  .match(/HOST_VERSION = '([^']+)'/) || [])[1];
console.log(api.HOST_EXPECT === hostVer
  ? 'PASS panel HOST_EXPECT == host.jsx HOST_VERSION (' + hostVer + ')'
  : 'FAIL version drift: panel=' + api.HOST_EXPECT + ' host=' + hostVer);

function runLoader(curVersion) {
  let fileTouched = false;
  const File = function (p) {
    fileTouched = true;
    return { exists: false, fsName: p, encoding: '', open: () => false, read: () => '' };
  };
  const cur = curVersion ? () => JSON.stringify({ pong: true, version: curVersion }) : undefined;
  const fn = new Function('cephostDispatch', '$', 'File', 'return ' + loader);
  let out;
  try { out = fn(cur, { global: cur ? { cephostDispatch: cur } : {} }, File); }
  catch (e) { out = 'THROW ' + e.message; }
  return { out: String(out), fileTouched };
}

/* 版本一致 → 直接用内存里的宿主，绝不能去读文件 */
let r1 = runLoader(hostVer);
console.log(r1.out === 'ALREADY' && !r1.fileTouched
  ? 'PASS 版本一致 → ALREADY（不读文件、不重载）'
  : 'FAIL 版本一致时行为异常: ' + r1.out + ' fileTouched=' + r1.fileTouched);

/* 版本不符（PS 启动时 ScriptPath 加载的旧宿主）→ 必须强制重载 */
let r2 = runLoader('0.0.1');
console.log(r2.fileTouched && /^ERR missing-file/.test(r2.out)
  ? 'PASS 版本不符 → 强制重载宿主（去读 jsx 文件）'
  : 'FAIL 版本不符时未重载: ' + r2.out + ' fileTouched=' + r2.fileTouched);

/* 完全没有宿主 → 同样走加载 */
let r3 = runLoader(null);
console.log(r3.fileTouched
  ? 'PASS 无宿主 → 走加载器'
  : 'FAIL 无宿主时未加载: ' + r3.out);

/* 调用侧必须优先用 $.global 上那份（可能是刚重载的新版） */
const callFn = new Function('cephostDispatch', '$', 'return ' + call);
const fromGlobal = callFn(() => 'OLD', { global: { cephostDispatch: () => '{"from":"global"}' } });
console.log(fromGlobal.indexOf('global') >= 0
  ? 'PASS 调用优先使用 $.global 上的宿主'
  : 'FAIL 调用未优先使用 $.global: ' + fromGlobal);
