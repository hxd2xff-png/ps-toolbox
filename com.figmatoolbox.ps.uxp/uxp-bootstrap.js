/*
 * UXP 启动桥（只做引擎适配）
 * ------------------------------------------------------------
 * 1) 提供 UXP 缺失的 DOM/JS 能力：Event / Option / append / 按钮盒子。
 * 2) 提供 CSInterface 兼容层：CEP UI 脚本的 evalScript 调用转到 UXP host.js。
 * 3) 不改动 CEP 的 HTML/CSS/业务脚本；UI 脚本见 cep-ui.js（由 CEP 原文生成）。
 */
(function () {
  'use strict';

  var doc = document;

  function makeEvent(type, opts) {
    var ev = null;
    try {
      if (typeof window.Event === 'function') {
        return new window.Event(String(type), {
          bubbles: !!(opts && opts.bubbles),
          cancelable: !!(opts && opts.cancelable),
        });
      }
    } catch (e0) {}
    try {
      ev = doc.createEvent('HTMLEvents');
      ev.initEvent(String(type), !!(opts && opts.bubbles), !!(opts && opts.cancelable));
      return ev;
    } catch (e) {
      return {
        type: String(type),
        bubbles: !!(opts && opts.bubbles),
        cancelable: !!(opts && opts.cancelable),
        target: null,
        currentTarget: null,
        preventDefault: function () {},
        stopPropagation: function () {},
      };
    }
  }

  function makeOption(text, value) {
    var opt = doc.createElement('option');
    opt.textContent = String(text == null ? '' : text);
    opt.value = String(value == null ? text : value);
    return opt;
  }

  function makeSpan(className, text) {
    var span = doc.createElement('span');
    if (className) span.className = String(className);
    span.textContent = String(text == null ? '' : text);
    return span;
  }

  function activateOnKey(box) {
    box.addEventListener('keydown', function (e) {
      if (!e || (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar')) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (typeof box.click === 'function') box.click();
    });
  }

  // UXP 的原生 <button> 不承载子元素布局；用 div 等价盒替代。
  function makeButton() {
    var box = doc.createElement('div');
    box.setAttribute('role', 'button');
    box.setAttribute('tabindex', '0');
    activateOnKey(box);
    return box;
  }

  function copyAttributes(from, to) {
    try {
      var attrs = from.attributes;
      if (attrs && typeof attrs.length === 'number') {
        for (var i = 0; i < attrs.length; i += 1) {
          var attr = attrs[i];
          if (!attr || attr.name === 'type') continue;
          try { to.setAttribute(attr.name, attr.value); } catch (e) {}
        }
      } else if (attrs) {
        Object.keys(attrs).forEach(function (name) {
          if (name === 'type') return;
          try { to.setAttribute(name, attrs[name]); } catch (e) {}
        });
      }
    } catch (e) {}
  }

  // 静态按钮在 CEP 脚本绑定事件之前转换；无 class 的按钮（诊断按钮）保留原生外观。
  function convertStaticButton(button) {
    if (!button || String(button.tagName || '').toLowerCase() !== 'button') return button;
    if (!button.className || !String(button.className).trim()) return button;
    var box = makeButton();
    copyAttributes(button, box);
    if (button.className) box.className = button.className;
    if (button.id) box.id = button.id;
    if (typeof button.onclick === 'function') box.onclick = button.onclick;
    while (button.firstChild) box.appendChild(button.firstChild);
    if (button.parentNode && typeof button.parentNode.replaceChild === 'function') {
      button.parentNode.replaceChild(box, button);
      return box;
    }
    return button;
  }

  // 兼容层 API：cep-ui.js 里的 new Event / new Option / createElement('button') 已被
  // sync-uxp-ui.mjs 替换成这三个工厂，避免依赖 UXP 是否可写全局构造器。
  window.__uxpEvent = makeEvent;
  window.__uxpOption = makeOption;
  window.__uxpSpan = makeSpan;
  window.__uxpButton = makeButton;
  window.__uxpConvertButtons = function () {
    var buttons = doc.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i += 1) convertStaticButton(buttons[i]);
  };

  try { if (typeof window.Event !== 'function') window.Event = makeEvent; } catch (e) {}
  try { if (typeof window.Option !== 'function') window.Option = makeOption; } catch (e) {}
  try {
    var elementProto = Object.getPrototypeOf(doc.createElement('div'));
    function simpleMatches(node, selector) {
      var text = String(selector || '').trim();
      if (!text) return false;
      if (text.charAt(0) === '.') {
        return !!(node.classList && node.classList.contains(text.slice(1)));
      }
      if (text.charAt(0) === '#') return String(node.id || '') === text.slice(1);
      var attr = text.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (attr) {
        var value = node.getAttribute && node.getAttribute(attr[1]);
        return attr[2] === undefined ? value != null : String(value) === attr[2];
      }
      return String(node.tagName || '').toLowerCase() === text.toLowerCase();
    }
    if (!elementProto.matches) {
      elementProto.matches = function (selector) {
        var parts = String(selector || '').split(',');
        for (var i = 0; i < parts.length; i += 1) {
          if (simpleMatches(this, parts[i])) return true;
        }
        return false;
      };
    }
    if (!elementProto.closest) {
      elementProto.closest = function (selector) {
        var node = this;
        while (node && String(node.tagName || '').toLowerCase() !== 'document') {
          if (node.matches && node.matches(selector)) return node;
          node = node.parentNode;
        }
        return null;
      };
    }
    if (!elementProto.remove) {
      elementProto.remove = function () {
        if (this.parentNode && this.parentNode.removeChild) this.parentNode.removeChild(this);
      };
    }
    if (!elementProto.append) {
      elementProto.append = function () {
        for (var i = 0; i < arguments.length; i += 1) {
          var node = arguments[i];
          this.appendChild(typeof node === 'string' ? doc.createTextNode(node) : node);
        }
      };
    }
  } catch (e) {}

  // CEP uses querySelectorAll(...).forEach throughout. Some UXP builds expose a
  // NodeList with item/length but no forEach; adding it keeps the CEP source
  // unchanged instead of rewriting every call site.
  try {
    var probeList = doc.querySelectorAll('body');
    var listProto = probeList && Object.getPrototypeOf(probeList);
    if (listProto && !listProto.forEach) {
      listProto.forEach = function (fn, thisArg) {
        for (var i = 0; i < this.length; i += 1) fn.call(thisArg, this[i], i, this);
      };
    }
  } catch (e) {}

  // UXP 部分版本没有可用的 localStorage；退化为会话内存，保证保存/读取不抛错。
  try {
    window.localStorage.setItem('__uxp_probe__', '1');
    window.localStorage.removeItem('__uxp_probe__');
  } catch (e) {
    var memory = {};
    var fallback = {
        getItem: function (key) {
          return Object.prototype.hasOwnProperty.call(memory, String(key)) ? memory[String(key)] : null;
        },
        setItem: function (key, value) { memory[String(key)] = String(value); },
        removeItem: function (key) { delete memory[String(key)]; },
        clear: function () { memory = {}; },
    };
    try { window.localStorage = fallback; } catch (e2) {}
    try {
      if (window.localStorage !== fallback) {
        Object.defineProperty(window, 'localStorage', { value: fallback, configurable: true });
      }
    } catch (e3) {}
  }

  window.__uxpConvertButtons();

  /* ---------------- CSInterface 兼容层 ---------------- */
  window.SystemPath = window.SystemPath || {
    EXTENSION: 'extension',
    USER_DATA: 'userData',
    COMMON_FILES: 'commonFiles',
    MY_DOCUMENTS: 'myDocuments',
    APPLICATION: 'application',
  };
  window.__adobe_cep__ = window.__adobe_cep__ || {};

  function decodeArgs(enc) {
    if (!enc) return null;
    try { return JSON.parse(decodeURIComponent(enc)); } catch (e) { return null; }
  }

  function parseHostCall(script) {
    // hostCallExpr 的形状：... return f("type","encodedArgs");})()
    var match = script.match(/return f\(("(?:\\.|[^"\\])*"),("(?:\\.|[^"\\])*")\);/);
    if (!match) return null;
    try {
      return { type: JSON.parse(match[1]), args: decodeArgs(JSON.parse(match[2])) };
    } catch (e) {
      return null;
    }
  }
  window.__uxpParseHostCall = parseHostCall;

  function hostDispatch(type, args, done) {
    var host = null;
    try { host = require('./host.js'); } catch (e) {
      done(JSON.stringify({ error: String(e && e.message || e), api: type, stage: 'require-host' }));
      return;
    }
    if (!host || typeof host.dispatch !== 'function') {
      done(JSON.stringify({ error: 'UXP 宿主缺少 dispatch', api: type, stage: 'require-host' }));
      return;
    }
    Promise.resolve()
      .then(function () { return host.dispatch(type, args); })
      .then(function (data) { done(JSON.stringify(data)); })
      .catch(function (e) {
        done(JSON.stringify({ error: String(e && e.message || e), api: type, stage: 'uxp-dispatch' }));
      });
  }

  function evalScript(script, callback) {
    var source = String(script == null ? '' : script);
    function reply(value) {
      setTimeout(function () {
        if (typeof callback === 'function') callback(value);
      }, 0);
    }

    // CEP 启动/诊断探针：UXP 没有 ExtendScript，返回等价的成功形状。
    if (source === 'typeof cephostDispatch') { reply('function'); return; }
    if (source === '"CEP_CONST_OK"') { reply('CEP_CONST_OK'); return; }
    if (source.indexOf('OK|environment|') >= 0 && source.indexOf('app.version') >= 0) {
      reply('OK|environment|app=UXP|extendscript=UXP|engine=UXP|dispatch=function|File=undefined');
      return;
    }
    if (source.indexOf('file-read') >= 0 && source.indexOf('new File(') >= 0) {
      reply('OK|file-read|path=uxp|length=1|head=47');
      return;
    }
    if (source.indexOf('nested-eval') >= 0) { reply('OK|nested-eval'); return; }
    if (source.indexOf('LOADED head=') >= 0 && source.indexOf('cephostDispatch=') >= 0) {
      reply('ALREADY');
      return;
    }
    if (source.indexOf('diag.log') >= 0) { reply(''); return; }

    var call = parseHostCall(source);
    if (call) { hostDispatch(call.type, call.args, reply); return; }
    reply('');
  }

  function CSInterface() {}
  CSInterface.prototype.evalScript = function (script, callback) { evalScript(script, callback); };
  CSInterface.prototype.getSystemPath = function () { return ''; };
  window.CSInterface = CSInterface;

  // 把启动期未捕获异常写进 CEP 自带的诊断区（仅当区域为空，不覆盖业务输出）。
  function recordBootError(message) {
    try {
      var out = doc.getElementById('host-diagnostic-output');
      if (out && !String(out.textContent || '').trim()) {
        out.textContent = '[uxp-boot] ' + String(message || '未知启动异常');
      }
    } catch (e) {}
  }
  try {
    window.addEventListener('error', function (e) { recordBootError((e && (e.message || e.error)) || '脚本异常'); });
    window.addEventListener('unhandledrejection', function (e) {
      recordBootError((e && (e.reason && (e.reason.message || e.reason))) || '未处理 Promise 拒绝');
    });
  } catch (e) {}
})();
