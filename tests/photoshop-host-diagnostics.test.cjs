'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const panel = fs.readFileSync(path.join(__dirname, '../com.figmatoolbox.ps/index.html'), 'utf8');
function part(a, b) {
  const start = panel.indexOf(a), end = panel.indexOf(b, start);
  assert.ok(start >= 0 && end > start, a);
  return panel.slice(start, end);
}
const diagnostics = part('    // 手动诊断：', '    // ---- 宿主自检');
const loader = part('    function hostLoaderExpr(', '    let hostReady');
const hostCall = part('    function hostCallExpr(', '    let pendingHostCalls');
function harness({ fail = '', timeout = false, ready = false, busy = false, pending = false, cep = true } = {}) {
  const output = { textContent: '' }, button = { disabled: false, addEventListener() {} };
  const calls = [], callbacks = [];
  const context = {
    document: { getElementById(id) { return id === 'host-diagnostic-output' ? output : button; } },
    evalScript(script, cb) {
      const index = calls.length;
      calls.push(script);
      if (timeout) { callbacks.push(cb); return; }
      const names = ['constant', 'environment', 'file-read', 'nested-eval', 'host-load', 'ping'];
      const replies = ['CEP_CONST_OK', 'OK|environment|app=21.0.2', 'OK|file-read|length=42', 'OK|nested-eval', 'LOADED head=47,', JSON.stringify({ pong: true, version: '4.4.5' })];
      cb(names[index] === fail ? 'EvalScript error.' : replies[index]);
    },
  };
  vm.createContext(context);
  vm.runInContext('const EXT_DIR="/fixture/with \\\"quote", HOST_EXPECT="4.4.5", CEP=' + cep + ';let hostReady=' + ready + ',hostBusy=' + busy + ',pendingHostCalls=' + (pending ? '[{}]' : '[]') + ',hostGeneration=0,preloadControlPassed=false;' + loader + hostCall + diagnostics, context);
  return { output, button, calls, callbacks, run: () => vm.runInContext('runHostDiagnostics()', context), steps: () => vm.runInContext('hostDiagnosticSteps()', context), state: () => vm.runInContext('hostDiagnosticBusy', context) };
}
test('manual diagnostics runs six stages once and never starts business requests', () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  h.run();
  assert.equal(h.calls.length, 6);
  assert.match(h.output.textContent, /诊断通过/);
  assert.equal(h.state(), false);
  assert.equal(h.button.disabled, false);
  assert.doesNotMatch(h.calls.join('\n'), /detect-font|list-fonts|selftest|f\.open\("a"\)/);
});
test('each failed stage preserves raw callback and stops later stages', () => {
  for (const [index, fail] of ['constant', 'environment', 'file-read', 'nested-eval', 'host-load', 'ping'].entries()) {
    const h = harness({ fail }); h.run();
    assert.equal(h.calls.length, index + 1);
    assert.match(h.output.textContent, /"EvalScript error\."/);
    assert.ok(h.output.textContent.includes('停止于 ' + fail));
    assert.equal(h.state(), false);
  }
});
test('timeout releases diagnostic lock, ignores duplicate click while pending', () => {
  const h = harness({ timeout: true }); h.run(); h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.button.disabled, true);
  h.callbacks[0]('EVALSCRIPT_TIMEOUT');
  assert.equal(h.calls.length, 1);
  assert.equal(h.state(), false);
  assert.equal(h.button.disabled, false);
  assert.match(h.output.textContent, /EVALSCRIPT_TIMEOUT/);
});
test('connected, connecting, pending requests and absent CEP block probes', () => {
  for (const options of [{ ready: true }, { busy: true }, { pending: true }, { cep: false }]) {
    const h = harness(options); h.run(); assert.equal(h.calls.length, 0);
  }
});
test('panel inline scripts parse and reconnect gate pauses during diagnostics', () => {
  for (const match of panel.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    if (match[1].trim()) new vm.Script(match[1]);
  }
  const gate = part('    function ensureHost(cb)', '      if (hostReady)');
  assert.match(gate, /!CEP \|\| hostDiagnosticBusy/);
});
function liveHarness(control = false) {
  const output = { textContent: '' }, button = { disabled: false, addEventListener() {} };
  const requests = [], timers = new Map(), replies = [];
  let timerId = 0;
  const context = {
    document: { getElementById(id) { return id === 'host-diagnostic-output' ? output : button; } },
    cs: { evalScript(script, cb) { requests.push({ script, cb }); } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    capture: (reply) => replies.push(reply),
  };
  vm.createContext(context);
  const run = (s) => vm.runInContext(s, context);
  run('const CEP=true,EXT_DIR="/fixture",HOST_EXPECT="4.4.5";let bridgeTimeoutMs=15000,hostReady=false,hostBusy=false,hostGeneration=0,pendingHostCalls=[],preloadControlPassed=true;const preloadControl=' + control + ';' + part('    function preloadControlLocked()', '    let bridgeTimeoutMs') +
    part('    function evalScript(script, cb, timeoutMs)', '    // 面板期望的宿主版本') + loader + hostCall + diagnostics + part('    function callHost(type, args, cb, noRetry)', '    // 对照模式'));
  return { output, button, requests, replies, run, start: () => run('runHostDiagnostics()'), expire() { const current = [...timers.values()]; timers.clear(); current.forEach((fn) => fn()); } };
}
test('production callHost blocks writes and reads while diagnostic callback is pending', () => {
  const h = liveHarness(); h.start();
  h.run('["auto-kerning","font-mixer","detect-font","sel-sig","list-fonts"].forEach(type=>callHost(type,null,capture))');
  assert.equal(h.requests.length, 1);
  assert.equal(h.replies.length, 5);
  assert.ok(h.replies.every((r) => r.stage === 'diagnostic-busy'));
  assert.equal(h.run('hostGeneration'), 0);
  h.requests[0].cb('CEP_CONST_OK');
  assert.equal(h.requests.length, 2);
});
test('connection generation change stops old diagnostic response before environment', () => {
  const h = liveHarness(); h.start();
  h.run('hostGeneration++');
  h.requests[0].cb('CEP_CONST_OK');
  assert.equal(h.requests.length, 1);
  assert.equal(h.run('hostDiagnosticBusy'), false);
  assert.match(h.output.textContent, /连接代次已变化/);
});
test('real timeout wrapper discards late callback without advancing or touching a new run', () => {
  const h = liveHarness(); h.start(); h.expire();
  assert.equal(h.run('hostDiagnosticBusy'), false);
  assert.match(h.output.textContent, /EVALSCRIPT_TIMEOUT/);
  h.start(); const before = h.output.textContent;
  h.requests[0].cb('CEP_CONST_OK');
  assert.equal(h.requests.length, 2);
  assert.equal(h.output.textContent, before);
  assert.equal(h.button.disabled, true);
  h.requests[1].cb('CEP_CONST_OK');
  assert.equal(h.requests.length, 3);
});
test('old diagnostic run callback does not unlock or advance the current run', () => {
  const h = liveHarness(); h.start();
  h.run('hostDiagnosticRun++');
  h.requests[0].cb('CEP_CONST_OK');
  assert.equal(h.requests.length, 1);
  assert.equal(h.run('hostDiagnosticBusy'), true);
});
test('legacy preload parameter no longer blocks automatic startup', () => {
  const manifest = fs.readFileSync(path.join(__dirname, '../com.figmatoolbox.ps/CSXS/manifest.xml'), 'utf8');
  assert.doesNotMatch(manifest, /<ScriptPath>/);
  assert.match(manifest, /<MainPath>\.\/index\.html\?preloadControl=1<\/MainPath>/);
  const startup = part('    // 对照模式', '    // CEP 没有主动推送');
  for (const search of ['?preloadControl=1', '', '?other=1']) {
    const status = {}, details = {}, timers = [], calls = [];
    const context = { window: { location: { search } }, document: { getElementById: (id) => id === 'host-status' ? status : details }, setTimeout: (fn) => timers.push(fn), ensureHost: () => calls.push('ensure') };
    vm.createContext(context);
    vm.runInContext('let hostTried=false;' + part('    const preloadControl =', '    let bridgeTimeoutMs') + startup, context);
    assert.equal(timers.length, 1); timers[0](); assert.deepEqual(calls, ['ensure']);
    assert.equal(vm.runInContext('preloadControlLocked()', context), false);
  }
});
test('legacy preload parameter permits business calls without running diagnostics', () => {
  const h = liveHarness(true);
  h.run('callHost("list-fonts",null,capture)');
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].script, /list-fonts/);
  assert.equal(h.run('hostDiagnosticRun'), 0);
});
test('legacy preload parameter permits logging before diagnostics', () => {
  const h = liveHarness(true);
  h.run('const window={__adobe_cep__:{}};' + part('    function diagLog(', '    // 读取并执行宿主文件'));
  h.run('diagLog("fixture","before constant")');
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].script, /f\.open\("a"\)/);
  assert.equal(h.run('preloadControlLocked()'), false);
});
test('generated nested eval returns the expected marker', () => {
  const steps = harness().steps();
  assert.equal(vm.runInNewContext(steps[3].script), 'OK|nested-eval');
});
test('file read probe quotes paths and catches constructor errors', () => {
  const script = harness().steps()[2].script;
  let receivedPath = '';
  function File(p) { receivedPath = p; throw new Error('fixture constructor failure'); }
  const result = vm.runInNewContext(script, { File });
  assert.equal(receivedPath, '/fixture/with "quote/jsx/host.jsx');
  assert.match(result, /^ERR\|file-read\|stage=construct/);
});
test('file probe reports missing, open, empty and successful reads and closes the file', () => {
  const script = harness().steps()[2].script;
  for (const mode of ['missing', 'open', 'empty', 'ok']) {
    let closes = 0;
    function File() { this.exists = mode !== 'missing'; this.fsName = '/fixture'; this.error = ''; this.open = () => mode !== 'open'; this.read = () => mode === 'empty' ? '' : 'ABC'; this.close = () => { closes++; }; }
    const result = vm.runInNewContext(script, { File });
    assert.ok(result.startsWith(mode === 'ok' ? 'OK|file-read|path=' : 'ERR|file-read|'));
    if (mode === 'empty' || mode === 'ok') assert.equal(closes, 1);
  }
});
test('outer loader catch reports errors before host eval and nested host errors retain line details', () => {
  const script = harness().steps()[4].script;
  function File() { throw new Error('outside eval'); }
  assert.match(vm.runInNewContext(script, { File }), /^ERR\|host-load\|outer/);
  function ReadFile() { this.exists = true; this.open = () => true; this.read = () => 'throw new Error("host body")'; this.close = () => {}; }
  assert.match(vm.runInNewContext(script, { File: ReadFile, $: { global: {} } }), /^ERR eval line=.*host body/);
});
