/* 面板弹层自适应（不同分辨率 / 不同 Photoshop 面板尺寸）离线测试
   从 index.html 里抽出纯函数 popupFitPlan，对「面板尺寸 × 触发条位置」的
   网格做属性测试，保证：
     1) 弹层高度永不超过设计上限（280 / 300），也永不低于最小可用高度；
     2) 只要空间够（clipped=false），选定的方向一定能把弹层装进视口；
     3) 上方空间更多时向上翻，下方更多时向下；
     4) 字段比弹层窄时右对齐（这正是之前那段从未生效的死 CSS）。
*/
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'com.figmatoolbox.ps', 'index.html'), 'utf8');

let fails = 0;
const check = (ok, label, ev) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (ev === undefined ? '' : '   [' + ev + ']'));
  if (!ok) fails++;
};

/* ---------- 抽取纯函数 ---------- */
const start = html.indexOf('function popupFitPlan(');
if (start < 0) {
  console.log('FAIL  index.html 里找不到 popupFitPlan');
  process.exit(1);
}
const end = html.indexOf('\n    }', start);
const src = html.slice(start, end + 6);

/* 函数体引用了三个模块级常量，一并从源码抽出后注入（顺带校验取值） */
const pullConst = (name) => {
  const m = new RegExp(name + '\\s*=\\s*(\\d+)').exec(html);
  return m ? Number(m[1]) : null;
};
const gap = pullConst('POP_GAP'), pad = pullConst('POP_PAD'), minH = pullConst('POP_MIN_H');
check(gap === 7 && pad === 8 && minH === 96, '弹层常量符合预期（间距 7 / 留白 8 / 最小高 96）', gap + '/' + pad + '/' + minH);
const popupFitPlan = new Function('POP_GAP', 'POP_PAD', 'POP_MIN_H', 'return ' + src + ';')(gap, pad, minH);
check(typeof popupFitPlan === 'function', '从 index.html 抽出 popupFitPlan 并可调用');
check(/\.dd-pop\.flip-up, \.preset-pop\.flip-up \{[^}]*bottom: calc\(100% \+ 7px\)/.test(html),
  'CSS 里有向上展开规则（且间距与 POP_GAP 一致）');
check(/\.dd-pop\.align-right\s*\{/.test(html), 'CSS 里有 align-right 规则');
check(/fitPopup\(pop, trigger, 280, 220\)/.test(html), '下拉打开时调用 fitPopup');
check(/fitPopup\(\$\('#preset-pop'\), \$\('#preset-bar'\), 300, 0\)/.test(html), '方案弹层打开时调用 fitPopup');
check(/addEventListener\('resize', refitOpenPops\)/.test(html), '窗口尺寸变化时重新适配已打开的弹层');

/* ---------- 具体场景 ---------- */
const T = (top, bottom, width) => ({ top: top, bottom: bottom, width: width === undefined ? 300 : width });

let p = popupFitPlan(T(100, 140), 400, 920, 280, 220);
check(!p.flip && p.maxHeight === 280 && !p.clipped, '默认面板（400×920）：向下展开、不裁剪', JSON.stringify(p));

p = popupFitPlan(T(420, 460), 400, 920, 280, 220);
check(!p.flip && p.maxHeight === 280 && !p.clipped, '触发条靠下但下方放得下完整高度：仍然向下', JSON.stringify(p));

p = popupFitPlan(T(700, 740), 400, 920, 280, 220);
check(p.flip === true && p.maxHeight === 280, '下方只剩 165px、上方有 685px：上翻并保留完整高度', JSON.stringify(p));
check(700 - gap - p.maxHeight >= 0, '上翻后完整落在视口内', 'top=' + (700 - gap - p.maxHeight));

p = popupFitPlan(T(250, 290), 320, 320, 280, 220);
check(p.flip === true, '矮面板（320 高）+ 触发条靠底：改成向上展开', JSON.stringify(p));
check(250 - gap - p.maxHeight >= 0, '向上展开后完整落在视口内', 'top=' + (250 - gap - p.maxHeight));

p = popupFitPlan(T(40, 80), 320, 120, 280, 220);
check(p.clipped === true, '面板极端矮（上下都只剩 25px）：标记为裁剪', JSON.stringify(p));
check(p.maxHeight === minH, '极端矮时高度降到最小值而非 0', String(p.maxHeight));

p = popupFitPlan(T(100, 140, 150), 400, 920, 280, 220);
check(p.alignRight === true, '字段比弹层窄：右对齐', JSON.stringify(p));
p = popupFitPlan(T(100, 140, 300), 400, 920, 280, 220);
check(p.alignRight === false, '字段够宽：不需要右对齐', JSON.stringify(p));

p = popupFitPlan(T(100, 140), 400, 2160, 280, 220);
check(p.maxHeight === 280 && !p.flip, '超大面板：高度不超过设计上限', JSON.stringify(p));

/* ---------- 属性测试：面板尺寸 × 触发条位置 ---------- */
let cases = 0, badHeight = 0, badFit = 0, badDir = 0;
const vhs = [];
for (let vh = 200; vh <= 2160; vh += 40) vhs.push(vh);
vhs.forEach((vh) => {
  for (let top = 0; top <= vh; top += 23) {
    [280, 300].forEach((designMax) => {
      const t = T(top, Math.min(top + 40, vh));
      const plan = popupFitPlan(t, 640, vh, designMax, 220);
      cases++;
      if (plan.maxHeight > designMax || plan.maxHeight < minH) badHeight++;
      if (!plan.clipped) {
        const fitsBelow = (t.bottom + gap + plan.maxHeight) <= vh;
        const fitsAbove = (t.top - gap - plan.maxHeight) >= 0;
        if (plan.flip ? !fitsAbove : !fitsBelow) badFit++;
      }
      // 方向选择：下方放得下完整高度时绝不上翻
      const below = vh - t.bottom - gap - pad;
      if (below >= designMax && plan.flip) badDir++;
    });
  }
});
check(cases > 2000, '属性测试覆盖了足够多的尺寸组合', cases + ' 个用例');
check(badHeight === 0, '所有组合下 maxHeight 都在 [最小, 设计上限] 内', '违规 ' + badHeight);
check(badFit === 0, '所有空间足够的组合都能装进视口', '违规 ' + badFit);
check(badDir === 0, '下方够用时不会误翻到上方', '违规 ' + badDir);

console.log('\n' + (fails === 0 ? 'ALL PANEL FIT CHECKS PASSED' : fails + ' CHECK(S) FAILED'));
process.exit(fails === 0 ? 0 : 1);
