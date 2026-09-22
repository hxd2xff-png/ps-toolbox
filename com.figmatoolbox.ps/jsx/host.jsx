/* ============================================================
   PS Toolbox - ExtendScript host v4.0.0 (ASCII only, BOM free)
   Features: font mixing / style detect / optical kerning + leading Auto /
             font list / selection signature / PS color picker /
             environment probe + temp-document self test.
   ------------------------------------------------------------
   ExtendScript is ES3: no JSON, no arrow functions, no let/const,
   no Array extras. Input: encodeURIComponent(JSON) -> eval.
   Output: hand written minimal JSON serializer (jval).

   RULES (learned the hard way):
   - This file must stay pure ASCII and BOM free.
   - Every API reports WHERE it failed: the dispatcher appends the
     last stage marker plus the error line to any thrown error.
   - Property access may return `undefined` instead of throwing in
     some Photoshop builds (document.activeLayers). Never assume a
     collection is there: always check typeof length.

   TEXT PIPELINE NOTE (v4)
   The previous build wrote ranges with
       null -> ActionReference.putIndex(TxLr, itemIndex)
       'T   ' = Ordn:Styl
       'T   ' = [ {From, Tckn, TxtS:{...}} ]
   and every write failed on PS 21 with "the command Set is not
   currently available" / "Illegal argument - parameter 1".
   The shape below is the one Photoshop itself records and the one
   a working text-mixing extension on this machine uses:

     read : ref.putProperty('property','textKey')
            ref.putIdentifier('layer', id)
            -> executeActionGet(ref).getObjectValue('textKey')
     write: ref.putIdentifier('textLayer', id)
            desc.putReference('null', ref)
            desc.putObject('to', 'textLayer', textKeyDescriptor)
            executeAction('set', desc, DialogModes.NO)

   The whole textKey descriptor is rebuilt from a read, all style
   ranges are re-emitted, `engineData` is dropped (it is an opaque
   snapshot of the old typesetting), and the result is verified by
   reading the fonts back.
   ============================================================ */

var cephostDispatch = (function () {

    var HOST_VERSION = '4.3.1';
    var _stage = 'init';
    function stage(s) { _stage = s; return s; }

    /* ---------------- basics ---------------- */

    function clamp(v, lo, hi) { if (v < lo) return lo; if (v > hi) return hi; return v; }

    function isCJK(ch) {
        var c = ch.charCodeAt(0);
        if (c >= 0x3000 && c <= 0x303F) return true;  // CJK punct: comma, corner brackets
        if (c >= 0x3040 && c <= 0x30FF) return true;  // kana
        if (c >= 0x3400 && c <= 0x4DBF) return true;  // ext A
        if (c >= 0x4E00 && c <= 0x9FFF) return true;  // CJK unified
        if (c >= 0xAC00 && c <= 0xD7AF) return true;  // hangul
        if (c >= 0xF900 && c <= 0xFAFF) return true;  // compat ideographs
        if (c >= 0xFF00 && c <= 0xFFEF) return true;  // fullwidth forms: brackets, marks, yen
        return false;
    }

    function esc(s) {
        s = String(s);
        var out = '', i, c, code;
        for (i = 0; i < s.length; i++) {
            c = s.charAt(i); code = s.charCodeAt(i);
            if (c === '"') out += '\\"';
            else if (c === '\\') out += '\\\\';
            else if (c === '\n') out += '\\n';
            else if (c === '\r') out += '\\r';
            else if (c === '\t') out += '\\t';
            else if (code < 0x20) out += '\\u' + ('000' + code.toString(16)).slice(-4);
            else out += c;
        }
        return out;
    }
    function jstr(s) { return '"' + esc(s) + '"'; }
    function jnum(n) {
        if (typeof n !== 'number' || isNaN(n) || !isFinite(n)) return 'null';
        return String(n);
    }
    function jval(v) {
        var i, parts;
        if (v === null || v === undefined) return 'null';
        var t = typeof v;
        if (t === 'string') return jstr(v);
        if (t === 'number') return jnum(v);
        if (t === 'boolean') return String(v);
        if (v instanceof Array) {
            parts = [];
            for (i = 0; i < v.length; i++) parts.push(jval(v[i]));
            return '[' + parts.join(',') + ']';
        }
        parts = [];
        for (var k in v) if (v.hasOwnProperty(k)) parts.push(jstr(k) + ':' + jval(v[k]));
        return '{' + parts.join(',') + '}';
    }
    function errText(e) {
        if (!e) return 'unknown error';
        var m = (e.message !== undefined && e.message !== null) ? e.message : String(e);
        return String(m).slice(0, 200);
    }
    function numOrNull(v) {
        if (v === null || v === undefined || v === '') return null;
        var n = parseFloat(v);
        return (isNaN(n) || !isFinite(n)) ? null : n;
    }
    function rgbSafe(rgb) {
        if (!rgb) return null;
        var r = numOrNull(rgb.r), g = numOrNull(rgb.g), b = numOrNull(rgb.b);
        if (r === null || g === null || b === null) return null;
        return { r: clamp(r, 0, 1), g: clamp(g, 0, 1), b: clamp(b, 0, 1) };
    }
    function inArray(arr, v) {
        for (var i = 0; i < arr.length; i++) if (arr[i] === v) return true;
        return false;
    }

    var _trace = '';
    var _lastPS = '';
    var _substituted = false;   // last verify failure was a font substitution

    /* ---------------- Action Manager basics ----------------
       The text pipeline uses long string IDs (stringIDToTypeID):
       they are the identifiers Photoshop records itself, and they
       are what the implementation proven on this machine uses. */

    var _ids = {};
    function S(k) {
        if (typeof _ids[k] === 'undefined') _ids[k] = stringIDToTypeID(k);
        return _ids[k];
    }
    function copyDesc(d) {
        var n = new ActionDescriptor();
        n.fromStream(d.toStream());
        return n;
    }
    function hasKey(d, k) {
        try { return d.hasKey(S(k)); } catch (e) { return false; }
    }
    function eraseKey(d, k) {
        try { var id = S(k); if (d.hasKey(id)) d.erase(id); } catch (e) { }
    }
    function eraseKeys(d, keys) {
        for (var i = 0; i < keys.length; i++) eraseKey(d, keys[i]);
    }

    /* ---------------- document / layer collection ----------------
       Property access can yield undefined instead of throwing, so
       every hop is checked. Fallback chain: activeLayers ->
       selectedLayers -> [activeLayer]. The source is reported back. */

    function docSafe() {
        try { return app.activeDocument || null; } catch (e) { return null; }
    }
    function asArray(x) {
        if (!x) return null;
        try { if (typeof x.length === 'number') return x; } catch (e) { }
        return null;
    }
    function activeLayerSource() {
        var d = docSafe();
        if (!d) return { refs: [], from: 'no-document' };
        var l = null;
        try { l = asArray(d.activeLayers); } catch (e1) { }
        if (l && l.length) return { refs: l, from: 'activeLayers' };
        try { l = asArray(d.selectedLayers); } catch (e2) { }
        if (l && l.length) return { refs: l, from: 'selectedLayers' };
        try {
            var one = d.activeLayer;
            if (one) return { refs: [one], from: 'activeLayer' };
        } catch (e3) { }
        return { refs: [], from: 'empty' };
    }
    function activeLayersSafe() { return activeLayerSource().refs; }

    function walkOne(layer, fn) {
        try {
            if (layer.typename === 'LayerSet') {
                var kids = asArray(layer.layers);
                if (kids) for (var i = 0; i < kids.length; i++) walkOne(kids[i], fn);
                return;
            }
            fn(layer);
        } catch (e) { }
    }
    function walkLayers(refs, fn) {
        if (!refs || typeof refs.length !== 'number') return;
        for (var i = 0; i < refs.length; i++) walkOne(refs[i], fn);
    }
    function isTextLayer(l) {
        try {
            if (typeof LayerKind !== 'undefined' && LayerKind && LayerKind.TEXT !== undefined) return l.kind === LayerKind.TEXT;
        } catch (e) { }
        try { return !!l.textItem; } catch (e2) { }
        return false;
    }

    /* ---------------- font index ---------------- */

    var _fontIndex = null;
    function fontIndex() {
        if (_fontIndex) return _fontIndex;
        var list = [];
        try {
            for (var i = 0; i < app.fonts.length; i++) {
                var f = app.fonts[i];
                list.push({ family: String(f.family), style: String(f.style), name: String(f.postScriptName) });
            }
        } catch (e) { }
        _fontIndex = list;
        return list;
    }
    function psNameOf(family, style) {
        if (!family) return null;
        var list = fontIndex(), i, f;
        for (i = 0; i < list.length; i++) {
            f = list[i];
            if (f.family === family && f.style === style) return f.name;
        }
        for (i = 0; i < list.length; i++) {
            f = list[i];
            if (f.family === family) return f.name;
        }
        return null;
    }
    function metaOfPSName(psName) {
        var list = fontIndex(), i;
        for (i = 0; i < list.length; i++) if (list[i].name === psName) return list[i];
        return null;
    }
    // Symbol / emoji faces carry no Latin glyphs: Photoshop substitutes them,
    // the ranges merge and a write looks broken when it is not. Never use them
    // as test fonts.
    function isSymbolFont(psName) {
        return /Emoji|Symbol|Wingdings|Webdings|Marlett|Dingbat|Ornament|Icons?\b|Math|Pi\b|Music|Cards/i.test(String(psName));
    }
    function familyOfPSName(psName) {
        var m = metaOfPSName(psName);
        return m ? m.family : '';
    }
    // excludeFamily keeps the second test font in a different family, so the
    // self test really exercises a family switch (Bold of the same face is not)
    function pickFontFor(role, exclude, excludeFamily) {
        var list = fontIndex(), i, n, pass;
        for (pass = 0; pass < 2; pass++) {
            for (i = 0; i < list.length; i++) {
                n = list[i].name;
                if (exclude && n === exclude) continue;
                if (excludeFamily && list[i].family === excludeFamily) continue;
                if (isSymbolFont(n)) continue;
                if (pass === 0) {
                    if (role === 'cn' && !/CJK|SC$|SC-|GB|Hei|Song|Ming|YaHei|SimSun|SimHei|SourceHan|MiSans|PingFang|NotoSansSC|NotoSerifSC|HarmonyOS/i.test(n)) continue;
                    if (role === 'en' && !/Regular|Book|Roman|Inter|Helvetica|Arial|Roboto|Segoe|Lato|Montserrat|Noto ?Sans|Source ?Sans|MiSans|PingFang/i.test(n)) continue;
                }
                return n;
            }
        }
        return '';
    }

    /* ---------------- text: read ---------------- */

    function textKeyOf(layerId) {
        var ref = new ActionReference();
        ref.putProperty(S('property'), S('textKey'));
        ref.putIdentifier(S('layer'), layerId);
        return executeActionGet(ref).getObjectValue(S('textKey'));
    }

    /* Layer transform compensation.
       A free-transformed text layer carries a transform matrix in its textKey;
       Photoshop stores style sizes as PRE-transform base values and the
       character panel shows base x K. An AM write of v is treated as the
       panel size (PS stores base = v/K internally), so writes stay raw and
       read-backs must be multiplied by K before comparing. K = |xx| of the
       matrix (uniform scaling keeps xx == yy). */
    function layerScaleOf(layerId) {
        try {
            var tk = textKeyOf(layerId);
            if (tk && tk.hasKey(S('transform'))) {
                var tf = tk.getObjectValue(S('transform'));
                if (tf.hasKey(S('xx'))) {
                    var xx = tf.getDouble(S('xx'));
                    if (isFinite(xx) && Math.abs(xx) > 0.0001) return Math.abs(xx);
                }
            }
        } catch (eS) { }
        return 1;
    }

    // Photoshop stores text colours as RGB doubles 0..255 under
    // red/grain/blue (the long names of Rd  /Grn /Bl  ).
    function rgbFromColorDesc(cd) {
        try {
            if (cd.hasKey(S('red')) && cd.hasKey(S('grain')) && cd.hasKey(S('blue'))) {
                return {
                    r: cd.getDouble(S('red')) / 255,
                    g: cd.getDouble(S('grain')) / 255,
                    b: cd.getDouble(S('blue')) / 255
                };
            }
        } catch (e) { }
        return null;
    }

    function styleInfoOf(st) {
        var info = { psName: null, size: null, rgb: null, trck: null };
        if (!st) return info;
        try { if (st.hasKey(S('fontPostScriptName'))) info.psName = String(st.getString(S('fontPostScriptName'))); } catch (e1) { }
        try {
            // size may be stored as a unit double (points/pixels) or a plain double
            // depending on how the style was written; try unit first, fall back.
            var sizeVal = null;
            if (st.hasKey(S('size'))) {
                try { sizeVal = st.getUnitDoubleValue(S('size')); } catch (eU) { sizeVal = null; }
                if (!(sizeVal && isFinite(sizeVal))) { try { sizeVal = st.getDouble(S('size')); } catch (eD) { sizeVal = null; } }
            } else if (st.hasKey(S('Sz  '))) {
                try { sizeVal = st.getUnitDoubleValue(S('Sz  ')); } catch (eU2) { sizeVal = null; }
                if (!(sizeVal && isFinite(sizeVal))) { try { sizeVal = st.getDouble(S('Sz  ')); } catch (eD2) { sizeVal = null; } }
            }
            if (sizeVal && isFinite(sizeVal)) info.size = Math.round(sizeVal * 100) / 100;
        } catch (e2) { }
        try { if (st.hasKey(S('color'))) info.rgb = rgbFromColorDesc(st.getObjectValue(S('color'))); } catch (e3) { }
        try {
            if (st.hasKey(S('tracking'))) {
                var t = st.getInteger(S('tracking'));
                if (isFinite(t)) info.trck = t;
            }
        } catch (e4) { }
        try { if (st.hasKey(S('autoLeading'))) info.autoLeading = (st.getBoolean(S('autoLeading')) === true); } catch (e5) { }
        return info;
    }

    // Throws on failure: detection must never silently report "no font".
    function readRanges(layerId, textLen) {
        var tk = textKeyOf(layerId);
        var list = tk.getList(S('textStyleRange'));
        var out = [], i, r, info;
        for (i = 0; i < list.count; i++) {
            r = list.getObjectValue(i);
            info = styleInfoOf(hasKey(r, 'textStyle') ? r.getObjectValue(S('textStyle')) : null);
            info.from = r.getInteger(S('from'));
            info.to = r.getInteger(S('to'));
            if (textLen && info.to > textLen) info.to = textLen;
            out.push(info);
        }
        return out;
    }

    function textContentsOf(layer) {
        var t = '';
        try { t = layer.textItem.contents || ''; } catch (e) { }
        if (!t.length) {
            try { t = textKeyOf(layer.id).getString(S('textKey')) || ''; } catch (e2) { }
        }
        return String(t);
    }

    /* ---------------- text: write ---------------- */

    // Font identity metadata must never be carried across families:
    // stale metadata makes Photoshop report the wrong font back.
    var FONT_META = ['fontName', 'fontStyleName', 'fontScript', 'fontTechnology', 'fontAvailable'];

    // Range font size. Photoshop builds accept different key/unit pairs and a
    // wrong one can be ignored SILENTLY (no exception, size just not changed),
    // so every candidate is verified by reading the size back and the first
    // working one is cached for the session.
    var SIZE_MODES = ['size/pointsUnit', 'size/pixelsUnit', 'size+implied', 'Sz  /points'];
    var _sizeMode = -1;        // discovered mode, -1 = not discovered yet
    var _sizeModeTrying = -1;  // mode being written right now
    var _layerScale = 1;       // transform scale of the layer being written

    function sizeModeInUse() {
        if (_sizeModeTrying >= 0) return _sizeModeTrying;
        return (_sizeMode >= 0) ? _sizeMode : 0;
    }

    function putSize(style, v) {
        var mode = sizeModeInUse();
        if (mode === 1) style.putUnitDouble(S('size'), S('pixelsUnit'), v);
        else if (mode === 2) {
            style.putUnitDouble(S('size'), S('pointsUnit'), v);
            style.putUnitDouble(S('impliedFontSize'), S('pointsUnit'), v);
        } else if (mode === 3) style.putUnitDouble(S('Sz  '), S('pointsUnit'), v);
        else style.putUnitDouble(S('size'), S('pointsUnit'), v);
    }

    function colorDescOf(rgb) {
        var c = rgbSafe(rgb) || { r: 0, g: 0, b: 0 };
        var d = new ActionDescriptor();
        d.putDouble(S('red'), c.r * 255);
        d.putDouble(S('grain'), c.g * 255);
        d.putDouble(S('blue'), c.b * 255);
        return d;
    }

    function overrideStyle(style, seg) {
        if (seg.psName) {
            eraseKeys(style, FONT_META);
            style.putString(S('fontPostScriptName'), seg.psName);
        }
        var sz = numOrNull(seg.size);
        if (sz !== null) putSize(style, sz);   // raw: PS treats the AM value as the panel size
        var c = rgbSafe(seg.rgb);
        if (c) style.putObject(S('color'), S('RGBColor'), colorDescOf(c));
        var tr = numOrNull(seg.trck);
        if (tr !== null) style.putInteger(S('tracking'), Math.round(tr));
        if (seg.autoLeading) style.putBoolean(S('autoLeading'), true);
    }

    // the existing style range that covers `index` (or the terminal one)
    function pickBaseRange(oldList, index) {
        var i, r, from, to;
        for (i = 0; i < oldList.count; i++) {
            r = oldList.getObjectValue(i);
            from = r.getInteger(S('from'));
            to = r.getInteger(S('to'));
            if (index >= from && index < to) return r;
        }
        if (oldList.count) return oldList.getObjectValue(oldList.count - 1);
        return null;
    }

    // plan: contiguous {from,to,psName,size,rgb,trck} covering [0,textLen)
    function applyRanges(layerId, plan, textLen) {
        _layerScale = layerScaleOf(layerId);   // compensate layer transforms
        var tk = textKeyOf(layerId);
        var old = tk.getList(S('textStyleRange'));
        var list = new ActionList();
        var i, seg, base, item, style;
        for (i = 0; i < plan.length; i++) {
            seg = plan[i];
            base = pickBaseRange(old, seg.from);
            item = base ? copyDesc(base) : new ActionDescriptor();
            style = hasKey(item, 'textStyle') ? copyDesc(item.getObjectValue(S('textStyle'))) : new ActionDescriptor();
            overrideStyle(style, seg);
            item.putInteger(S('from'), seg.from);
            item.putInteger(S('to'), seg.to);
            item.putObject(S('textStyle'), S('textStyle'), style);
            list.putObject(S('textStyleRange'), item);
        }
        // engineData is an opaque snapshot of the old typesetting.
        // Writing it back alongside fresh ranges reverts the change.
        if (hasKey(tk, 'engineData')) eraseKey(tk, 'engineData');
        tk.putList(S('textStyleRange'), list);
        var ref = new ActionReference();
        ref.putIdentifier(S('textLayer'), layerId);
        var set = new ActionDescriptor();
        set.putReference(S('null'), ref);
        set.putObject(S('to'), S('textLayer'), tk);
        executeAction(S('set'), set, DialogModes.NO);
    }

    function stripSize(plan) {
        var out = [], i, p;
        for (i = 0; i < plan.length; i++) {
            p = plan[i];
            out.push({ from: p.from, to: p.to, psName: p.psName, size: null, rgb: p.rgb, trck: p.trck });
        }
        return out;
    }

    // Sizes are the one field Photoshop may silently ignore, so when a size is
    // requested the write is repeated with each candidate key/unit pair until
    // the size reads back correctly; the working mode is cached. If none works
    // the fonts are still applied and the panel is told the size did not take.
    function applyRangesSafe(layerId, plan, textLen, notes) {
        var wantSize = false, i;
        for (i = 0; i < plan.length; i++) if (numOrNull(plan[i].size) !== null) wantSize = true;
        if (!wantSize) {
            applyRanges(layerId, plan, textLen);
            return { plan: plan, path: 'canonical' };
        }
        var modes = (_sizeMode >= 0) ? [_sizeMode] : [0, 1, 2, 3];
        var errs = [];
        for (i = 0; i < modes.length; i++) {
            try {
                _sizeModeTrying = modes[i];
                applyRanges(layerId, plan, textLen);
                var bad = verifySizes(layerId, plan, textLen);
                if (bad.length) {
                    errs.push(SIZE_MODES[modes[i]] + ':' + bad[0].want + ' != ' + bad[0].got);
                    continue;
                }
                _sizeModeTrying = -1;
                _sizeMode = modes[i];
                return { plan: plan, path: 'canonical' };
            } catch (eSize) {
                errs.push(SIZE_MODES[modes[i]] + ':' + errText(eSize));
            }
        }
        _sizeModeTrying = -1;
        _sizeMode = -1;
        var lean = stripSize(plan);
        applyRanges(layerId, lean, textLen);
        notes.push('\u5b57\u53f7\u672a\u80fd\u5199\u5165' + '\uff08' + errs.join(' ; ') + '\uff09' + '\uff0c\u5df2\u53ea\u5e94\u7528\u5b57\u4f53');
        return { plan: lean, path: 'canonical-nosize' };
    }

    function verifyPlan(layerId, plan, textLen) {
        var actual = readRanges(layerId, textLen);
        var problems = [], i, j, p, a, got;
        for (i = 0; i < plan.length; i++) {
            p = plan[i];
            if (!p.psName) continue;
            for (j = 0; j < actual.length; j++) {
                a = actual[j];
                if (a.from >= textLen) continue;
                if (a.to <= p.from || a.from >= p.to) continue;
                got = a.psName || '(none)';
                if (got !== p.psName) {
                    problems.push({ wanted: p.psName, got: got, range: a.from + '-' + a.to, plan: p.from + '-' + p.to });
                    break;
                }
            }
        }
        return problems;
    }

    // read the sizes back: a size write can be accepted and still do nothing.
    // With a layer transform the textKey stores base values; the character
    // panel shows base x K, so compare against want x K (the requested size).
    function verifySizes(layerId, plan, textLen) {
        var actual = readRanges(layerId, textLen);
        var K = (_layerScale > 0 ? _layerScale : 1);
        var bad = [], i, j, p, a, want;
        for (i = 0; i < plan.length; i++) {
            p = plan[i];
            want = numOrNull(p.size);
            if (want === null) continue;
            for (j = 0; j < actual.length; j++) {
                a = actual[j];
                if (a.from >= textLen) continue;
                if (a.to <= p.from || a.from >= p.to) continue;
                var shown = (a.size === null) ? null : a.size * K;   // panel-equivalent size
                if (shown === null || Math.abs(shown - want) > Math.max(0.5, want * 0.01)) {
                    bad.push({ want: want, got: (shown === null ? 'null' : Math.round(shown * 100) / 100), range: a.from + '-' + a.to });
                    break;
                }
            }
        }
        return bad;
    }

    /* ---------------- text: segmentation ---------------- */

    function segmentsOf(text) {
        var segs = [], start = 0, prev = false, i, cur;
        if (!text || !text.length) return segs;
        prev = isCJK(text.charAt(0));
        for (i = 1; i < text.length; i++) {
            cur = isCJK(text.charAt(i));
            if (cur !== prev) { segs.push([start, i, prev]); start = i; prev = cur; }
        }
        segs.push([start, text.length, prev]);
        return segs;
    }

    // per character override objects -> contiguous plan.
    // Shared objects are compared by identity, so identical roles merge.
    function planFromPerChar(perChar) {
        var plan = [], cur = null, i, o;
        for (i = 0; i < perChar.length; i++) {
            o = perChar[i] || null;
            if (cur && cur.o === o) { cur.to = i + 1; continue; }
            if (cur) plan.push(planItem(cur));
            cur = { from: i, to: i + 1, o: o };
        }
        if (cur) plan.push(planItem(cur));
        return plan;
    }
    function planItem(cur) {
        var o = cur.o;
        return {
            from: cur.from, to: cur.to,
            psName: o ? o.psName : null,
            size: o ? o.size : null,
            rgb: o ? o.rgb : null,
            trck: o ? o.trck : null,
            autoLeading: (o && o.autoLeading) ? true : null
        };
    }

    function fontPerChar(text, cnPS, enPS, cnSize, enSize, cnColor, enColor) {
        var cnO = { psName: cnPS, size: cnSize, rgb: cnColor, trck: null };
        var enO = { psName: enPS, size: enSize, rgb: enColor, trck: null };
        var segs = segmentsOf(text), perChar = [], i, j, o;
        for (i = 0; i < segs.length; i++) {
            o = segs[i][2] ? cnO : enO;
            for (j = segs[i][0]; j < segs[i][1]; j++) perChar[j] = o;
        }
        return planFromPerChar(perChar);
    }

    /* ---------------- leading = Auto ----------------
       Photoshop's "Leading: Auto" is TextItem.useAutoLeading ("uses the
       font's built-in leading information"). It is written through the DOM
       first and through the textKey descriptor (autoLeading in the range
       style) as a fallback, and always verified by reading it back. */

    function autoLeadingPlan(text) {
        var o = { psName: null, size: null, rgb: null, trck: null, autoLeading: true };
        var perChar = [], i;
        for (i = 0; i < text.length; i++) perChar[i] = o;
        return planFromPerChar(perChar);
    }

    function hasAutoLeading(layerId, textLen) {
        var rs = readRanges(layerId, textLen), i;
        for (i = 0; i < rs.length; i++) if (rs[i].autoLeading === true) return true;
        return false;
    }

    /* ---------------- DOM whole layer fallback ----------------
       layer.textItem.font is a DOM write and it works even when the
       descriptor path is rejected. It cannot split a layer, so it is
       only used when per range styling is impossible. */

    function domWholeLayer(layer, psName, sizePt, rgb) {
        var notes = [], ok = false;
        if (psName) {
            try { layer.textItem.font = psName; ok = true; notes.push('dom-font:ok'); }
            catch (eF) { notes.push('dom-font:' + errText(eF)); }
        }
        var sz = numOrNull(sizePt);
        if (sz !== null) {
            try { layer.textItem.size = UnitValue(sz, 'pt'); ok = true; notes.push('dom-size:ok'); }
            catch (eS) { notes.push('dom-size:' + errText(eS)); }
        }
        var c = rgbSafe(rgb);
        if (c) {
            try {
                var sc = new SolidColor();
                sc.rgb.red = Math.round(c.r * 255);
                sc.rgb.green = Math.round(c.g * 255);
                sc.rgb.blue = Math.round(c.b * 255);
                layer.textItem.color = sc;
                ok = true;
                notes.push('dom-color:ok');
            } catch (eC) { notes.push('dom-color:' + errText(eC)); }
        }
        if (!ok) return null;
        return 'font=' + (psName || '?') + ' [' + notes.join(' ') + ']';
    }

    // the first segment decides the whole layer font (CJK text -> CJK font)
    function wholeLayerFallback(layer, text, args, cnPS, enPS) {
        stage('layer-fallback');
        var segs = segmentsOf(text);
        var isCJK = (segs.length && text.length) ? segs[0][2] : true;
        _trace = 'dom fallback ps=' + ((isCJK ? cnPS : enPS) || 'none');
        // syncColor=false: colors are never touched, not even in the fallback
        return domWholeLayer(layer, isCJK ? cnPS : enPS, isCJK ? args.cnSize : args.enSize, args.syncColor === false ? null : (isCJK ? args.cnColor : args.enColor));
    }

    /* ---------------- font mixing ---------------- */

    function applyFontMix(args) {
        stage('collect');
        var out = { ok: 0, failed: [], missingFonts: [], notes: [], timedOut: false, total: 0, empty: true, source: '', layerFallback: [], substituted: [], path: '' };
        var src = activeLayerSource();
        var layers = [];
        walkLayers(src.refs, function (l) { if (isTextLayer(l)) layers.push(l); });
        out.source = src.from;
        out.total = layers.length;
        out.empty = layers.length === 0;
        if (!layers.length) {
            out.emptyReason = src.refs.length ? 'no-text-layer' : 'no-selection';
            out.emptyLayer = src.refs.length ? String(src.refs[0].name || '(unnamed)') : '';
            return jval(out);
        }

        stage('resolve-fonts');
        var cnPS = (args.cnFont && args.cnFont.family) ? psNameOf(args.cnFont.family, args.cnFont.style) : null;
        _lastPS = cnPS || '';
        var enPS = (args.enFont && args.enFont.family) ? psNameOf(args.enFont.family, args.enFont.style) : null;
        if (args.cnFont && args.cnFont.family && !cnPS) out.missingFonts.push(args.cnFont.family + ' ' + args.cnFont.style);
        if (args.enFont && args.enFont.family && !enPS) out.missingFonts.push(args.enFont.family + ' ' + args.enFont.style);
        if (out.missingFonts.length) return jval(out);
        if (!cnPS && !enPS) return jval(out);

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var text = '';
            try {
                _substituted = false;   // per layer: never leak the previous verdict
                stage('layer ' + (i + 1) + '/' + layers.length + ' read');
                _trace = '';
                text = textContentsOf(layer);
                if (!text.length) { out.ok++; continue; }
                var plan = fontPerChar(text, cnPS, enPS, args.cnSize, args.enSize, args.syncColor === false ? null : args.cnColor, args.syncColor === false ? null : args.enColor);
                _trace = 'ranges=' + plan.length + ' cn=' + (cnPS || 'none') + ' en=' + (enPS || 'none');
                var notes = [];
                stage('layer ' + (i + 1) + ' write ' + plan.length + ' ranges');
                var used = applyRangesSafe(layer.id, plan, text.length, notes);
                stage('layer ' + (i + 1) + ' verify');
                var probs = verifyPlan(layer.id, used.plan, text.length);
                // A verify mismatch means Photoshop substituted the font on some
                // ranges. The written result STAYS (it may be partially correct);
                // re-running the whole-layer DOM fallback would repaint the layer
                // with one font and destroy the ranges that did take. So we report
                // the substitution and move on.
                if (probs.length) {
                    _substituted = true;
                    out.ok++;
                    out.path = used.path;
                    out.substituted.push(String(layer.name) + ' -> ' +
                        '\u5b57\u4f53\u88ab Photoshop \u66ff\u6362\uff1a\u8bf7\u6c42 ' + probs[0].wanted + '\uff0c\u5b9e\u9645 ' + probs[0].got + '\uff08\u533a\u95f4 ' + probs[0].range + '\uff09' +
                        ' [' + notes.join(' ') + ']');
                    for (var s = 0; s < notes.length; s++) if (!inArray(out.notes, notes[s])) out.notes.push(notes[s]);
                    continue;
                }
                _substituted = false;
                out.ok++;
                out.path = used.path;
                for (var n = 0; n < notes.length; n++) if (!inArray(out.notes, notes[n])) out.notes.push(notes[n]);
            } catch (e) {
                // real write errors (descriptor rejected, etc.) may still use the
                // DOM whole-layer fallback; substitution does NOT reach here.
                var fbv = wholeLayerFallback(layer, text, args, cnPS, enPS);
                if (fbv) {
                    out.ok++;
                    out.path = 'dom-fallback';
                    if (_substituted) out.substituted.push(String(layer.name) + ' -> ' + fbv + ' [' + errText(e) + ']');
                    else out.layerFallback.push(String(layer.name) + ' -> ' + fbv + ' [' + errText(e) + ']');
                } else {
                    out.failed.push({ name: String(layer.name), reason: errText(e), stage: _stage, line: e.line, trace: _trace });
                }
            }
        }
        return jval(out);
    }

    /* ---------------- style detect (fill the form) ---------------- */

    function detectFontMix() {
        stage('collect');
        var out = { empty: true };
        var src = activeLayerSource();
        var layers = [];
        walkLayers(src.refs, function (l) { if (isTextLayer(l)) layers.push(l); });
        out.source = src.from;
        out.layerCount = src.refs.length;
        if (!layers.length) {
            // Distinguish "nothing selected" from "selection has no text layers"
            // so the panel can show WHY detection came back empty.
            out.emptyReason = src.refs.length ? 'no-text-layer' : 'no-selection';
            out.emptyLayer = src.refs.length ? String(src.refs[0].name || '(unnamed)') : '';
            return jval(out);
        }

        var layer = layers[0];
        stage('read-contents');
        var text = textContentsOf(layer);
        if (!text.length) {
            out.emptyReason = 'empty-text';
            out.emptyLayer = String(layer.name || '(unnamed)');
            return jval(out);
        }

        stage('read-ranges');
        var ranges = readRanges(layer.id, text.length);
        var K = layerScaleOf(layer.id);   // report panel-equivalent sizes
        if (K !== 1) {
            for (var z = 0; z < ranges.length; z++) {
                if (ranges[z].size != null) ranges[z].size = Math.round(ranges[z].size * K * 100) / 100;
            }
        }

        var cnFont = null, enFont = null, cnColor = null, enColor = null;
        var cnSizes = {}, enSizes = {}, unknown = { cn: false, en: false };
        var seen = { cn: false, en: false };

        stage('scan-ranges');
        for (var k = 0; k < ranges.length; k++) {
            var rr = ranges[k];
            if (rr.to <= rr.from) continue;
            if (rr.size == null) { unknown.cn = true; unknown.en = true; }
            var segs = segmentsOf(text.substring(rr.from, Math.min(rr.to, text.length)));
            for (var s = 0; s < segs.length; s++) {
                var side = segs[s][2] ? 'cn' : 'en';
                seen[side] = true;
                if (side === 'cn') {
                    if (!cnFont && rr.psName) { var mf = metaOfPSName(rr.psName); if (mf) cnFont = { family: mf.family, style: mf.style }; }
                    if (!cnColor && rr.rgb) cnColor = rr.rgb;
                    if (rr.size != null) cnSizes[rr.size] = true;
                } else {
                    if (!enFont && rr.psName) { var ef = metaOfPSName(rr.psName); if (ef) enFont = { family: ef.family, style: ef.style }; }
                    if (!enColor && rr.rgb) enColor = rr.rgb;
                    if (rr.size != null) enSizes[rr.size] = true;
                }
            }
        }

        stage('summarize');
        var cnSum = summarizeSizes(cnSizes, unknown.cn), enSum = summarizeSizes(enSizes, unknown.en);

        return jval({
            empty: false,
            source: src.from,
            cnFont: seen.cn ? cnFont : enFont,
            enFont: seen.en ? enFont : cnFont,
            cnColor: seen.cn ? cnColor : enColor,
            enColor: seen.en ? enColor : cnColor,
            cnSize: seen.cn ? cnSum.size : enSum.size,
            enSize: seen.en ? enSum.size : cnSum.size,
            cnSizeMixed: seen.cn ? cnSum.mixed : enSum.mixed,
            enSizeMixed: seen.en ? enSum.mixed : cnSum.mixed
        });
    }
    function summarizeSizes(sizes, unk) {
        var keys = [], kk;
        for (kk in sizes) if (sizes.hasOwnProperty(kk)) keys.push(Number(kk));
        if (keys.length === 1) return { size: keys[0], mixed: false };
        if (keys.length > 1) return { size: null, mixed: true };
        return { size: null, mixed: !!unk };
    }

    /* ---------------- optical kerning (Photoshop "Optical") ----------------
       Photoshop exposes this as TextItem.autoKerning = AutoKernType.OPTICAL
       ("Adjusts the spacing between adjacent characters based on their
       shapes"), which is the Character panel option the user asked for.
       It is layer scoped. Every write is verified by reading it back; if
       the layer refuses it, symbol tracking is used instead. */

    function opticalSupported() {
        try { return (typeof AutoKernType !== 'undefined' && AutoKernType && AutoKernType.OPTICAL !== undefined); } catch (e) { return false; }
    }

    function applyAutoKerning(args) {
        stage('collect');
        var out = { nodes: 0, applied: 0, failed: 0, nothing: 0, empty: true, mode: 'optical', optical: 0, tracking: 0, leading: 0, leadingFailed: 0, leadingMode: '', leadingRequested: false, skipped: [], source: '' };
        var src = activeLayerSource();
        var layers = [];
        walkLayers(src.refs, function (l) { if (isTextLayer(l)) layers.push(l); });
        out.source = src.from;
        out.nodes = layers.length;
        if (!layers.length) return jval(out);
        out.empty = false;

        if (!opticalSupported()) {
            out.mode = 'tracking';
            out.skipped.push('AutoKernType.OPTICAL unavailable');
        }

        var outer = numOrNull(args && args.pairedOuterValue);
        outer = (outer === null) ? -450 : Math.round(outer * 10);

        // leading is opt-in: only touched when the panel asks for it
        var doLeading = !(args && args.setLeading === false);
        out.leadingRequested = doLeading;
        if (!doLeading) out.leadingMode = 'off';

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            var opticalDone = false;
            if (out.mode === 'optical') {
                try {
                    stage('optical layer ' + (i + 1) + ' write');
                    layer.textItem.autoKerning = AutoKernType.OPTICAL;
                    stage('optical layer ' + (i + 1) + ' verify');
                    var back = layer.textItem.autoKerning;
                    if (back === AutoKernType.OPTICAL || String(back) === String(AutoKernType.OPTICAL)) {
                        opticalDone = true;
                        out.optical++;
                        out.applied++;
                    } else {
                        if (!inArray(out.skipped, 'verify readback=' + String(back))) out.skipped.push('verify readback=' + String(back));
                    }
                } catch (eO) {
                    if (!inArray(out.skipped, errText(eO))) out.skipped.push(errText(eO));
                }
            }
            if (!opticalDone) {
                try {
                    stage('tracking layer ' + (i + 1));
                    var n = trackingPass(layer, outer);
                    if (n > 0) { out.tracking++; out.applied++; }
                    else out.nothing++;
                } catch (eT) {
                    out.failed++;
                    if (!inArray(out.skipped, errText(eT))) out.skipped.push(errText(eT));
                }
            }

            // Leading = Auto, only when requested: DOM first, then the
            // textKey descriptor, both verified by reading the value back
            var leadText = doLeading ? textContentsOf(layer) : '';
            if (leadText.length) {
                var leadOk = false;
                try {
                    stage('leading layer ' + (i + 1) + ' dom');
                    layer.textItem.useAutoLeading = true;
                    if (layer.textItem.useAutoLeading === true) {
                        leadOk = true;
                        out.leading++;
                        if (!out.leadingMode) out.leadingMode = 'dom';
                    }
                } catch (eL) {
                    if (!inArray(out.skipped, errText(eL))) out.skipped.push(errText(eL));
                }
                if (!leadOk) {
                    try {
                        stage('leading layer ' + (i + 1) + ' descriptor');
                        applyRanges(layer.id, autoLeadingPlan(leadText), leadText.length);
                        if (hasAutoLeading(layer.id, leadText.length)) {
                            leadOk = true;
                            out.leading++;
                            if (!out.leadingMode) out.leadingMode = 'descriptor';
                        } else if (!inArray(out.skipped, 'autoLeading: write had no effect')) {
                            out.skipped.push('autoLeading: write had no effect');
                        }
                    } catch (eLA) {
                        if (!inArray(out.skipped, errText(eLA))) out.skipped.push(errText(eLA));
                    }
                }
                if (!leadOk) out.leadingFailed++;
            }
        }
        if (out.optical && !out.tracking) out.mode = 'optical';
        else if (out.optical && out.tracking) out.mode = 'optical+tracking';
        else if (out.tracking) out.mode = 'tracking';
        else out.mode = 'none';
        return jval(out);
    }

    // fallback: nudge the tracking of symbols and paired brackets.
    // Only tracking is overridden; every other style attribute is
    // inherited from the range that already covers the character.
    function trackingPass(layer, outer) {
        var text = textContentsOf(layer);
        if (text.length < 2) return 0;

        // symbol test: Unicode symbol blocks + ASCII punctuation.
        // The backtick is written as \u0060 so the source stays ASCII.
        var symRe = /[\u2000-\u206F\u2E00-\u2E7F\u3000-\u303F\uFF01-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65!-\/:-@\[-\u0060{-~]/;
        var excl = { '#': 1, '*': 1, '\u00A5': 1, '\u00B7': 1, '~': 1, '%': 1, '&': 1, '.': 1, '/': 1, '\\': 1, '-': 1, '+': 1 };
        var openPairs = {
            '(': ')', '[': ']', '{': '}',
            '\uFF08': '\uFF09', '\uFF3B': '\uFF3D', '\u3010': '\u3011', '\u300A': '\u300B',
            '\u3008': '\u3009', '\u201C': '\u201D', '\u2018': '\u2019',
            '\u300C': '\u300D', '\u300E': '\u300F', '\uFF5B': '\uFF5D'
        };
        var closeMap = {};
        for (var pk in openPairs) if (openPairs.hasOwnProperty(pk)) closeMap[openPairs[pk]] = pk;

        var stack = [], matched = [], idx, ch;
        for (idx = 0; idx < text.length; idx++) {
            ch = text.charAt(idx);
            if (openPairs[ch]) stack.push(idx);
            else if (closeMap[ch] && stack.length && openPairs[text.charAt(stack[stack.length - 1])] === ch) {
                matched.push([stack.pop(), idx]);
            }
        }
        var pairedIdx = {};
        for (var m = 0; m < matched.length; m++) { pairedIdx[matched[m][0]] = 1; pairedIdx[matched[m][1]] = 1; }

        var perChar = [], done = 0;
        var symO = { psName: null, size: null, rgb: null, trck: -300 };
        var pairO = { psName: null, size: null, rgb: null, trck: outer };
        for (idx = 0; idx < text.length; idx++) {
            ch = text.charAt(idx);
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;
            if (excl[ch] || pairedIdx[idx]) continue;
            if (!symRe.test(ch)) continue;
            perChar[idx] = symO;
            done++;
        }
        for (m = 0; m < matched.length; m++) {
            var o = matched[m][0], c = matched[m][1];
            if (o > 0) { perChar[o - 1] = pairO; done++; }
            if (c < text.length - 1) { perChar[c] = pairO; done++; }
        }
        if (!done) return 0;
        var plan = planFromPerChar(perChar);
        applyRanges(layer.id, plan, text.length);
        return done;
    }

    /* ---------------- self test (temp document) ----------------
       Ground truth on the running machine: create a throw away
       document, write two different fonts into two ranges through
       exactly the production path, read them back, then close the
       document without saving. The user's artwork is never used. */

    function selfTest(args) {
        var out = { steps: [], read: '', write: '', cnFont: '', enFont: '', sample: 'AB', closed: false };
        var original = null;
        try { if (app.documents.length) original = app.activeDocument; } catch (e0) { }
        var tmp = null;
        try {
            tmp = app.documents.add(UnitValue(240, 'px'), UnitValue(120, 'px'), 72, 'PSToolbox selftest', NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        } catch (eA) {
            out.error = 'create-doc: ' + errText(eA);
            return jval(out);
        }
        try {
            var cnPS = (args && args.cn) ? String(args.cn) : '';
            var enPS = (args && args.en) ? String(args.en) : '';
            // the panel sends family/style, the probe accepts a raw PS name
            if (!cnPS && args && args.cnFont && args.cnFont.family) cnPS = psNameOf(args.cnFont.family, args.cnFont.style) || '';
            if (!enPS && args && args.enFont && args.enFont.family) enPS = psNameOf(args.enFont.family, args.enFont.style) || '';
            if (!cnPS) cnPS = pickFontFor('cn', '');
            if (!enPS || enPS === cnPS) enPS = pickFontFor('en', cnPS, familyOfPSName(cnPS));
            out.cnFont = cnPS;
            out.enFont = enPS;

            var sample = out.sample;
            var l = tmp.artLayers.add();
            l.kind = LayerKind.TEXT;
            l.textItem.contents = sample;
            if (cnPS) {
                try { l.textItem.font = cnPS; out.steps.push('dom-font=ok'); }
                catch (eF) { out.steps.push('dom-font=FAIL[' + errText(eF) + ']'); }
            }
            out.layerId = l.id;

            try {
                var rr0 = readRanges(l.id, sample.length);
                out.read = 'ok count=' + rr0.length + ' first=' + (rr0.length ? (rr0[0].psName || 'none') : '-');
                out.steps.push('read=ok');
            } catch (eR) {
                out.read = 'FAIL[' + errText(eR) + ']';
                out.steps.push('read=FAIL @' + eR.line);
            }

            var robCn = pickFontFor('cn', '');
            var robEn = pickFontFor('en', robCn, familyOfPSName(robCn));
            if (!robEn) robEn = robCn;
            out.robust = robCn + '/' + robEn;

            var plan = [
                { from: 0, to: 1, psName: cnPS, size: null, rgb: null, trck: null },
                { from: 1, to: 2, psName: enPS, size: null, rgb: null, trck: null }
            ];
            var primaryOk = false;
            try {
                applyRanges(l.id, plan, sample.length);
                out.steps.push('write=ok');
                var probs = verifyPlan(l.id, plan, sample.length);
                if (!probs.length) {
                    out.write = 'ok';
                    out.steps.push('verify=ok');
                    primaryOk = true;
                } else {
                    // A face without a glyph for the sample is substituted and
                    // the ranges merge: a coverage fact, not a broken pipeline.
                    out.write = 'substituted range=' + probs[0].range + ' wanted=' + probs[0].wanted + ' got=' + probs[0].got;
                    out.steps.push('verify=substituted');
                }
            } catch (eW) {
                out.write = 'FAIL[' + errText(eW) + ']';
                out.steps.push('write=FAIL @' + eW.line);
            }
            if (!primaryOk) {
                if (robCn && robEn && robCn !== robEn) {
                    var plan2 = [
                        { from: 0, to: 1, psName: robCn, size: null, rgb: null, trck: null },
                        { from: 1, to: 2, psName: robEn, size: null, rgb: null, trck: null }
                    ];
                    try {
                        applyRanges(l.id, plan2, sample.length);
                        if (!verifyPlan(l.id, plan2, sample.length).length) {
                            out.steps.push('verify=ok-secondary');
                            out.write = 'requested pair substituted; verified with ' + out.robust;
                        } else {
                            out.steps.push('verify=mismatch');
                        }
                    } catch (e2) {
                        out.steps.push('verify=mismatch');
                        out.write = 'FAIL[' + errText(e2) + ']';
                    }
                } else {
                    out.steps.push('verify=mismatch');
                }
            }

            // size probe: which key/unit pair really changes the size here
            var sizeTried = [], m, szPlan, rr1, gotSizes, q;
            var szOk = false;
            var szCn = robCn || cnPS, szEn = (robEn && robEn !== szCn) ? robEn : (enPS || cnPS);
            for (m = 0; m < SIZE_MODES.length; m++) {
                szPlan = [
                    { from: 0, to: 1, psName: szCn, size: 12, rgb: null, trck: null },
                    { from: 1, to: 2, psName: szEn, size: 30, rgb: null, trck: null }
                ];
                try {
                    _sizeModeTrying = m;
                    applyRanges(l.id, szPlan, sample.length);
                    rr1 = readRanges(l.id, sample.length);
                    gotSizes = [];
                    for (q = 0; q < rr1.length; q++) {
                        gotSizes.push(rr1[q].from + '-' + rr1[q].to + ':' + (rr1[q].size === null ? 'null' : rr1[q].size));
                    }
                    sizeTried.push(SIZE_MODES[m] + '=' + gotSizes.join(','));
                    if (!verifySizes(l.id, szPlan, sample.length).length) {
                        szOk = true;
                        _sizeMode = m;
                        out.sizeMode = SIZE_MODES[m];
                        break;
                    }
                } catch (eS) {
                    sizeTried.push(SIZE_MODES[m] + '=FAIL[' + errText(eS) + ']');
                }
            }
            _sizeModeTrying = -1;
            out.sizeSteps = sizeTried.join(' | ');
            if (szOk) out.steps.push('size=ok');
            else { out.sizeMode = 'none'; _sizeMode = -1; out.steps.push('size=FAIL'); }

            try {
                var rr2 = readRanges(l.id, sample.length);
                var names = [];
                for (var w = 0; w < rr2.length; w++) names.push(rr2[w].from + '-' + rr2[w].to + ':' + (rr2[w].psName || 'none'));
                out.after = names.join(' ');
            } catch (e3) { out.after = 'read-back failed: ' + errText(e3); }
        } finally {
            try { tmp.close(SaveOptions.DONOTSAVECHANGES); out.closed = true; } catch (eC) { out.closeError = errText(eC); }
            if (original) { try { app.activeDocument = original; } catch (eS) { } }
        }
        return jval(out);
    }

    /* ---------------- font list (families merged) ---------------- */

    function listFonts() {
        stage('font-index');
        var map = {}, order = [], i, f;
        var list = fontIndex();
        for (i = 0; i < list.length; i++) {
            f = list[i];
            if (!map[f.family]) { map[f.family] = []; order.push(f.family); }
            if (!inArray(map[f.family], f.style)) map[f.family].push(f.style);
        }
        order.sort();
        var out = [];
        for (i = 0; i < order.length; i++) out.push({ family: order[i], styles: map[order[i]] });
        return jval({ families: out });
    }

    /* ---------------- selection signature (CEP has no push) ---------------- */

    function selSig() {
        stage('active-layers');
        var src = activeLayerSource();
        var ids = [];
        if (src.refs && typeof src.refs.length === 'number') {
            for (var i = 0; i < src.refs.length && i < 32; i++) {
                try { ids.push(src.refs[i].id); } catch (e) { }
            }
        }
        stage('serialize');
        return jval({ sig: ids.join(','), from: src.from });
    }

    /* ---------------- Photoshop native color picker ----------------
       Documented signature: bool showColorPicker(bool pickForeground)
       - true -> the FOREGROUND color is edited, false when cancelled.
       So: seed app.foregroundColor, call with true, read it back.
       Newer builds may accept a SolidColor instead, tried second. */

    function pickColor(args) {
        var notes = [];
        var rgb = (args && typeof args.r === 'number') ? args : { r: 0, g: 0, b: 0 };
        var original = null;
        try { original = app.foregroundColor; } catch (eOrig) { }
        var seed = new SolidColor();
        seed.rgb.red = Math.round(clamp(rgb.r, 0, 1) * 255);
        seed.rgb.green = Math.round(clamp(rgb.g, 0, 1) * 255);
        seed.rgb.blue = Math.round(clamp(rgb.b, 0, 1) * 255);
        try { app.foregroundColor = seed; } catch (eSeed) { notes.push('seed:' + errText(eSeed)); }

        var ok = null, mode = '';
        try { ok = app.showColorPicker(true); mode = 'bool'; }
        catch (e1) {
            notes.push('bool:' + errText(e1));
            try { ok = app.showColorPicker(seed); mode = 'solid'; }
            catch (e2) {
                notes.push('solid:' + errText(e2));
                try { ok = app.showColorPicker(); mode = 'noarg'; }
                catch (e3) {
                    notes.push('noarg:' + errText(e3));
                    if (original) { try { app.foregroundColor = original; } catch (eR0) { } }
                    return jval({ error: notes.join(' ; '), api: 'pick-color', stage: 'showColorPicker' });
                }
            }
        }
        var picked = seed;
        try { if (app.foregroundColor && app.foregroundColor.rgb) picked = app.foregroundColor; } catch (e4) { }
        var res = {
            ok: true, mode: mode,
            r: picked.rgb.red / 255, g: picked.rgb.green / 255, b: picked.rgb.blue / 255,
            notes: notes.join(' ; ')
        };
        if (ok === false) res.ok = false;
        // picking a plugin colour must not leave the foreground changed
        if (original) { try { app.foregroundColor = original; } catch (eR1) { } }
        return jval(res);
    }

    /* ---------------- environment probe (self observation) ---------------- */

    function envProbe() {
        var o = {};
        o.host = HOST_VERSION;
        try { o.hostFile = String($.fileName || ''); } catch (e0) { o.hostFile = 'err'; }
        try { o.ps = String(app.name) + ' ' + String(app.version); } catch (e1) { o.ps = 'err:' + errText(e1); }
        var d = docSafe();
        o.doc = d ? 'yes' : 'none';
        if (d) { try { o.docName = String(d.name || '(unnamed)'); } catch (e2) { o.docName = 'err'; } }
        try { o.docCount = app.documents.length; } catch (e3) { o.docCount = 'err:' + errText(e3); }
        var src = activeLayerSource();
        o.layerSource = src.from;
        o.layerCount = src.refs.length;
        if (d) {
            try { o.activeLayersType = (d.activeLayers === undefined) ? 'undefined' : typeof d.activeLayers; } catch (e4) { o.activeLayersType = 'throw:' + errText(e4); }
            try { o.selectedLayersType = (d.selectedLayers === undefined) ? 'undefined' : typeof d.selectedLayers; } catch (e5) { o.selectedLayersType = 'throw:' + errText(e5); }
        }
        o.layerKind = (typeof LayerKind !== 'undefined' && LayerKind) ? ('ok:TEXT=' + String(LayerKind.TEXT)) : 'missing';
        o.autoKernType = (typeof AutoKernType !== 'undefined' && AutoKernType) ? ('ok:OPTICAL=' + String(AutoKernType.OPTICAL)) : 'missing';
        try { o.showColorPicker = typeof app.showColorPicker; } catch (e6) { o.showColorPicker = 'err:' + errText(e6); }
        try { o.stringIDToTypeID = typeof stringIDToTypeID; } catch (e7) { o.stringIDToTypeID = 'err:' + errText(e7); }
        try { o.fonts = fontIndex().length; } catch (e8) { o.fonts = 'err:' + errText(e8); }
        try {
            var tl = 0;
            walkLayers(src.refs, function (l) { if (isTextLayer(l)) tl++; });
            o.textLayers = tl;
        } catch (e9) { o.textLayers = 'err:' + errText(e9); }
        return jval(o);
    }

    /* ---------------- API ---------------- */

    var API = {
        'font-mixer': applyFontMix,
        'detect-font': function () { return detectFontMix(); },
        'auto-kerning': applyAutoKerning,
        'list-fonts': function () { return listFonts(); },
        'sel-sig': function () { return selSig(); },
        'pick-color': function (a) { return pickColor(a); },
        'diag': function () { return envProbe(); },
        'selftest': function (a) { return selfTest(a); },
        // kept so older panels keep working: the probe is now a safe
        // temp document test instead of a temp layer test
        'probe-write': function (a) { return selfTest(a); },
        'ping': function () { return jval({ pong: true, version: HOST_VERSION, syncColor: true }); }
    };

    // Entry point, called from the panel through CSInterface.evalScript.
    // A thrown error always carries the failing stage and the source line.
    return function (type, encodedArgs) {
        var fn = null;
        try {
            fn = API[type];
            if (!fn) return jval({ error: 'unknown type: ' + type });
            var args = {};
            if (encodedArgs) {
                try { args = eval('(' + decodeURIComponent(encodedArgs) + ')'); }
                catch (eP) { args = {}; }
            }
            stage('call ' + type);
            var res = fn(args);
            return (res === undefined || res === null) ? jval({ error: 'api returned nothing', api: type }) : res;
        } catch (e) {
            return jval({ error: errText(e), api: type, stage: _stage, line: e.line, name: e.name });
        }
    };
})();

/* Publish on the ExtendScript global object so the panel can always reach
   the entry point, regardless of how CEP evaluated this ScriptPath file. */
try { $.global.cephostDispatch = cephostDispatch; } catch (ePub) { }
