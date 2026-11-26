/*
 * UXP 交互适配层
 * ------------------------------------------------------------
 * CEP UI 脚本（cep-ui.js）保持原样运行；这里只替换 CEP 有、UXP 没有的宿主能力：
 *   - <input type=file> 文件选择 -> uxp.storage.localFileSystem 选择器
 *   - <a download> 导出 -> localFileSystem 保存
 *   - 原生输入框层级 -> 只遮住与展开弹层重叠的输入（配合 uxp-compat.css）
 *   - 诊断按钮 -> 读取 UXP host.js 的诊断 JSON（CEP 的 ExtendScript 步骤不适用）
 */
(function () {
  'use strict';

  var doc = document;
  var lifted = [];

  function ensureLogoGlyph() {
    try {
      var logo = doc.querySelector('.logo');
      if (!logo || logo.querySelector('.uxp-logo-glyph')) return;
      var glyph = doc.createElement('span');
      glyph.className = 'uxp-logo-glyph';
      glyph.setAttribute('aria-hidden', 'true');
      logo.appendChild(glyph);
    } catch (e) {}
  }

  function closestId(el, id) {
    var node = el;
    if (node && node.nodeType === 3) node = node.parentNode;
    while (node) {
      if (node.id === id) return node;
      node = node.parentNode;
    }
    return null;
  }

  function stop(e) {
    if (!e) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    else if (typeof e.stopPropagation === 'function') e.stopPropagation();
  }

  function toast(message) {
    try {
      if (window.__cep && typeof window.__cep.figmaNotify === 'function') {
        window.__cep.figmaNotify(message);
        return;
      }
    } catch (e) {}
    try {
      var out = doc.getElementById('host-diagnostic-output');
      if (out) out.textContent = String(message || '');
    } catch (e) {}
  }

  function storageModule() {
    try { return require('uxp').storage || null; } catch (e) { return null; }
  }

  function errorText(e) {
    return String(e && e.message ? e.message : e || '未知错误');
  }

  function mergeImportedText(text) {
    var imported;
    try { imported = JSON.parse(text); } catch (e) { toast('JSON 解析失败，请检查文件'); return; }
    if (!Array.isArray(imported)) { toast('JSON 解析失败，请检查文件'); return; }
    var api = window.__cep;
    if (!api || typeof api.getPresets !== 'function' || typeof api.setPresets !== 'function') {
      toast('方案存储接口未就绪');
      return;
    }
    var merged = api.getPresets();
    var added = 0;
    imported.forEach(function (scheme) {
      if (!scheme || typeof scheme.name !== 'string') return;
      var index = merged.findIndex(function (item) { return item.name === scheme.name; });
      if (index >= 0) merged[index] = scheme;
      else { merged.push(scheme); added += 1; }
    });
    api.setPresets(merged);
    toast('已导入 ' + imported.length + ' 个方案（新增 ' + added + '）');
  }

  function importPresets() {
    var storage = storageModule();
    if (!storage || !storage.localFileSystem) {
      toast('当前环境无法打开文件选择器');
      return;
    }
    storage.localFileSystem.getFileForOpening({ types: ['json'] })
      .then(function (file) {
        if (!file) return null;
        return file.read({ format: storage.formats.utf8 });
      })
      .then(function (text) {
        if (text != null) mergeImportedText(text);
      })
      .catch(function (e) { toast('导入失败：' + errorText(e)); });
  }

  function exportPresets() {
    var api = window.__cep;
    var all = api && typeof api.getPresets === 'function' ? api.getPresets() : [];
    if (!all.length) { toast('当前没有可导出的方案'); return; }
    var storage = storageModule();
    if (!storage || !storage.localFileSystem) {
      toast('当前环境无法打开文件选择器');
      return;
    }
    storage.localFileSystem.getFileForSaving('font-presets.json', { types: ['json'] })
      .then(function (file) {
        if (!file) return null;
        return file.write(JSON.stringify(all, null, 2), { format: storage.formats.utf8 });
      })
      .catch(function (e) { toast('导出失败：' + errorText(e)); });
  }

  function runUxpDiagnostics() {
    var out = doc.getElementById('host-diagnostic-output');
    if (!out) return;
    out.textContent = '--- UXP 宿主 ---\n正在读取诊断…';
    var host;
    try { host = require('./host.js'); } catch (e) {
      out.textContent = '--- UXP 宿主 ---\n读取失败：' + errorText(e);
      return;
    }
    Promise.resolve()
      .then(function () { return host.dispatch('diag', null); })
      .then(function (diag) {
        out.textContent = '--- 宿主 ---\n' + JSON.stringify(diag || {}, null, 2) +
          '\n临时文档自检：已跳过（UXP 版不做临时文档自检，请直接在真实图层上验证区间写入）';
      })
      .catch(function (e) {
        out.textContent = '--- UXP 宿主 ---\n读取失败：' + errorText(e);
      });
  }

  doc.addEventListener('click', function (e) {
    var target = e && e.target;
    if (!target) return;
    if (closestId(target, 'preset-import-btn')) {
      stop(e);
      importPresets();
      return;
    }
    if (closestId(target, 'preset-export')) {
      stop(e);
      exportPresets();
      return;
    }
    if (closestId(target, 'host-diagnose')) {
      stop(e);
      runUxpDiagnostics();
    }
  }, true);

  function restoreLift() {
    for (var i = lifted.length - 1; i >= 0; i -= 1) {
      var item = lifted[i];
      try {
        if (item.prev == null) item.node.style.removeProperty(item.prop);
        else item.node.style.setProperty(item.prop, item.prev, item.priority || '');
      } catch (e) {}
    }
    lifted = [];
  }

  function setLift(node, prop, value) {
    if (!node || !node.style) return;
    var prev = null, priority = '';
    try {
      prev = node.style.getPropertyValue(prop) || null;
      priority = node.style.getPropertyPriority(prop) || '';
      node.style.setProperty(prop, value, 'important');
    } catch (e) {}
    lifted.push({ node: node, prop: prop, prev: prev, priority: priority });
  }

  // UXP's native stacking is less reliable than CEP's Chromium. Lift the open
  // picker and its card above later cards so the list is not painted underneath
  // the next form row.
  function liftOpenPicker(root) {
    restoreLift();
    if (!root) return;
    setLift(root, 'z-index', '10000');
    var pop = root.querySelector('.dd-pop, .preset-pop');
    if (pop) setLift(pop, 'z-index', '10001');
    var node = root.parentNode;
    while (node && node !== doc.body) {
      var cls = node.classList;
      if (cls && (cls.contains('card') || cls.contains('panel'))) {
        setLift(node, 'position', 'relative');
        setLift(node, 'z-index', cls.contains('card') ? '9000' : '8000');
      }
      node = node.parentNode;
    }
  }

  // UXP 的原生输入框永远画在 HTML 之上。不能像 CEP 那样只靠 z-index，
  // 但也不能把面板输入全部隐藏：只遮住真正与展开弹层重叠的输入，
  // 弹层之外的字号/字色等字段必须继续可见。
  var popupOpen = null;
  var liftedRoot = null;
  var syncTimer = 0;
  var interactionHoldUntil = 0;
  var motionPop = null;
  var maskInputs = null;

  function markInteraction(ms) {
    var until = Date.now() + (ms || 300);
    if (until > interactionHoldUntil) interactionHoldUntil = until;
  }

  function insidePickerLayer(node) {
    while (node && node !== doc.body) {
      var cls = node.classList;
      if (cls && (cls.contains('dd-pop') || cls.contains('preset-pop'))) return true;
      node = node.parentNode;
    }
    return false;
  }

  // CEP 的 500ms 选区轮询在 UXP 中会跨进程读取整棵 activeLayers。
  // 滚动、点击、输入和弹层打开期间暂停，交互结束后再恢复。
  function shouldPausePoll() {
    if (popupOpen) return true;
    if (interactionHoldUntil && Date.now() < interactionHoldUntil) return true;
    var active = null;
    try { active = doc.activeElement; } catch (e) {}
    if (!active || !/^(INPUT|TEXTAREA|SELECT)$/.test(String(active.tagName || ''))) return false;
    // 弹层里的搜索框在关闭后可能仍保留焦点；它不算正在编辑业务字段。
    return !insidePickerLayer(active);
  }
  window.__uxpShouldPausePoll = shouldPausePoll;

  function insideOpenPopup(node) {
    while (node && node !== doc.body) {
      var cls = node.classList;
      if (cls && cls.contains('open') &&
          (cls.contains('dd-pop') || cls.contains('preset-pop'))) return true;
      node = node.parentNode;
    }
    return false;
  }

  function overlaps(a, b) {
    return a.left < b.right && a.right > b.left &&
      a.top < b.bottom && a.bottom > b.top;
  }

  function textInputs() {
    if (!maskInputs) {
      maskInputs = doc.querySelectorAll('input[type="text"], input[type="number"]');
    }
    return maskInputs;
  }

  function setPopupUnder(input, under) {
    var current = false;
    try { current = input.classList.contains('uxp-popup-under'); } catch (e) {}
    if (current === under) return;
    try { input.classList.toggle('uxp-popup-under', under); } catch (e) {}
  }

  function clearNativeInputMask() {
    var inputs = textInputs();
    for (var i = 0; i < inputs.length; i++) setPopupUnder(inputs[i], false);
  }

  function syncNativeInputMask() {
    var pops = doc.querySelectorAll('.dd-pop.open, .preset-pop.open');
    var rects = [];
    for (var i = 0; i < pops.length; i++) {
      var pr = pops[i].getBoundingClientRect();
      if (pr.width && pr.height) {
        // 留 2px 余量，避免原生输入描边从弹层圆角边缘透出。
        rects.push({ left: pr.left - 2, top: pr.top - 2, right: pr.right + 2, bottom: pr.bottom + 2 });
      }
    }
    if (!rects.length) {
      clearNativeInputMask();
      return;
    }
    var inputs = textInputs();
    for (var j = 0; j < inputs.length; j++) {
      var input = inputs[j], under = false;
      if (!insideOpenPopup(input)) {
        var ir = input.getBoundingClientRect();
        for (var k = 0; k < rects.length; k++) {
          if (overlaps(ir, rects[k])) { under = true; break; }
        }
      }
      setPopupUnder(input, under);
    }
  }

  // UXP 不支持 CSS transition/animation。这里只用 requestAnimationFrame
  // 对 opacity/transform 做 150~180ms 的短补间，不碰布局属性。
  function animateMotion(el, fromY, fromScale, duration, openClass) {
    if (!el || !el.style || typeof window.requestAnimationFrame !== 'function') return;
    var start = null;
    try {
      el.style.opacity = '0';
      el.style.transform = 'translateY(' + fromY + 'px)' +
        (fromScale ? ' scale(' + fromScale + ')' : '');
    } catch (e) { return; }
    function finish() {
      try { el.style.removeProperty('opacity'); } catch (e) {}
      try { el.style.removeProperty('transform'); } catch (e) {}
    }
    function step(ts) {
      if (openClass && !el.classList.contains(openClass)) { finish(); return; }
      if (start == null) start = ts;
      var t = Math.min(1, Math.max(0, (ts - start) / duration));
      var eased = 1 - Math.pow(1 - t, 3);
      try {
        el.style.opacity = String(eased);
        el.style.transform = 'translateY(' + (fromY * (1 - eased)) + 'px)' +
          (fromScale ? ' scale(' + (fromScale + (1 - fromScale) * eased) + ')' : '');
      } catch (e) {}
      if (t < 1) window.requestAnimationFrame(step);
      else finish();
    }
    window.requestAnimationFrame(step);
  }

  function animatePopupOpen(pop) {
    if (!pop || motionPop === pop) return;
    motionPop = pop;
    animateMotion(pop, pop.classList.contains('flip-up') ? 6 : -6, 0.98, 150, 'open');
  }

  var lastActivePanel = null;
  function animateActivePanel() {
    var panel = doc.querySelector('.panel.active');
    if (!panel) return;
    if (!lastActivePanel) { lastActivePanel = panel; return; }
    if (panel === lastActivePanel) return;
    lastActivePanel = panel;
    animateMotion(panel, 4, 0.995, 180, null);
  }

  function syncPopupState() {
    var root = doc.querySelector('.dd.open') || doc.querySelector('.preset-bar.open');
    var pop = root ? root.querySelector('.dd-pop.open, .preset-pop.open') : null;
    var open = !!pop;
    if (open !== popupOpen) {
      popupOpen = open;
      try { doc.body.classList.toggle('popup-open', open); } catch (e) {}
    }
    if (!open) {
      motionPop = null;
      clearNativeInputMask();
      if (liftedRoot) {
        liftedRoot = null;
        restoreLift();
      }
      return;
    }
    syncNativeInputMask();
    if (open && root !== liftedRoot) {
      liftedRoot = root;
      liftOpenPicker(root);
    }
    animatePopupOpen(pop);
  }

  function schedulePopupSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = 0;
      syncPopupState();
    }, 16);
  }

  // 事件驱动，不再每 100ms 无条件查询所有输入并触发布局。
  doc.addEventListener('mousedown', function () { markInteraction(400); }, true);
  doc.addEventListener('focusin', function () { markInteraction(300); }, true);
  doc.addEventListener('input', function () {
    markInteraction(300);
    if (popupOpen) {
      schedulePopupSync();
      // 搜索列表有 90ms 防抖；列表高度变化后再校准一次原生输入遮罩。
      setTimeout(function () { if (popupOpen) schedulePopupSync(); }, 120);
    }
  }, true);
  doc.addEventListener('click', function () {
    markInteraction(300);
    schedulePopupSync();
    setTimeout(animateActivePanel, 0);
  }, true);
  doc.addEventListener('keydown', function () {
    markInteraction(300);
    schedulePopupSync();
  }, true);
  function onScroll() {
    markInteraction(300);
    if (popupOpen) schedulePopupSync();
  }
  doc.addEventListener('scroll', onScroll, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', schedulePopupSync);

  syncPopupState();
  lastActivePanel = doc.querySelector('.panel.active');
  ensureLogoGlyph();
})();
