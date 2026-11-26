
    const $ = (s) => document.querySelector(s);
    let activeTab = 'font';   // 当前激活标签页，用于决定「识别」读哪类节点
    const ddRegistry = {};    // 通用下拉组件实例表，按目标 select 的 id 索引
    const fontSel = { cn: null, en: null };   // 中/英文字体的真实取值状态（方案保存以它为准）
    // 字体混排的等待守卫：主进程若长时间不回包（例如字体加载卡住），
    // 必须主动告诉用户，否则状态栏会永远停在「应用中…」，看起来就是按钮坏了。
    let fontGuard = null;

    // 收起所有弹层（方案预设 / 通用下拉）
    function closeAllPickers() {
      closePresetPop();
      document.querySelectorAll('.dd.open').forEach((el) => el.classList.remove('open'));
      document.querySelectorAll('.dd-pop.open').forEach((el) => el.classList.remove('open'));
    }

    /* ============================================================
       弹层自适应（不同分辨率 / 不同 Photoshop 面板尺寸）
       ------------------------------------------------------------
       manifest 允许面板被拖到很小（MinSize 300×320），也能拉到很大。
       弹层 CSS 默认向下展开，下方装不下时就会被面板视口裁掉（列表看不全、
       甚至完全看不到）。这里按真实可用空间决定向上还是向下，并收紧
       max-height；字段比弹层还窄时右对齐。
       popupFitPlan 是纯函数，离线单测见 audit/test-panel-fit.js。
       ============================================================ */
    const POP_GAP = 7;    // 弹层与触发条之间的间距（需与 CSS 一致）
    const POP_PAD = 8;    // 视口边缘留白
    const POP_MIN_H = 96; // 再挤也要留出这么高，否则上层改成滚动

    function popupFitPlan(trigger, vw, vh, designMax, designMinW) {
      const below = vh - trigger.bottom - POP_GAP - POP_PAD;
      const above = trigger.top - POP_GAP - POP_PAD;
      // 下方能放下完整高度就不动；放不下时哪边宽裕往哪边翻
      // （宁可上翻显示完整列表，也不要把列表压成一两行）
      const flip = (below < designMax) && (above > below);
      const space = flip ? above : below;
      const maxHeight = Math.max(POP_MIN_H, Math.min(designMax, Math.round(space)));
      const alignRight = !!designMinW && (trigger.width + 2 * POP_PAD < designMinW);
      return { flip: flip, maxHeight: maxHeight, alignRight: alignRight, clipped: space < POP_MIN_H };
    }

    function fitPopup(pop, trigger, designMax, designMinW) {
      if (!pop || !trigger) return null;
      const t = trigger.getBoundingClientRect();
      const plan = popupFitPlan(t, window.innerWidth, window.innerHeight, designMax, designMinW);
      pop.classList.toggle('flip-up', plan.flip);
      pop.classList.toggle('align-right', plan.alignRight);
      pop.style.maxHeight = plan.maxHeight + 'px';
      return plan;
    }

    // 面板尺寸变化时（用户拖拽 / 换显示器 / 换分辨率）重新适配已打开的弹层
    function refitOpenPops() {
      document.querySelectorAll('.dd-pop.open').forEach((pop) => {
        const root = pop.closest ? pop.closest('.dd') : null;
        const trigger = root ? root.querySelector('.dd-trigger') : null;
        if (trigger) fitPopup(pop, trigger, 280, 220);
      });
      const ppop = document.querySelector('.preset-pop.open');
      if (ppop) fitPopup(ppop, document.querySelector('#preset-bar'), 300, 0);
    }
    window.addEventListener('resize', refitOpenPops);

    // ---- 标签页切换 ----
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
        activeTab = btn.dataset.tab;
        closeAllPickers();
        detectActive();   // 切到对应页时，自动识别当前选中图层并回填表单
        requestResize();  // 切页后让面板高度贴合当前页内容
      });
    });

    // ---- 与 Photoshop 宿主通信（CEP evalScript 桥接） ----
    // 消息形状与 Figma 版完全一致：send(msg) 发出请求，handleHostMsg(msg) 处理回包。
    // CSInterface.js 缺失/损坏时不要连累整个面板：构造失败就降级为无宿主模式
    let cs = null;
    try { cs = new CSInterface(); } catch (e) { cs = null; }


    // ---- 颜色调整：调用 Photoshop 原生拾色器 ----
    // 字色文本框右侧色块是统一入口；浏览器预览环境不连接宿主，明确提示。
    function pickerHex(value) {
      let h = String(value == null ? '' : value).trim();
      if (/^[0-9a-f]{6}$/i.test(h)) h = '#' + h;
      if (/^#[0-9a-f]{6}$/i.test(h)) return h.toUpperCase();
      if (/^#[0-9a-f]{3}$/i.test(h)) {
        return ('#' + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2) + h.charAt(3) + h.charAt(3)).toUpperCase();
      }
      return '';
    }
    function syncColorSwatch(input) {
      if (!input || !input.id) return;
      const swatch = $('.color-swatch[data-color-target="' + input.id + '"]');
      if (!swatch) return;
      const hex = pickerHex(input.value);
      swatch.style.backgroundColor = hex || '#000000';
      swatch.setAttribute('aria-label', hex ? '选择字色，当前 ' + hex : '选择字色');
      swatch.setAttribute('title', '选择字色');
    }
    function syncAllColorSwatches() {
      document.querySelectorAll('.color-swatch[data-color-target]').forEach((swatch) => {
        syncColorSwatch($('#' + swatch.getAttribute('data-color-target')));
      });
    }
    function openPsPicker(input) {
      if (!CEP) {
        figmaNotify('拾色器需要在 Photoshop 面板中使用');
        return;
      }
      const cur = hexToRgb(input.value || '#000000');
      callHost('pick-color', { r: cur.r, g: cur.g, b: cur.b }, (r) => {
        if (r && r.ok) {
          input.value = rgbToHex({ r: r.r, g: r.g, b: r.b });
          syncColorSwatch(input);
          input.dispatchEvent(window.__uxpEvent('input', { bubbles: true }));
          input.dispatchEvent(window.__uxpEvent('change', { bubbles: true }));
        } else if (r && r.busy) {
          figmaNotify('拾色器已打开，请先完成当前取色');
        } else if (r && r.canceled) {
          return;
        } else if (r && r.error) {
          figmaNotify('拾色器不可用：' + r.error);
        }
      });
    }
    function openPickerFromSwatch(swatch) {
      if (!swatch) return false;
      const target = swatch.getAttribute('data-color-target') || '';
      if (!/^[\w-]+$/.test(target)) return false;
      const input = $('#' + target);
      if (!input) return false;
      openPsPicker(input);
      return true;
    }
    if (window.__adobe_cep__) {
      document.addEventListener('mousedown', (e) => {
        const t = e.target;
        if (t && t.type === 'color') { e.preventDefault(); openPsPicker(t); }
      }, true);
    }
    document.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.type === 'color') { e.preventDefault(); return; }
      const swatch = t && t.closest ? t.closest('.color-swatch') : null;
      if (!swatch) return;
      e.preventDefault();
      openPickerFromSwatch(swatch);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      const t = e.target;
      const swatch = t && t.closest ? t.closest('.color-swatch') : null;
      if (!swatch) return;
      e.preventDefault();
      openPickerFromSwatch(swatch);
    }, true);
    syncAllColorSwatches();

    // ============================================================
    // 宿主桥：确保 ExtendScript 宿主（jsx/host.jsx）真的可用
    // ------------------------------------------------------------
    // "EvalScript error." 有两类成因：宿主文件没被 CEP 载入（顶层 var
    // 落在非全局作用域，面板调用时找不到这个名字），或者宿主侧抛异常。
    // 这里不再依赖 CEP 的 ScriptPath 自动加载：探测不到就把 jsx 文件
    // 自己 eval 进引擎并显式挂到 $.global，随后重试原调用。
    // 所有结果同步写进扩展目录的 diag.log，离线也能看到真实报错。
    // ============================================================

    const CEP = !!(window.__adobe_cep__ && cs);   // 浏览器预览时为 false，宿主调用自动降级
    const preloadControl = !!(window.location && /(?:^|[?&])preloadControl=1(?:&|$)/.test(window.location.search || ''));
    let preloadControlPassed = true;   // 启动直接连接；旧入口参数不再阻塞字体加载
    function preloadControlLocked() { return preloadControl && !preloadControlPassed; }
    let bridgeTimeoutMs = 15000;
    function evalScript(script, cb, timeoutMs) {
      if (!CEP) { if (cb) cb(''); return; }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (cb) cb('EVALSCRIPT_TIMEOUT');
      }, timeoutMs === undefined ? bridgeTimeoutMs : timeoutMs);
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (cb) cb(result);
      };
      try { cs.evalScript(script, done); } catch (e) { done(''); }
    }

    // 面板期望的宿主版本：与 jsx/host.jsx 的 HOST_VERSION 一致。
    // 用于发现「PS 启动时 ScriptPath 已加载旧版宿主」并强制重载，无需重启 Photoshop。
    const HOST_EXPECT = '0.2.6';
    const EXT_DIR = (() => {
      try { return cs.getSystemPath(SystemPath.EXTENSION) || ''; } catch (e) { return ''; }
    })();

    // 往 <扩展目录>/diag.log 追加一行（纯 evalScript，不依赖宿主可用）
    function diagLog(tag, msg) {
      if (!window.__adobe_cep__ || !EXT_DIR || preloadControlLocked()) return;
      const line = new Date().toTimeString().slice(0, 8) + ' [' + tag + '] ' + msg;
      const jsx = '(function(){try{var f=new File(' + JSON.stringify(EXT_DIR + '/diag.log') + ');' +
        'f.encoding="UTF-8";if(f.open("a")){f.writeln(' + JSON.stringify(line) + ');f.close();}}catch(e){}})()';
      try { evalScript(jsx, () => {}); } catch (e) {}
    }

    // 读取并执行宿主文件，成功后显式发布到 ExtendScript 全局对象。
    // 返回字符串状态；失败时带上真实行号 + 出错行原文。
    function hostLoaderExpr(wantVersion) {
      const jsxPath = EXT_DIR + '/jsx/host.jsx';
      const want = String(wantVersion || HOST_EXPECT);
      return '(function(){' +
        'function pick(){try{if(typeof cephostDispatch==="function")return cephostDispatch;}catch(e){}' +
        'try{if($.global&&$.global.cephostDispatch)return $.global.cephostDispatch;}catch(e){}return null;}' +
        'var cur=pick();' +
        // 精确比对 ping 回包（ES3 环境没有 Array.indexOf；String.indexOf 虽然可用，
        // 但这里改成整串相等更直观：回包形状一变就重载一次宿主，行为仍安全）
        'if(cur){try{if(String(cur("ping",""))===' + JSON.stringify(JSON.stringify({ pong: true, version: want })) + ')return "ALREADY";}catch(e){}}' +
        'var f=new File(' + JSON.stringify(jsxPath) + ');' +
        'if(!f.exists)return "ERR missing-file "+f.fsName;' +
        'var src=null;var encs=["UTF-8","UTF8","BINARY"];' +
        'for(var i=0;i<encs.length;i++){try{f.encoding=encs[i];if(f.open("r")){src=f.read();f.close();}if(src!==null&&src.length)break;}catch(er){try{f.close();}catch(er2){}}}' +
        'if(src===null)return "ERR read-failed "+f.error;' +
        'if(src.charCodeAt(0)===65279)src=src.substring(1);' +
        'var head="";for(var h=0;h<6;h++)head+=src.charCodeAt(h)+",";' +
        'try{eval(src);}catch(e){var arr=src.split("\\n");var bad=arr[e.line-1]||"";' +
        'return "ERR eval line="+e.line+" msg="+e.message+" | "+bad.substring(0,110);}' +
        'try{if(typeof cephostDispatch!=="function")return "ERR not-a-function head="+head;' +
        '$.global.cephostDispatch=cephostDispatch;}catch(e){return "ERR global-set "+e.message;}' +
        'return "LOADED head="+head;' +
        '})()';
    }

    let hostReady = false, hostBusy = false, hostTried = false, hostErr = '', lastCallErr = '';
    let hostWaiters = [];
    const loggedOnce = {};   // 每种 API 只记一次原始回包，避免刷屏
    let startupRequestsQueued = false;
    let selectionPollPending = false;
    let detectRequestPending = false;
    let detectAgainQueued = false;
    let selectionGeneration = 0;
    let hostGeneration = 0;
    let readyWaiters = [];
    let writeProbed = false;  // 写入自检只跑一次
    function ensureHost(cb) {
      if (!CEP || hostDiagnosticBusy || preloadControlLocked()) return;
      if (hostReady) { if (cb) cb(true); return; }
      if (hostTried && !hostBusy) { if (cb) cb(false); return; }
      if (cb) hostWaiters.push(cb);
      if (hostBusy) return;
      hostBusy = true; hostTried = true;
      diagLog('host', 'probe start ext=' + EXT_DIR);
      const generation = hostGeneration;
      evalScript('typeof cephostDispatch', (t) => {
        if (generation !== hostGeneration) return;
        if (t === 'EVALSCRIPT_TIMEOUT') { finishHost(false, '宿主桥接请求超时，点击状态行重连'); return; }
        diagLog('host', 'typeof cephostDispatch = ' + t);
        if (t === 'function') {
          // 宿主已在 → 先核对版本（PS 启动时 ScriptPath 可能加载的是旧版宿主）
          callHost('ping', null, (pg) => {
            if (generation !== hostGeneration) return;
            diagLog('host', 'ping -> ' + JSON.stringify(pg));
            const ver = (pg && pg.version) || '';
            if (!pg || pg.pong !== true || pg.error || ver !== HOST_EXPECT) {
              diagLog('host', '版本或 ping 校验不符 running=' + ver + ' expect=' + HOST_EXPECT + ' → 强制重载宿主');
              reloadHost();
              return;
            }
            callHost('diag', null, (dg) => {
              if (generation !== hostGeneration) return;
              diagLog('host', 'env -> ' + JSON.stringify(dg));
              finishHost(true, 'ScriptPath 已加载，宿主 v' + ver);
            }, true);
          }, true);
          return;
        }
        reloadHost();
      });
    }
    // 把 jsx 读进引擎并挂到 $.global，随后 ping 一次确认手上的就是新宿主
    function reloadHost() {
      const generation = hostGeneration;
      evalScript(hostLoaderExpr(HOST_EXPECT), (res) => {
        if (generation !== hostGeneration) return;
        diagLog('host', 'loader -> ' + res);
        const r = String(res == null ? '' : res).trim();
        // Loader may append diagnostics (e.g. LOADED head=47,42,...).
        // This is only a load acknowledgement; ping must still confirm readiness.
        if (!/^(?:LOADED|ALREADY)(?:\s|$)/.test(r)) { finishHost(false, r); return; }
        callHost('ping', null, (pg) => {
          if (generation !== hostGeneration) return;
          const ver = (pg && pg.version) || '?';
          const pingOK = !!pg && pg.pong === true && !pg.error;
          diagLog('host', 'ping after load -> ' + JSON.stringify(pg));
          const info = !pingOK ? '重载后 ping 校验失败：' + JSON.stringify(pg) : '宿主 v' + ver +
            (ver === HOST_EXPECT ? '（' + r + '）' : ' 版本不符，期望 ' + HOST_EXPECT + '（' + r + '）');
          finishHost(pingOK && ver === HOST_EXPECT, info);
        }, true);
      });
    }
    function finishHost(ok, info) {
      hostReady = ok; hostBusy = false; hostErr = ok ? '' : info;
      const el = document.getElementById('host-status');
      if (el) {
        el.className = 'status diag ' + (ok ? 'ok' : 'bad');
        el.textContent = ok
          ? '宿主已连接（通信正常）'
          : ('宿主加载失败：' + info + '  —  点这里重试，详情见扩展目录 diag.log');
      }
      diagLog('host', (ok ? 'READY ' : 'FAIL ') + info);
      // Connecting the host must not create a document or run a write probe.
      // Photoshop remains on the user's current document and tab.
      if (!ok) figmaNotify('宿主加载失败：' + info);
      const waiters = hostWaiters; hostWaiters = [];
      waiters.forEach((fn) => { try { fn(ok); } catch (e) {} });
      const ready = readyWaiters; readyWaiters = [];
      ready.forEach((fn) => { try { fn(ok); } catch (e) {} });
      if (ok) {
        if (!startupRequestsQueued) startPanelHostRequests();
        else {
          if (detectAgainQueued) detectActive();
          requestFontList();
        }
      } // Preserve read intent on failure; only an explicit reconnect resumes it.
    }
    // 手动诊断：面板保留原始回包，不经 diagLog，不启动业务请求或自动重连。
    let hostDiagnosticBusy = false;
    let hostDiagnosticRun = 0;
    function hostDiagnosticSteps() {
      const filePath = JSON.stringify(EXT_DIR + '/jsx/host.jsx');
      return [
        { name: 'constant', script: '"CEP_CONST_OK"', accepts: (r) => r === 'CEP_CONST_OK' },
        { name: 'environment', script: '(function(){try{return "OK|environment|app="+app.version+"|extendscript="+$.version+"|engine="+$.engineName+"|dispatch="+typeof cephostDispatch+"|File="+typeof File;}catch(e){return "ERR|environment|line="+e.line+"|"+e.message;}})()', accepts: (r) => r.indexOf('OK|environment|') === 0 },
        { name: 'file-read', script: '(function(){var f=null;var stage="construct";try{f=new File(' + filePath + ');stage="exists";if(!f.exists)return "ERR|file-read|missing|"+f.fsName;stage="open";f.encoding="UTF-8";if(!f.open("r"))return "ERR|file-read|open|"+f.error;stage="read";var src=f.read();var err=f.error;f.close();if(err)return "ERR|file-read|read|"+err;if(!src.length)return "ERR|file-read|empty|"+f.fsName;var head="";for(var i=0;i<6&&i<src.length;i++)head+=src.charCodeAt(i)+",";return "OK|file-read|path="+f.fsName+"|length="+src.length+"|head="+head;}catch(e){try{if(f)f.close();}catch(ec){}return "ERR|file-read|stage="+stage+"|line="+e.line+"|"+e.message;}})()', accepts: (r) => r.indexOf('OK|file-read|') === 0 },
        { name: 'nested-eval', script: '(function(){try{return eval("\\\"OK|nested-eval\\\"");}catch(e){return "ERR|nested-eval|line="+e.line+"|"+e.message;}})()', accepts: (r) => r === 'OK|nested-eval' },
        { name: 'host-load', script: '(function(){try{return ' + hostLoaderExpr(HOST_EXPECT) + ';}catch(e){return "ERR|host-load|outer|line="+e.line+"|"+e.message;}})()', accepts: (r) => /^(?:LOADED|ALREADY)(?:\s|$)/.test(r) },
        { name: 'ping', script: hostCallExpr('ping', ''), accepts: (r) => { try { const p = JSON.parse(r); return p.pong === true && !p.error && p.version === HOST_EXPECT; } catch (e) { return false; } } },
      ];
    }
    function runHostDiagnostics() {
      const output = document.getElementById('host-diagnostic-output');
      const button = document.getElementById('host-diagnose');
      if (!output || hostDiagnosticBusy) return;
      if (!CEP) { output.textContent = '未检测到 CEP 桥接。'; return; }
      if (hostReady || hostBusy || pendingHostCalls.length) {
        output.textContent = '诊断仅在加载失败且无在途请求时运行。'; return;
      }
      hostDiagnosticBusy = true;
      const run = ++hostDiagnosticRun;
      const generation = hostGeneration;
      if (button) button.disabled = true;
      output.textContent = '开始诊断；不执行字体识别、字体枚举或写入自检。\n';
      const steps = hostDiagnosticSteps();
      function finish(message) {
        if (run !== hostDiagnosticRun || !hostDiagnosticBusy) return;
        output.textContent += message + '\n';
        hostDiagnosticBusy = false;
        if (button) button.disabled = false;
      }
      function next(index) {
        if (index === steps.length) { preloadControlPassed = true; finish('诊断通过；点击原状态行重新连接。'); return; }
        const step = steps[index];
        output.textContent += '[' + step.name + '] 等待回包\n';
        evalScript(step.script, (raw) => {
          if (run !== hostDiagnosticRun || !hostDiagnosticBusy) return;
          if (generation !== hostGeneration) { finish('连接代次已变化，诊断停止；旧回包未推进阶段。'); return; }
          const result = String(raw == null ? '' : raw);
          output.textContent += '[' + step.name + '] ' + JSON.stringify(result) + '\n';
          if (!step.accepts(result)) { finish('停止于 ' + step.name + '，未执行后续阶段。'); return; }
          next(index + 1);
        });
      }
      next(0);
    }
    const hostDiagnoseButton = document.getElementById('host-diagnose');
    if (hostDiagnoseButton && typeof hostDiagnoseButton.addEventListener === 'function') {
      hostDiagnoseButton.addEventListener('click', runHostDiagnostics);
    }

    // ---- 宿主自检（真机证据，不是推断）----
    // 在临时文档里用「生产路径」把两个不同字体写进两段并回读校验：
    // 结果直接写进 diag.log，并显示在状态条上。用户文档完全不受影响。
    let selfTested = false;
    function hostSelfTest() {
      if (selfTested || !CEP || !hostReady) return;
      selfTested = true;
      const args = {};
      if (fontSel.cn && fontSel.cn.family) args.cnFont = fontSel.cn;
      if (fontSel.en && fontSel.en.family) args.enFont = fontSel.en;
      diagLog('selftest', 'start ' + JSON.stringify(args));
      callHost('selftest', args, (st) => {
        diagLog('selftest', JSON.stringify(st).slice(0, 700));
        const steps = (st && st.steps) || [];
        const has = (s) => steps.indexOf(s) >= 0;
        const wrote = has('write=ok');
        const verified = has('verify=ok') || has('verify=ok-secondary');
        const okWrite = wrote && verified;
        const sizeOk = has('size=ok');
        // 请求的那对字体因缺字形被 PS 替换、改用稳健字体又验过：算通过，但要说明
        const subWarn = (has('verify=substituted') && verified)
          ? '（你选的那对字体在样例字符上被 PS 替换，已用 ' + ((st && st.robust) || '') + ' 验证通过）' : '';
        const el = document.getElementById('host-status');
        if (el && hostReady) {
          el.className = 'status diag ' + (okWrite ? 'ok' : 'bad');
          el.textContent = okWrite
            ? ('宿主已连接 · 自检：分段写入 OK，' +
               (sizeOk ? ('字号 OK（' + st.sizeMode + '）') : ('但分段字号不可用：' + ((st && st.sizeSteps) || ''))) + subWarn)
            : ('宿主已连接 · 自检未通过：' + (st && st.error ? st.error : steps.join(' ')) + '  —  详情见扩展目录 diag.log');
        }
      }, true);
    }

    // 点击状态行 = 手动重试一次加载（改完 jsx 文件后无需重启 PS）
    const hostStatusEl = document.getElementById('host-status');
    if (hostStatusEl) {
      hostStatusEl.addEventListener('click', () => {
        // 宿主已连接时：点一下 = 重跑一次自检（改了 jsx 后不必重启面板）
        if (hostReady) { callHost('ping', null, () => {}); return; }
        hostTried = false; hostErr = '';
        ensureHost();
      });
    }

    function hostCallExpr(type, enc) {
      // 优先用面板亲手挂到 $.global 的那份（可能是刚重载的新版宿主），再退回 ScriptPath 加载的
      return '(function(){var f=null;' +
        'try{if($.global&&$.global.cephostDispatch)f=$.global.cephostDispatch;}catch(e){}' +
        'if(!f){try{if(typeof cephostDispatch==="function")f=cephostDispatch;}catch(e){}}' +
        'if(!f)return "__NOHOST__";' +
        'return f(' + JSON.stringify(type) + ',' + JSON.stringify(enc) + ');})()';
    }

    let pendingHostCalls = [];
    function invalidateHost(reason) {
      hostGeneration += 1;
      hostReady = false;
      hostBusy = false;
      selectionPollPending = false;
      detectRequestPending = false;
      detectAgainQueued = true;
      fontLoading = false;
      lastSelSig = '';
      selectionGeneration += 1;
      const pending = pendingHostCalls; pendingHostCalls = [];
      pending.forEach((call) => {
        try { call.finish({ error: reason || '宿主连接已失效', stage: 'bridge-invalidated', state: call.write ? 'unknown' : 'unavailable', resultUnknown: call.write }); } catch (e) {}
      });
    }

    function callHost(type, args, cb, noRetry) {
      if (hostDiagnosticBusy || preloadControlLocked()) {
        if (cb) cb({ error: '请先完成宿主加载诊断，再重新操作', stage: hostDiagnosticBusy ? 'diagnostic-busy' : 'preload-control', state: 'unavailable' });
        return;
      }
      if (!CEP) { setTimeout(() => { if (cb) cb({}); }, 0); return; }   // 预览：异步模拟 CEP 回包时序，避免 TDZ
      const enc = args ? encodeURIComponent(JSON.stringify(args)) : '';
      const generation = hostGeneration;
      let settled = false;
      const call = { write: type === 'font-mixer' || type === 'auto-kerning', finish(data) {
        if (settled) return;
        settled = true;
        pendingHostCalls = pendingHostCalls.filter((item) => item !== call);
        if (cb) cb(data);
      }};
      pendingHostCalls.push(call);
      evalScript(hostCallExpr(type, enc), (res) => {
        if (settled || generation !== hostGeneration) return;
        if (res === 'EVALSCRIPT_TIMEOUT') {
          invalidateHost('宿主桥接请求超时');
          hostTried = true;
          finishHost(false, '宿主桥接请求超时，点击状态行重连');
          return;
        }
        let data = null;
        try { data = JSON.parse(res); } catch (e) { data = { error: String(res) }; }
        const needHeal = (res === '__NOHOST__') || (res === 'EvalScript error.' && !hostReady);
        if (needHeal && !noRetry) {
          invalidateHost('宿主连接已失效');
          hostTried = false;
          // Reconnect schedules fresh reads. Writes settle as unknown and are never replayed.
          diagLog('call', type + ' -> 宿主不可用(' + res + ')，尝试现场加载');
          ensureHost();
          return;
        }
        if (!loggedOnce[type]) {
          loggedOnce[type] = true;
          diagLog('reply', type + ' -> ' + String(res).slice(0, 600));
        }
        if (data && data.failed && data.failed.length) {
          const f0 = data.failed[0] || {};
          diagLog('failed', type + ' -> ' + JSON.stringify({
            name: f0.name, reason: f0.reason, stage: f0.stage, line: f0.line, trace: f0.trace, forms: f0.forms,
          }));
        }
        if (data && data.error && data.error !== lastCallErr) {
          lastCallErr = data.error;
          const where = (data.api || data.stage)
            ? ' [api=' + (data.api || '?') + ' stage=' + (data.stage || '?') + ' line=' + (data.line === undefined ? '?' : data.line) + ']'
            : '';
          diagLog('call', type + ' -> ' + data.error + where);
        }
        call.finish(data);
      }, type === 'font-mixer' ? Math.max(80000, bridgeTimeoutMs) : bridgeTimeoutMs);
    }

    // 对照模式旧参数仅兼容入口；正常启动直接连接并加载字体。
    setTimeout(() => ensureHost(), 200);

    // CEP 没有主动推送：选区变化用轮询签名模拟（与 Figma 版 selection-changed 等效）
    let lastSelSig = '';
    function pollSelection(forceDetect) {
      if (!hostReady || selectionPollPending || document.hidden ||
          pendingHostCalls.some((call) => call.write)) return;
      selectionPollPending = true;
      callHost('sel-sig', null, (r) => {
        selectionPollPending = false;
        if (!hostReady || (r && r.error)) return;
        const sig = JSON.stringify([(r && r.sig) || '', r && r.targetSig, r && r.textCount, r && r.readState]);
        if (sig !== lastSelSig || forceDetect === true) {
          lastSelSig = sig;
          selectionGeneration += 1;
          if (activeTab !== 'font') return;
          if (r && r.textCount > 0) {
            if (detectRequestPending) detectAgainQueued = true;
            else send({type:'detect-font'});
          } else {
            detectAgainQueued = false;
            fillFontFromDetect({empty:true, sourceNotes:(r && r.sourceNotes) || []});
          }
        }
      });
    }
    setInterval(function () {
      // UXP：滚动、输入、弹层打开期间暂停跨进程选区遍历。
      if (window.__uxpShouldPausePoll && window.__uxpShouldPausePoll()) return;
      pollSelection();
    }, 700);

    function send(msg) {
      switch (msg.type) {
        case 'resize':
          // CEP 面板高度由 Photoshop 管理，无需贴合；仅滚动到底部确保可见
          break;
        case 'notify':
          alert(String(msg.msg || ''));
          break;
        case 'list-fonts':
          if (!hostReady) { requestFontList(); break; }
          callHost('list-fonts', null, (r) => {
            applyFontList(r && !r.error && Array.isArray(r.families) ? { families: r.families } : { families: [], error: (r && r.error) || '字体库返回格式无效' });
          });
          break;
        case 'storage-load':
          // 延迟到脚本执行完毕后再回填：applyStoredPresets 依赖下方 let/const，
          // 同步调用会触发 TDZ 崩溃并截断后续全部控件绑定
          setTimeout(function () { applyStoredPresets(readPresets()); }, 0);
          break;
        case 'storage-save':
          writePresets(msg.data || {});
          break;
        case 'detect-font':
          if (!hostReady) { detectAgainQueued = true; break; }
          if (detectRequestPending) { detectAgainQueued = true; break; }
          detectRequestPending = true;
          detectAgainQueued = false;
          const requestGeneration = selectionGeneration;
          const connectionGeneration = hostGeneration;
          callHost('detect-font', null, (r) => {
            if (connectionGeneration !== hostGeneration && !(r && r.stage === 'bridge-timeout')) return;
            detectRequestPending = false;
            const stale = requestGeneration !== selectionGeneration;
            if (!stale) {
              if (r && r.error) {
                fillFontFromDetect({error:r.error});
                const st = $('#font-status');
                if (st) st.textContent = '识别失败：' + r.error + (r.stage ? '（' + r.stage + '）' : '');
              } else handleHostMsg({ type: 'detect-font-result', ...r });
            }
            if (detectAgainQueued) { detectAgainQueued = false; detectActive(); }
          });
          break;
        case 'font-mixer':
          handleHostMsg({ type: 'font-mixer-start', total: 0 });
          callHost('font-mixer', msg.config, (r) => { handleHostMsg({ type: 'font-mixer-done', ...r }); });
          break;
        case 'auto-kerning':
          callHost('auto-kerning', null, (r) => {
            handleHostMsg({ type: 'auto-kerning-done', ...r });
          });
          break;
      }
    }

    // 统一回包处理（与 Figma 版 window.onmessage 逻辑相同）
    function handleHostMsg(msg) {
      if (msg.type === 'detect-font-result') fillFontFromDetect(msg);
      if (msg.type === 'font-mixer-start') onFontMixStart(msg);
      if (msg.type === 'font-mixer-done') showFontMixResult(msg);
      if (msg.type === 'auto-kerning-done') showKerningResult(msg);
      if (msg.type === 'storage-data') applyStoredPresets(msg.data);
    }

    // ---- 预设持久化：CEP 面板可用 localStorage（有真实 origin，非 data: URL） ----
    function readPresets() {
      try {
        return {
          fontPresets: JSON.parse(window.localStorage.getItem('pstoolbox-fontPresets') || '[]'),
        };
      } catch (e) { return { fontPresets: [] }; }
    }
    function writePresets(data) {
      try {
        window.localStorage.setItem('pstoolbox-fontPresets', JSON.stringify(data.fontPresets || []));
      } catch (e) { }
    }

    function requestResize() {
      // CEP 面板由 Photoshop 窗口管理器控制尺寸；保留函数避免调用点报错
    }

    // 面板先挂起需要宿主的工作，等版本校验和 READY 完成后再启动。
    send({ type: 'storage-load' });
    requestResize();

    function startPanelHostRequests() {
      if (startupRequestsQueued || !hostReady) return;
      startupRequestsQueued = true;
      pollSelection(true);
      requestFontList();
    }

    $('#kerning-apply').addEventListener('click', () => {
      $('#kerning-status').textContent = '处理中…';
      // Photoshop owns Optical Kerning; no custom tracking/leading values are sent.
      send({ type: 'auto-kerning' });
    });
    // 主进程回传的持久化方案：以它为准覆盖内存态并重绘
    function applyStoredPresets(data) {
      const d = data || {};
      if (Array.isArray(d.fontPresets)) {
        fontPresets = d.fontPresets;
        lsWrite(PK, fontPresets);
        renderPresetPop();
      }
    }

    // 按当前标签页，请求主进程识别选中的图层
    function detectActive() {
      if (activeTab !== 'font') return;
      if (!hostReady) { detectAgainQueued = true; return; }
      if (detectRequestPending) { detectAgainQueued = true; return; }
      pollSelection(true);
    }

    // 把识别到的文本图层字体混排回填到表单（同时重置方案态，保存即存为新方案）
    // 守卫：用户已选中预设方案时，识别结果不得覆盖表单 ——
    // 预设是显式意图，优先级高于任何自动识别；否则启动识别晚到 / 选区变化
    // 都会把刚选好的预设悄悄冲掉，表现为「点了预设但不生效」。
    // 想恢复识别回填：在方案下拉里再次点击「当前」方案行即可取消选择。
    // 用户手动编辑过的字段，不再被「识别回填」覆盖。
    // 识别是选区变化触发的（轮询），不设这道闸的话，你刚输入的字号/颜色会被
    // 下一次识别悄悄冲回原值 —— 表现出来就是「字号改不了」。
    const userTouched = {};
    const TOUCH_TRACKED = ['#cn-font', '#en-font', '#cn-size', '#en-size', '#cn-color', '#en-color'];
    function markTouched() {
      TOUCH_TRACKED.forEach((sel) => {
        const el = $(sel);
        if (el && !el.__touchBound) {
          el.__touchBound = true;
          el.addEventListener('input', () => {
            userTouched[sel] = true;
            if (sel === '#cn-color' || sel === '#en-color') syncColorSwatch(el);
          });
        }
      });
    }
    function clearTouched() {
      TOUCH_TRACKED.forEach((sel) => { delete userTouched[sel]; });
    }
    markTouched();

    function fillFontFromDetect(msg) {
      const status = $('#font-status');
      if (currentScheme) { if (status) status.textContent = '保留已选方案；识别结果未覆盖'; return; }
      setCurrentLabel('');
      const labels = {consistent:'一致', mixed:'混合', unrecognized:'未识别', empty:'无内容', error:'读取失败'};
      const selectionNote = msg.selectionLimited ? '当前宿主只确认活动层，可能未覆盖多选图层；' : '';
      const sourceNote = msg.sourceNotes && msg.sourceNotes.length ? '选区诊断：' + msg.sourceNotes.join('；') + '；' : '';
      const notes = [];
      ['cn','en'].forEach((side) => {
        ['Font','Size','Color'].forEach((kind) => {
          const key = side+kind, sel = '#'+side+'-'+kind.toLowerCase();
          const f = msg.fields && msg.fields[key] || {state:msg.error?'error':msg.empty?'empty':msg[key]!=null?'consistent':'unrecognized',value:msg[key]};
          const reasons = (f.sources || []).filter(s => s.reason).map(s => s.reason + (s.psName ? ':' + s.psName : ''));
          notes.push(key+'：'+(userTouched[sel]?'保留用户值':labels[f.state] || f.state)+(f.convenience?'（另一侧便利回填）':'')+(reasons.length?'（'+Array.from(new Set(reasons)).join('；')+'）':''));
          if (userTouched[sel]) return;
          if (kind === 'Font') setFontValue(side, f.value);
          else {
            const el = $(sel);
            if (kind === 'Size') { el.value = f.value != null ? f.value : ''; el.placeholder = f.state === 'mixed'?'混合字号（留空保留）':'留空保留'; }
            else {
              el.type = 'text';
              el.value = f.value ? rgbToHex(f.value) : '';
              el.placeholder = labels[f.state] || '';
              syncColorSwatch(el);
            }
          }
        });
      });
      if (status) status.textContent = selectionNote + sourceNote + (msg.error ? '识别失败：'+msg.error+'；'+notes.join('；') : (msg.empty?'未选中有效文本；':'识别 '+(msg.layerCount || 0)+' 个文本层；')+notes.join('；'));
    }


    // 主进程已开始处理（字体加载可能耗时）→ 明确告知，并启动等待守卫
    function onFontMixStart(msg) {
      if (fontGuard) { clearTimeout(fontGuard); fontGuard = null; }
      const n = (msg && msg.total) || 0;
      $('#font-status').textContent = n ? ('正在加载字体…（共 ' + n + ' 个文本节点）') : '正在加载字体…';
      fontGuard = setTimeout(() => {
        fontGuard = null;
        $('#font-status').textContent = '宿主长时间无响应，应用结果未知；请先核对文档状态，避免重复应用。';
      }, Math.max(80000, bridgeTimeoutMs));
    }

    // 字体混排结果反馈：成功 / 失败 / 字体不可用都要说清楚，不能静默
    function showFontMixResult(msg) {
      const el = $('#font-status');
      if (!el) return;
      if (fontGuard) { clearTimeout(fontGuard); fontGuard = null; }   // 收到结果即撤掉等待守卫
      const failed = msg.failed || [];
      const missing = msg.missingFonts || [];
      const selectionNote = msg.selectionLimited ? '当前宿主只确认活动层，可能未覆盖多选图层；' : '';
      const sourceNote = msg.sourceNotes && msg.sourceNotes.length ? '选区诊断：' + msg.sourceNotes.join('；') + '；' : '';
      if (msg.resultUnknown) {
        el.textContent = '字体应用结果未知：' + msg.error + '；请先核对文档状态，避免重复应用。';
        return;
      }
      if (msg.error) {
        el.textContent = selectionNote + sourceNote + '字体混排失败：' + msg.error +
          (msg.stage ? '（' + msg.stage + (msg.line ? ' 第 ' + msg.line + ' 行' : '') + '）' : '');
        return;
      }
      if (msg.empty || msg.total === 0) { el.textContent = selectionNote + sourceNote + '未选中文本图层，请先在画布上选择文本'; return; }
      if (missing.length) {
        el.textContent = selectionNote + sourceNote + '字体在本机不可用：' + missing.join('、') + '（请改用本机已安装的字体）';
        return;
      }
      const substituted = msg.substituted || [];
      // 结果汇总：不许任何一个分支提前 return 把别的结果吞掉（R3/R6）。
      // 「回读通过」只算 ok；被替换的层不进 ok，但它也不是失败，必须单独报。
      const counts = ['已处理 ' + (msg.total || 0) + ' 个', '回读通过 ' + (msg.ok || 0)];
      if (substituted.length) counts.push('字体被替换 ' + substituted.length);
      if (failed.length) counts.push('失败 ' + failed.length);
      if (msg.unprocessed) counts.push('未处理 ' + msg.unprocessed);
      const detail = [];
      if (failed.length) {
        detail.push(failed[0].name + '：' + failed[0].reason +
          (failed[0].stage ? '／' + failed[0].stage : '') + '；' +
          (failed[0].writeAttempted === true && failed[0].state !== 'rolled-back'
            ? '可能部分修改，混排完整性未知' : (failed[0].integrity || '')));
      }
      if (substituted.length) {
        const sb = String(substituted[0] || '');
        const bi = sb.indexOf('[');
        detail.push((bi > 0 ? sb.slice(bi + 1, sb.length - 1) : sb) +
          (msg.path === 'dom-fallback' ? '（已按整层字体处理）' : ''));
      }
      if ((msg.layerFallback || []).length) {
        const fb = String(msg.layerFallback[0] || '');
        const br = fb.indexOf('[');
        detail.push('另有 ' + msg.layerFallback.length + ' 个按整层字体处理' +
          (br > 0 ? '：' + fb.slice(br + 1, fb.length - 1) : ''));
      }
      // 只有真写进去过才谈颜色，全失败时不该出现「已按左右侧字色同步颜色」
      const colorNote = (msg.ok || substituted.length)
        ? (lastSyncColor ? '；已按左右侧字色同步颜色' : '；未调整颜色（保留原文字颜色）')
        : '';
      const notes = (msg.notes || []).filter(Boolean);
      el.textContent = selectionNote + sourceNote + counts.join('，') +
        (detail.length ? '（' + detail.join('；') + '）' : '') +
        (msg.timedOut ? '；部分字体加载超时，若有遗漏请重试' : '') +
        (notes.length ? '（' + notes.join('；') + '）' : '') + colorNote;
    }

    // 字距结果：先暴露真实错误，绝不显示 undefined
    function showKerningResult(msg) {
      const el = $('#kerning-status');
      if (!el) return;
      if (msg && msg.resultUnknown) {
        el.textContent = '字距应用结果未知：' + msg.error + '；请先核对文档状态，避免重复应用。';
        return;
      }
      if (msg && msg.error) {
        el.textContent = '字距失败：' + msg.error +
          (msg.stage ? '（' + msg.stage + (msg.line ? ' 第 ' + msg.line + ' 行' : '') + '）' : '');
        return;
      }
      if (!msg || msg.empty) { el.textContent = '未选中文本图层'; return; }
      const opt = Number(msg.optical) || 0, trk = Number(msg.tracking) || 0;
      const lead = Number(msg.leading) || 0, leadFail = Number(msg.leadingFailed) || 0;
      const leadAsked = msg.leadingRequested !== false;
      const why = (msg.skipped && msg.skipped.length) ? '（' + msg.skipped[0] + '）' : '';
      let text;
      if (opt && !trk) text = '已按 Photoshop「视觉」字距处理 ' + opt + ' 个文本图层';
      else if (opt && trk) text = '视觉字距 ' + opt + ' 个图层，另 ' + trk + ' 个回退为符号字距';
      else if (trk) text = '已调整 ' + trk + ' 个图层的符号字距' + why;
      else text = '未能调整' + why;
      // 行间距是可选项：勾了就报结果，没勾就说明没动
      if (!leadAsked) text += '；未勾选行距自动，行间距保持不变';
      else if (lead && !leadFail) text += '；行间距已设为「自动」';
      else if (lead) text += '；行间距「自动」成功 ' + lead + ' 个，失败 ' + leadFail + ' 个' + why;
      else text += '；行间距未能设为「自动」' + why;
      el.textContent = text + (msg.failed ? '，失败 ' + msg.failed + ' 个' : '');
    }

    // 数值输入：兼容不同键盘/区域的小数分隔符（例如欧洲键盘输入 "1,5"）
    // parseFloat('1,5') 会得到 1 —— 不同地区用户会因此得到错误数值。
    function numInput(el) {
      if (!el) return null;
      const s = String(el.value == null ? '' : el.value).trim().replace(',', '.');
      const n = parseFloat(s);
      return (isNaN(n) || !isFinite(n)) ? null : n;
    }

    // ---- 颜色转换 ----
    function hexToRgb(hex) {
      const h = hex.replace('#', '');
      const n = parseInt(h, 16);
      return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
    }
    function rgbToHex(c) {
      if (!c) return '#000000';
      const f = (x) => ('0' + Math.round(x * 255).toString(16)).slice(-2);
      return '#' + f(c.r) + f(c.g) + f(c.b);
    }



    /* ============================================================
       字体库（按需加载 · family 聚合 · 限量渲染）
       ------------------------------------------------------------
       旧实现：主进程在插件启动时返回 listAvailableFontsAsync() 的**扁平全量组合**，
       UI 收到后给「中文」「英文」两个 <select> 各铺一份。
       实测 8000 条时——字体列表送达同步阻塞 ~56ms、打开下拉再花 ~47ms、
       DOM 里留下 16000 个 <option>；而设计机器上的字体数量往往更多。

       新实现（做法参考开源插件 MixFonts）：
         · 主进程按 family 聚合（8000 → 约 800 项），体积降一个数量级
         · 不再预铺 <option>，条目在「打开下拉 / 输入关键词」时即时生成
         · 单次渲染限量（无关键词 40 条、有搜索词 120 条）
         · 加载时机改为「打开下拉时」或「面板空闲后预热」，不拖慢启动
       ============================================================ */
    let fontFamilies = null;   // [{family, styles:[…]}]；null = 尚未加载
    let fontLoading = false;
    let fontError = '';

    // 请求字体库：只在首次真正发消息，之后命中主进程缓存
    function refreshFontDropdowns() {
      ['cn-font', 'en-font'].forEach((id) => {
        const dd = typeof ddRegistry !== 'undefined' && ddRegistry[id];
        if (dd && dd.refresh) dd.refresh();
      });
    }
    function fontListStateText() {
      if (fontError) return '字体库加载失败：' + fontError;
      if (fontLoading) return '正在加载字体库…';
      if (fontFamilies === null) return '等待宿主连接…';
      return '';
    }
    function requestFontList() {
      if ((fontFamilies && !fontError) || fontLoading) return;
      if (!hostReady) {
        if (hostTried && !hostBusy && !preloadControlLocked()) {
          applyFontList({ families: [], error: hostErr || '宿主连接失败，请点击连接状态行重连' });
          return;
        }
        if (!requestFontList.queued) {
          requestFontList.queued = true;
          fontError = '';
          fontFamilies = null;
          refreshFontDropdowns();
          const status = $('#font-status');
          if (status) status.textContent = fontListStateText();
          readyWaiters.push((ok) => {
            requestFontList.queued = false;
            if (ok) requestFontList();
            else applyFontList({ families: [], error: hostErr || '宿主连接失败，字体库未加载' });
          });
        }
        return;
      }
      fontError = '';
      fontFamilies = null;
      fontLoading = true;
      refreshFontDropdowns();
      const status = $('#font-status');
      if (status) status.textContent = fontListStateText();
      send({ type: 'list-fonts' });
    }

    // 字体键（family + style 的唯一标识）
    function fontKey(family, style) { return family + '##' + style; }

    // 「优先展示」的字体：当前选中 + 识别到的 + 方案预设里用过的。
    // 无害化关键词时只渲染 40 条，若这 40 条里就有用户惯用的字体，找字体会顺畅得多。
    function pinnedFontKeys() {
      const set = new Set();
      const add = (f) => { if (f && f.family) set.add(fontKey(f.family, f.style)); };
      add(fontSel.cn);
      add(fontSel.en);
      (fontPresets || []).forEach((p) => { add(p && p.cnFont); add(p && p.enFont); });
      return set;
    }

    // 生成字体条目；返回 null 表示数据未就绪（下拉会显示加载提示并等待）
    function fontItems(q) {
      if (!fontFamilies) return null;
      const key = (q || '').trim().toLowerCase();
      const pinned = pinnedFontKeys();
      const head = [];
      const tail = [];
      for (const fam of fontFamilies) {
        for (const st of fam.styles) {
          const label = fam.family + ' / ' + st;
          if (key && label.toLowerCase().indexOf(key) < 0) continue;
          const item = { value: JSON.stringify({ family: fam.family, style: st }), label };
          (pinned.has(fontKey(fam.family, st)) ? head : tail).push(item);
        }
      }
      return head.concat(tail);
    }

    // 字体库到达（或失败）
    function applyFontList(msg) {
      fontLoading = false;
      fontError = msg.error || '';
      fontFamilies = Array.isArray(msg.families) ? msg.families : [];
      if (fontError) {
        $('#font-status').textContent = '字体库加载失败：' + fontError;
      } else {
        const status = $('#font-status');
        if (status) status.textContent = fontFamilies.length ? '字体库已加载' : '字体库为空';
        ensureFontDefaults();
      }
      ['cn-font', 'en-font'].forEach((id) => {
        const dd = ddRegistry[id];
        if (dd && dd.refresh) dd.refresh();
      });
    }

    // 兜底默认值：仅在用户还没选过字体时设置，避免覆盖「刚识别到的字体」
    // 用 \u 转义书写，避免裸字符在不同工具链下被改坏（本项目踩过 Unicode 陷阱）
    function ensureFontDefaults() {
      if (!fontFamilies.length) return;
      if (!fontSel.cn) {
        const cjk = fontFamilies.find((f) => /[\u4E00-\u9FFF]/.test(f.family)) || fontFamilies[0];
        setFontValue('cn', { family: cjk.family, style: cjk.styles[0] });
      }
      if (!fontSel.en) {
        const f0 = fontFamilies[0];
        setFontValue('en', { family: f0.family, style: f0.styles[0] });
      }
    }

    /* ============================================================
       通用下拉组件（.dd）：与方案预设弹层同款，用于字体 / 格式 / 对齐
       隐藏的原生 <select> 仍作为取值源，自定义弹层仅负责展示与选择
       ============================================================ */
    function initDropdown(root, opts) {
      opts = opts || {};
      const targetId = root.dataset.target;
      const sel = document.getElementById(targetId);
      const trigger = root.querySelector('.dd-trigger');
      const current = root.querySelector('.dd-current');
      const pop = root.querySelector('.dd-pop');
      const list = root.querySelector('.dd-list');
      const searchWrap = root.querySelector('.dd-search');
      const searchInput = searchWrap ? searchWrap.querySelector('input') : null;
      const emptyEl = root.querySelector('.dd-empty');

      function syncDisplay() {
        const opt = (sel.selectedOptions && sel.selectedOptions[0]) || Array.from(sel.options || []).filter((o) => o.value === sel.value)[0] || null;
        if (opt && sel.value) {
          current.textContent = opt.textContent;
          current.classList.remove('empty');
        } else {
          current.textContent = root.dataset.placeholder || '请选择';
          current.classList.add('empty');
        }
      }

      function build(q) {
        q = (q || '').trim().toLowerCase();
        list.innerHTML = '';

        /* 数据源模式（字体库）：条目按查询即时生成，并且**限量渲染**。
           以前是把全量字体铺进两个 <select> 再整份渲染成行：
           实测 8000 条会让「字体列表送达」同步阻塞 ~56ms、打开下拉再花 ~47ms，
           而设计机器上的字体往往更多。限量后单次只留几十行。 */
        const useSource = typeof opts.getItems === 'function';
        let items;
        let limit = Infinity;
        if (useSource) {
          const src = opts.getItems(q);
          const stateText = typeof opts.getStateText === 'function' ? opts.getStateText() : '';
          if (src === null || stateText) {   // 等待、加载和失败分别展示
            if (emptyEl) {
              emptyEl.textContent = stateText || opts.loadingText || '正在加载…';
              emptyEl.style.display = 'block';
            }
            return;
          }
          items = src;
          limit = q ? (opts.searchLimit || 120) : (opts.limit || 40);
        } else {
          items = Array.from(sel.options).map((o) => ({ value: o.value, label: o.textContent }));
        }

        const shown = items.length > limit ? items.slice(0, limit) : items;
        if (emptyEl) {
          emptyEl.textContent = opts.emptyText || '无匹配';
          emptyEl.style.display = shown.length ? 'none' : 'block';
        }
        if (useSource && items.length > shown.length) {
          const more = document.createElement('div');
          more.className = 'dd-more';
          more.textContent = '还有 ' + (items.length - shown.length) + ' 个结果，输入关键词缩小范围';
          list.appendChild(more);
        }
        shown.forEach((o) => {
          const row = window.__uxpButton();
          row.type = 'button';
          row.className = 'dd-row' + (o.value === sel.value ? ' on' : '');
          const name = document.createElement('span');
          name.style.flex = '1';
          name.style.minWidth = '0';
          name.style.overflow = 'hidden';
          name.style.textOverflow = 'ellipsis';
          name.style.whiteSpace = 'nowrap';
          name.textContent = o.label;
          row.appendChild(name);
          const check = document.createElement('span');
          check.className = 'dd-row-check';
          check.textContent = '✓';
          row.appendChild(check);
          row.onclick = () => {
            // 数据源条目并不存在于 <select> 里，选中时补一条，保证取值链路照旧
            if (!Array.from(sel.options).some((x) => x.value === o.value)) {
              sel.appendChild(window.__uxpOption(o.label, o.value));
            }
            sel.value = o.value;
            sel.dispatchEvent(window.__uxpEvent('change'));
            syncDisplay();
            close();
            onPick(o.value);
          };
          list.appendChild(row);
        });
      }

      // 选中后回调上层（字体下拉用它同步「当前字体」状态）
      function onPick(value) {
        if (typeof opts.onPick === 'function') opts.onPick(value);
      }

      // 程序化赋值：若目标值不在选项里（例如识别到本机字体列表之外的字体），
      // 自动补一条选项，避免 select.value 被浏览器清空 → 后续取值拿到空字符串。
      function setValue(value, label) {
        if (value == null || value === '') { sel.value = ''; syncDisplay(); return; }
        let hit = Array.from(sel.options).find((o) => o.value === value);
        if (!hit) {
          hit = window.__uxpOption(label || value, value);
          sel.appendChild(hit);
        }
        sel.value = value;
        syncDisplay();
      }

      function open() {
        // 打开任一下拉时，收起其余所有弹层
        closeAllPickers();
        root.classList.add('open');
        pop.classList.add('open');
        // 打开时才按需取数：字体库体积大且加载慢，不该拖住插件启动
        if (typeof opts.onOpen === 'function') opts.onOpen();
        build(searchInput ? searchInput.value : '');
        fitPopup(pop, trigger, 280, 220);   // 面板矮时上翻并收紧高度
        /* UXP：不自动聚焦搜索框，原生输入框会盖住刚展开的列表 */
      }
      function close() {
        root.classList.remove('open');
        pop.classList.remove('open');
      }

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        pop.classList.contains('open') ? close() : open();
      });
      if (searchInput) {
        let searchDebounce = null;
        const runSearch = () => {
          if (searchDebounce) { clearTimeout(searchDebounce); searchDebounce = null; }
          build(searchInput.value);
        };
        searchInput.addEventListener('input', () => {
          if (searchDebounce) clearTimeout(searchDebounce);
          searchDebounce = setTimeout(runSearch, 90);
        });
        searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
      }
      root.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', close);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

      // 外部状态变化后重绘（字体库加载完成、默认值被写入等）
      function refresh() {
        syncDisplay();
        if (pop.classList.contains('open')) build(searchInput ? searchInput.value : '');
      }

      syncDisplay();
      return { syncDisplay, open, close, setValue, refresh };
    }

    ['cn-font', 'en-font'].forEach((id) => {
      const root = document.querySelector('.dd[data-target="' + id + '"]');
      if (!root) return;
      if (id === 'cn-font' || id === 'en-font') {
        const which = id === 'cn-font' ? 'cn' : 'en';
        ddRegistry[id] = initDropdown(root, {
          onPick: (v) => { fontSel[which] = parseFont(v); userTouched['#'+id] = true; },
          // 字体库走「数据源」模式：不预铺 <option>，打开时才请求、
          // 按关键词即时筛选并限量渲染（详见 fontItems / requestFontList）
          getItems: (q) => fontItems(q),
          getStateText: () => fontListStateText(),
          onOpen: () => requestFontList(),
          limit: 40,
          searchLimit: 120,
          loadingText: '正在加载字体库…（首次较慢，之后走缓存）',
          emptyText: '无匹配字体',
        });
      } else {
        ddRegistry[id] = initDropdown(root);
      }
    });

    // 当前「中/英文字体」的真实状态（取值只认它，不依赖 select.value 是否有效）
    function parseFont(json) {
      try { const f = JSON.parse(json); return f && f.family ? { family: f.family, style: f.style } : null; }
      catch (e) { return null; }
    }
    let symbolFontSide = null;
    function setSymbolFontSide(side) {
      symbolFontSide = side === 'cn' || side === 'en' ? side : null;
      document.querySelectorAll('[data-symbol-side]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.symbolSide === symbolFontSide));
      });
    }
    document.querySelectorAll('[data-symbol-side]').forEach((button) => {
      button.addEventListener('click', () => setSymbolFontSide(symbolFontSide === button.dataset.symbolSide ? null : button.dataset.symbolSide));
    });
    let lastSyncColor = false;   // 最近一次应用是否带颜色（默认不调整颜色）
    function fontLabel(f) { return f ? f.family + ' / ' + f.style : ''; }
    // 设置某一路字体：写状态 + 更新下拉显示（字体不在本机列表时自动补选项）
    function setFontValue(which, font) {
      fontSel[which] = font && font.family ? { family: font.family, style: font.style } : null;
      const id = which === 'cn' ? 'cn-font' : 'en-font';
      const dd = ddRegistry[id];
      if (dd) dd.setValue(fontSel[which] ? JSON.stringify(fontSel[which]) : '', fontLabel(fontSel[which]));
      const select = $('#'+id);
      if (!fontSel[which] && select) select.value = '';
    }

    // ---- 字体混排：应用（左右两半） ----
    // 左半 = 应用字体混排与颜色；右半 = 只应用字体混排（完全保留原文字颜色）。
    // syncColor 显式传给宿主（false 时宿主连颜色键都不建，默认值语义与开关一致）。
    function sendFontMix(withColor) {
      const cnFont = fontSel.cn || parseFont($('#cn-font').value);
      const enFont = fontSel.en || parseFont($('#en-font').value);
      if (!cnFont || !enFont) { figmaNotify('请先选择中英文各自的字体'); return; }
      const cfg = {
        cnFont,
        enFont,
        cnSize: numInput($('#cn-size')),
        enSize: numInput($('#en-size')),
        syncColor: !!withColor,
        symbolFontSide,
      };
      if (withColor) {
        cfg.cnColor = hexToRgb($('#cn-color').value);
        cfg.enColor = hexToRgb($('#en-color').value);
      }
      send({ type: 'font-mixer', config: cfg });
      lastSyncColor = !!withColor;   // 结果提示需要知道这次走的是哪半边
      // 立即反馈并启动等待守卫；主进程随后会回 font-mixer-start / font-mixer-done。
      // 即使主进程完全不回包，20 秒后也会明确告知，而不是永远停在「应用中…」。
      onFontMixStart({ total: 0 });
    }
    $('#font-apply-color').addEventListener('click', () => sendFontMix(true));
    $('#font-apply-nocolor').addEventListener('click', () => sendFontMix(false));

    /* ============================================================
       字体混排方案预设（仅字体混排功能 · 顶部下拉选择器）
       ============================================================ */
    /* 存储层：方案预设的持久化
       重要 —— Figma 插件 UI 运行在 data: URL 的 iframe 中，没有自己的域名，
       浏览器会直接拒绝 localStorage / cookie（抛 SecurityError）。
       所以真正的持久化必须交给主进程的 figma.clientStorage，用消息异步落盘。
       这里采用「内存为准 + localStorage 尽力缓存 + clientStorage 落盘」三层：
         · 内存      —— 所有读取都走它，任何环境都不会抛错（关键，避免保存静默失败）
         · localStorage —— 可用的环境（浏览器预览）即时读写，当快速缓存用
         · clientStorage —— 插件内真正持久，关掉插件再打开仍在 */
    const PK = 'figma-font-mixer-presets';
    let currentScheme = '';
    let fontPresets = [];     // 字体混排方案（内存态，唯一取值源）

    function lsRead(key) {
      try { return JSON.parse(window.localStorage.getItem(key)); } catch (e) { return null; }
    }
    function lsWrite(key, val) {
      try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* CEP 有真实 origin，可用 */ }
    }
    // 落盘：内存 → localStorage 缓存 + 主进程 clientStorage
    function persistPresets() {
      lsWrite(PK, fontPresets);
      send({ type: 'storage-save', data: { fontPresets } });
    }

    const getPresets = () => fontPresets;
    const setPresets = (list) => {
      fontPresets = Array.isArray(list) ? list : [];
      persistPresets();
      renderPresetPop();
    };

    // 读取当前表单，组成一个方案对象（字体取内存态，避免空值导致 JSON.parse 抛错）
    function readFormAsScheme(name) {
      return {
        name,
        cnFont: fontSel.cn || parseFont($('#cn-font').value),
        enFont: fontSel.en || parseFont($('#en-font').value),
        cnSize: numInput($('#cn-size')),
        enSize: numInput($('#en-size')),
        symbolFontSide,
        syncColor: lastSyncColor,   // 记录保存时是否同步颜色；旧方案无此字段，按关闭处理
        cnColor: hexToRgb($('#cn-color').value),
        enColor: hexToRgb($('#en-color').value),
      };
    }

    function setCurrentLabel(name) {
      currentScheme = name || '';
      const cur = $('#preset-current');
      cur.textContent = name || '未选择方案';
      cur.classList.toggle('empty', !name);
      // 选中方案后，保存按钮变为「更新当前方案」，改完直接覆盖
      const saveBtn = $('#preset-save');
      const nameInput = $('#preset-name');
      if (name) {
        saveBtn.textContent = '更新「' + name + '」';
        nameInput.placeholder = '重命名（留空保持不变）';
      } else {
        saveBtn.textContent = '保存为方案';
        nameInput.placeholder = '新方案名，如 中文正文';
      }
    }

    function moveFontPreset(name, delta) {
      const i = fontPresets.findIndex(p => p.name === name), j = i + delta;
      if (i < 0 || j < 0 || j >= fontPresets.length) return;
      const t = fontPresets[i]; fontPresets[i] = fontPresets[j]; fontPresets[j] = t; persistPresets(); renderPresetPop();
    }

    function renderPresetPop() {
      const list = $('#preset-pop-list');
      const q = ($('#preset-search').value || '').trim().toLowerCase();
      const items = getPresets().filter((p) => p.name.toLowerCase().includes(q));
      list.innerHTML = '';
      $('#preset-pop-empty').style.display = items.length ? 'none' : 'block';

      const def = window.__uxpButton();
      def.className = 'preset-row' + (!currentScheme ? ' on' : '');
      def.appendChild(window.__uxpSpan('preset-row-name', '默认'));
      def.appendChild(window.__uxpSpan('preset-row-tip', '识别选中'));
      def.onclick = () => { clearTouched(); setCurrentLabel(''); closePresetPop(); figmaNotify('已切换默认，恢复识别回填'); detectActive(); };
      list.appendChild(def);

      items.forEach((p) => {
        const row = window.__uxpButton();
        row.className = 'preset-row' + (p.name === currentScheme ? ' on' : '');

        const name = document.createElement('span');
        name.className = 'preset-row-name';
        name.textContent = p.name;

        row.appendChild(name);

        if (p.name === currentScheme) {
          const tip = document.createElement('span');
          tip.className = 'preset-row-tip';
          tip.textContent = '当前';
          row.appendChild(tip);
        }

        const up = document.createElement('span'); up.textContent = '↑'; up.title = '上移'; up.onclick = (ev) => { ev.stopPropagation(); moveFontPreset(p.name, -1); }; row.appendChild(up);
        const down = document.createElement('span'); down.textContent = '↓'; down.title = '下移'; down.onclick = (ev) => { ev.stopPropagation(); moveFontPreset(p.name, 1); }; row.appendChild(down);

        const del = document.createElement('span');
        del.className = 'preset-row-del';
        del.textContent = '×';
        del.title = '删除该方案';
        del.onclick = (ev) => { ev.stopPropagation(); deletePreset(p.name); };
        row.appendChild(del);

        row.onclick = () => {
          // 再次点击「当前」方案 = 取消选择，恢复识别回填（识别守卫见 fillFontFromDetect）
          if (p.name === currentScheme) {
            clearTouched();
            setCurrentLabel('');
            closePresetPop();
            figmaNotify('已取消方案，恢复识别回填');
            detectActive();
            return;
          }
          selectPreset(p.name);
        };
        list.appendChild(row);
      });
    }

    // 选中方案 → 填入表单（不直接改文档，需再点「应用字体混排」）
    function selectPreset(name) {
      const p = getPresets().find((x) => x.name === name);
      if (!p) return;
      applyPresetToForm(p);
      setCurrentLabel(name);
      closePresetPop();
      figmaNotify('已载入方案：' + name);
    }

    function deletePreset(name) {
      setPresets(getPresets().filter((p) => p.name !== name));
      if (currentScheme === name) setCurrentLabel('');
    }

    function applyPresetToForm(p) {
      setSymbolFontSide(p.symbolFontSide);
      clearTouched();   // 载入方案是显式意图，方案值优先于「用户手动改过」的状态
      $('#cn-size').placeholder = '如 14，留空不改';
      $('#en-size').placeholder = '如 12，留空不改';
      if (p.cnFont) setFontValue('cn', p.cnFont);
      if (p.enFont) setFontValue('en', p.enFont);
      $('#cn-size').value = p.cnSize != null ? p.cnSize : '';
      $('#en-size').value = p.enSize != null ? p.enSize : '';
      lastSyncColor = p.syncColor === true;   // 旧方案无此字段 → 默认不调整颜色
      if (p.cnColor) $('#cn-color').value = rgbToHex(p.cnColor);
      if (p.enColor) $('#en-color').value = rgbToHex(p.enColor);
      syncColorSwatch($('#cn-color'));
      syncColorSwatch($('#en-color'));
    }

    function openPresetPop() {
      // 方案与字体/格式下拉共用一套全局弹层：打开任一选择器前先收起其余弹层。
      closeAllPickers();
      $('#preset-pop').classList.add('open');
      $('#preset-bar').classList.add('open');
      fitPopup($('#preset-pop'), $('#preset-bar'), 300, 0);
    }
    function closePresetPop() {
      $('#preset-pop').classList.remove('open');
      $('#preset-bar').classList.remove('open');
    }

    $('#preset-trigger').addEventListener('click', (e) => {
      e.stopPropagation();
      $('#preset-pop').classList.contains('open') ? closePresetPop() : openPresetPop();
    });
    // 点击外部收起
    document.addEventListener('click', (e) => {
      if (!$('#preset-bar').contains(e.target)) closePresetPop();
    });
    // Esc 收起
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePresetPop();
    });
    let presetSearchDebounce = null;
    const runPresetSearch = () => {
      if (presetSearchDebounce) { clearTimeout(presetSearchDebounce); presetSearchDebounce = null; }
      renderPresetPop();
    };
    $('#preset-search').addEventListener('input', () => {
      if (presetSearchDebounce) clearTimeout(presetSearchDebounce);
      presetSearchDebounce = setTimeout(runPresetSearch, 90);
    });
    $('#preset-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') runPresetSearch(); });

    // 保存 / 更新方案：已选中方案时直接覆盖，可输入新名实现重命名
    $('#preset-save').addEventListener('click', () => {
      try {
        let name = $('#preset-name').value.trim();
        if (currentScheme) {
          if (!name) name = currentScheme;         // 留空 = 更新当前方案
        } else if (!name) {
          figmaNotify('请先输入方案名');
          $('#preset-name').focus();
          return;
        }

        let list = getPresets().filter((p) => p.name !== name);
        if (currentScheme && name !== currentScheme) {
          list = list.filter((p) => p.name !== currentScheme); // 改名：移除旧名
        }
        const scheme = readFormAsScheme(name);
        if (!scheme.cnFont || !scheme.enFont) {
          figmaNotify('字体信息缺失，请先选择中英文字体');
          return;
        }
        list.push(scheme);

        const renamed = currentScheme && name !== currentScheme;
        setPresets(list);
        setCurrentLabel(name);
        $('#preset-name').value = '';
        figmaNotify((renamed ? '已重命名并保存：' : '已保存方案：') + name);
      } catch (e) {
        // 任何异常都明确报出来，避免「点了没反应」这种静默失败
        figmaNotify('保存失败：' + (e && e.message ? e.message : e));
      }
    });

    // 导出全部方案
    $('#preset-export').addEventListener('click', () => {
      const all = getPresets();
      if (!all.length) { figmaNotify('当前没有可导出的方案'); return; }
      download('font-presets.json', JSON.stringify(all, null, 2), 'application/json');
    });

    // 导入方案（按名称去重合并）
    $('#preset-import-btn').addEventListener('click', () => $('#preset-import').click());
    $('#preset-import').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const imported = JSON.parse(r.result);
          if (!Array.isArray(imported)) throw new Error('格式错误');
          const merged = getPresets();
          let added = 0;
          imported.forEach((s) => {
            if (!s || typeof s.name !== 'string') return;
            const i = merged.findIndex((x) => x.name === s.name);
            if (i >= 0) { merged[i] = s; } else { merged.push(s); added++; }
          });
          setPresets(merged);
          figmaNotify(`已导入 ${imported.length} 个方案（新增 ${added}）`);
        } catch (e) { figmaNotify('JSON 解析失败，请检查文件'); }
      };
      r.readAsText(file);
      e.target.value = '';
    });

    renderPresetPop();


    // ---- 通知：面板内轻量提示条（替代 Figma 主进程 toast） ----
    let toastTimer = null;
    function figmaNotify(msg) {
      let el = document.getElementById('toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        document.body.appendChild(el);
      }
      el.textContent = String(msg || '');
      el.className = 'show';
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.className = ''; }, 2200);
    }



    function triggerDownload(name, blob) {
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
    }
    function download(name, text, mime) {
      triggerDownload(name, new Blob([text], { type: mime }));
    }


    // ---- 兜底：非插件环境（浏览器直接打开预览）填充示例 ----
    // 注意：CEP 面板同样满足 window.parent === window，需同时排除 CEP 运行时
    if (window.parent === window && !window.__adobe_cep__) {
      setTimeout(() => {
        if (!fontFamilies) {
          applyFontList({
            families: [
              { family: 'Inter', styles: ['Regular', 'Medium', 'Bold'] },
              { family: 'Roboto', styles: ['Regular', 'Bold'] },
              { family: '苹方-简', styles: ['Regular', 'Semibold'] },
              { family: '思源黑体', styles: ['Regular', 'Bold'] },
            ],
          });
          setPresets([
            { name: '中文正文 14/12', cnFont: { family: '苹方-简', style: 'Regular' }, enFont: { family: 'Inter', style: 'Regular' }, cnSize: 14, enSize: 12, syncColor: true, cnColor: hexToRgb('#222222'), enColor: hexToRgb('#444444') },
            { name: '中英混排标题 20/18', cnFont: { family: '苹方-简', style: 'Semibold' }, enFont: { family: 'Inter', style: 'Bold' }, cnSize: 20, enSize: 18, syncColor: true, cnColor: hexToRgb('#111111'), enColor: hexToRgb('#FF5A2B') },
          ]);
        }
      }, 200);
    }
  
;window.__cep = { getPresets, setPresets, figmaNotify, renderPresetPop };
