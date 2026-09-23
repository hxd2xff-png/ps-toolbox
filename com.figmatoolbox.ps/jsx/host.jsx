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

    var HOST_VERSION = '4.7.0';
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

    /* ---------------- roman numerals (per spec MD \u00a74/\u00a75) ----------------
       Unicode roman numerals: ONLY the common I..XII forms ride with the
       Chinese font (Chinese faces carry these glyphs; pure Latin display
       fonts do not). Larger numerals (L C D M, \u2180+) and exotic forms are
       English-side: they cannot be reliably told from letters. */
    function isUniRomanCN(ch) {
        var c = ch.charCodeAt(0);
        return (c >= 0x2160 && c <= 0x216B) || (c >= 0x2170 && c <= 0x217B);
    }
    // ASCII roman numerals are plain letters, so a lone char class test would
    // swallow MIX/SKU-IV-A/10MLX2. A token only counts when ALL of these hold:
    // valid numeral shape, contains I/V/X, value <= 25, and it is NOT embedded
    // in an alphanumeric/hyphen/underscore code. A single letter must sit next
    // to CJK text to count (spec \u00a75: conservative strategy).
    function romanValue(tok) {
        var V = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
        var t = 0, i, v, nx;
        for (i = 0; i < tok.length; i++) {
            v = V[tok.charAt(i)] || 0;
            nx = (i + 1 < tok.length) ? (V[tok.charAt(i + 1)] || 0) : 0;
            t += (v < nx) ? -v : v;
        }
        return t;
    }
    function asciiRomanShape(tok) {
        return /^(?:M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))$/.test(tok) && /[IVX]/.test(tok);
    }
    function isRomanLetter(ch) {
        var c = ch.charCodeAt(0);
        return c === 73 || c === 86 || c === 88 || c === 76 || c === 67 || c === 68 || c === 77; // I V X L C D M
    }
    // true when the token covering charAt(index) qualifies as an ASCII roman numeral
    function isAsciiRomanAt(text, index) {
        if (!isRomanLetter(text.charAt(index))) return false;
        var start = index;
        while (start > 0 && isRomanLetter(text.charAt(start - 1))) start--;
        var end = index + 1;
        while (end < text.length && isRomanLetter(text.charAt(end))) end++;
        var tok = text.substring(start, end);
        if (!asciiRomanShape(tok)) return false;
        if (romanValue(tok) > 25) return false;   // XXVI+, MIX etc stay English
        var prev = start > 0 ? text.charAt(start - 1) : '';
        var next = end < text.length ? text.charAt(end) : '';
        var reCode = /[A-Za-z0-9_\-]/;
        if (reCode.test(prev) || reCode.test(next)) return false;  // SKU-IV-A, MIX123, IV_CODE
        if (tok.length === 1 && !isCJK(prev) && !isCJK(next)) return false;  // lone "I" in English copy
        return true;
    }

    /* Symbols are characters that could live on either side: punctuation,
       brackets, quotes, dashes (both halfwidth and CJK/fullwidth). Letters and
       digits are never symbols: ideographs/kana/hangul and fullwidth alphanums
       are always Chinese-side, Latin letters/digits are always English-side.
       The symSide option (v4.4.0) only moves these characters. */
    function isSymbolChar(ch) {
        var c = ch.charCodeAt(0);
        if (c >= 0x20 && c <= 0x2F) return true;      // space .. slash
        if (c >= 0x3A && c <= 0x40) return true;      // colon .. @
        if (c >= 0x5B && c <= 0x60) return true;      // [ .. backtick
        if (c >= 0x7B && c <= 0x7F) return true;      // { .. DEL zone
        if (c >= 0x2000 && c <= 0x206F) return true;  // general punct: dashes, quotes
        if (c >= 0x3000 && c <= 0x303F) return true;  // CJK symbols: corner brackets
        if (c >= 0xFF01 && c <= 0xFF0F) return true;  // fullwidth ! .. /
        if (c >= 0xFF1A && c <= 0xFF20) return true;  // fullwidth : .. @
        if (c >= 0xFF3B && c <= 0xFF40) return true;  // fullwidth [ .. backtick
        if (c >= 0xFF5B && c <= 0xFF64) return true;  // fullwidth { .. marks
        return false;
    }

    /* Side of one character under a symSide mode (MD \u00a71 priority order):
       1. Unicode roman I..XII            -> Chinese (regardless of the switch)
       2. ASCII roman I..XXV (in context) -> Chinese
       3. explicit symbol switch          -> cn/en for symbol-class chars
       4. CJK ideographs/kana/fullwidth   -> Chinese
       5. everything else                 -> English.
       Returns true for Chinese side, false for English side. */
    function sideOfCharCtx(ch, symSide, text, index) {
        if (isUniRomanCN(ch)) return true;
        if (text && text.length && isAsciiRomanAt(text, index)) return true;
        if (symSide === 'cn' && isSymbolChar(ch)) return true;
        if (symSide === 'en' && isSymbolChar(ch)) return false;
        // AUTO default (v4.6.0): every symbol rides with the Chinese font.
        // CJK fonts carry both fullwidth AND halfwidth punctuation glyphs;
        // pure Latin display fonts often miss fullwidth forms, which is what
        // made Photoshop silently substitute whole ranges (reported on real
        // machines). Halfwidth ASCII letters/digits stay English-side.
        if (isSymbolChar(ch)) return true;
        return isCJK(ch);
    }
    // char-only entry point used where there is no surrounding text context
    function sideOfChar(ch, symSide) {
        return sideOfCharCtx(ch, symSide, null, -1);
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
    /* ---------------- selected layers: descriptor first, DOM fallback ----------------
       DOM activeLayers is unreliable with multi-selection in some Photoshop
       versions (returns only one layer or the group). The Action Manager
       property 'targetLayers' on the document descriptor is the authoritative
       list; its references are INDEX-based on PS 20/21 (getIdentifier()
       throws), so each index is resolved to a real layer id through a DOM
       stack walk of the document tree (bottom layer = DOM index 0, so AM
       index n maps to DOM index n - 1). AM index references must NEVER be
       built here (putIndex shapes fail writes on PS 21 - see header note). */
    function docLayerStackIds() {
        var d = docSafe();
        if (!d) return null;
        var ids = [];
        try {
            (function walk(container) {
                var kids = null;
                try { kids = asArray(container.layers); } catch (e) { kids = null; }
                if (!kids) return;
                for (var i = 0; i < kids.length; i++) {
                    var l = kids[i];
                    if (l && l.typename === 'LayerSet') { walk(l); continue; }
                    try { ids.push(l.id); } catch (e2) { }
                }
            })(d);
        } catch (eW) { return null; }
        return ids.length ? ids : null;
    }
    function targetLayerIds() {
        var ref = new ActionReference();
        ref.putProperty(S('property'), S('targetLayers'));
        ref.putEnumerated(S('document'), S('ordinal'), S('targetEnum'));
        var d;
        try { d = executeActionGet(ref); } catch (e) { return null; }
        if (!d || !d.hasKey(S('targetLayers'))) return null;
        var list = d.getList(S('targetLayers'));
        var ids = [], i, needIndex = false;
        for (i = 0; i < list.count; i++) {
            try {
                var got = list.getReference(i).getIdentifier();
                if (got !== null && got !== undefined) ids.push(got);
                else needIndex = true;
            } catch (e2) { needIndex = true; }
        }
        // PS 20/21: references are index-form (1-based, bottom = 1); resolve
        // them against the DOM stack so multi-selection really applies to all
        // selected layers instead of silently falling back to the active one.
        if (needIndex && !ids.length && list.count) {
            var stack = docLayerStackIds();
            for (i = 0; i < list.count && stack; i++) {
                try {
                    var idx = -1;
                    try { idx = list.getReference(i).getIndex(); } catch (eNoIdx) { idx = -1; }
                    if (idx > 0 && idx <= stack.length) ids.push(stack[idx - 1]);
                } catch (e3) { }
            }
        }
        return ids.length ? ids : null;
    }

    function layerById(idNum) {
        var ref = new ActionReference();
        ref.putIdentifier(S('layer'), idNum);
        var d;
        try { d = executeActionGet(ref); } catch (e) { return null; }
        if (!d) return null;
        var name = '';
        try { name = d.getString(S('name')); } catch (e2) { }
        return { id: idNum, name: name, typename: 'ArtLayer', _amOnly: true };
    }

    function activeLayerSource() {
        var d = docSafe();
        if (!d) return { refs: [], from: 'no-document' };
        // 1. authoritative: AM targetLayers (true multi-selection)
        var ids = targetLayerIds();
        if (ids && ids.length) {
            var refs = [], i, dom = null;
            for (i = 0; i < ids.length; i++) {
                dom = layerDomById(d, ids[i]);
                if (dom) refs.push(dom);
                else {
                    var am = layerById(ids[i]);
                    if (am) refs.push(am);
                }
            }
            if (refs.length) return { refs: refs, from: 'targetLayers' };
        }
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

    /* DOM lookup by layer id: walk the whole layer tree once and match ids.
       Cached per document instance signature to keep selection polling cheap. */
    var _domWalkSig = '', _domWalkMap = null;
    function layerDomById(doc, idNum) {
        var sig = '';
        try { sig = String(doc.name) + ':' + doc.layers.length; } catch (eS) { return null; }
        if (_domWalkSig !== sig || !_domWalkMap) {
            _domWalkSig = sig;
            _domWalkMap = {};
            walkLayers(asArray(doc.layers), function (l) { try { _domWalkMap[l.id] = l; } catch (eI) { } });
        }
        return _domWalkMap[idNum] || null;
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
        if (l && l._amOnly) return true;   // AM targetLayers ref: textKey read will decide
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
        if (style) {
            for (i = 0; i < list.length; i++) {
                f = list[i];
                if (f.family === family && f.style === style) return f.name;
            }
        }
        // requested style missing -> nearest weight of the SAME family, never a
        // random other family. Weight order so "Light requested, only Medium
        // installed" stays in-family instead of jumping to a random face.
        var WR = [/thin/i, /extralight/i, /light/i, /regular|book|roman/i, /medium/i, /semibold|demibold/i, /bold/i, /extrabold|black|heavy|ultra/i];
        var wOf = function (st) {
            var s = String(st || ''), j;
            for (j = 0; j < WR.length; j++) if (WR[j].test(s)) return j;
            return WR.length;
        };
        var best = null, bestW = -1;
        for (i = 0; i < list.length; i++) {
            f = list[i];
            if (f.family !== family) continue;
            var w = wOf(f.style);
            if (best === null || Math.abs(w - wOf(style)) < Math.abs(bestW - wOf(style))) { best = f; bestW = w; }
        }
        return best ? best.name : null;
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

    /* Split one plan segment at the boundaries of the old style ranges so
       every piece inherits its OWN base style. Returns [{from,to,base,....}]. */
    function splitAtBaseBounds(seg, oldList) {
        var out = [], from = seg.from, to = seg.to, idx = from;
        while (idx < to) {
            var b = pickBaseRange(oldList, idx);
            var bTo = to;
            if (b) {
                var bEnd = b.getInteger(S('to'));
                if (bEnd > idx && bEnd < to) bTo = bEnd;
            }
            var piece = { from: idx, to: bTo, psName: seg.psName, size: seg.size, rgb: seg.rgb, trck: seg.trck, autoLeading: seg.autoLeading, base: b };
            out.push(piece);
            idx = bTo;
        }
        return out;
    }

    // plan: contiguous {from,to,psName,size,rgb,trck} covering [0,textLen)
    // Baseline properties (super/subscript, underline, strikethrough etc.)
    // live per style range. A plan segment may span several old ranges, so we
    // split each segment at old-range boundaries and clone the base style of
    // EACH piece -- cloning only the start would stamp e.g. superscript onto
    // following normal text.
    function applyRanges(layerId, plan, textLen) {
        _layerScale = layerScaleOf(layerId);   // compensate layer transforms
        var tk = textKeyOf(layerId);
        var old = tk.getList(S('textStyleRange'));
        var list = new ActionList();
        var i, seg, base, item, style;
        for (i = 0; i < plan.length; i++) {
            seg = plan[i];
            var cuts = splitAtBaseBounds(seg, old), c;
            for (c = 0; c < cuts.length; c++) {
                var piece = cuts[c];
                base = piece.base;
                item = base ? copyDesc(base) : new ActionDescriptor();
                style = hasKey(item, 'textStyle') ? copyDesc(item.getObjectValue(S('textStyle'))) : new ActionDescriptor();
                overrideStyle(style, piece);
                item.putInteger(S('from'), piece.from);
                item.putInteger(S('to'), piece.to);
                item.putObject(S('textStyle'), S('textStyle'), style);
                list.putObject(S('textStyleRange'), item);
            }
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

    // Build a one-shot repair plan: every segment Photoshop substituted with a
    // DIFFERENT family is re-pointed at the CJK font (Chinese faces carry the
    // widest glyph set, so the swap sticks). Same-family weight normalizations
    // are left alone (verifyPlan already accepts them).
    function repairPlanFromActual(usedPlan, actual, cnPS) {
        if (!cnPS) return [];
        var out = [], i, j, p, a, changed = false;
        for (i = 0; i < usedPlan.length; i++) {
            p = usedPlan[i];
            var swap = false;
            if (p.psName) {
                for (j = 0; j < actual.length; j++) {
                    a = actual[j];
                    if (a.to <= p.from || a.from >= p.to) continue;
                    var got = a.psName || '';
                    if (got && got !== p.psName) {
                        var wm = metaOfPSName(p.psName), wg = metaOfPSName(got);
                        if (!(wm && wg && wm.family === wg.family)) { swap = true; changed = true; }
                    }
                    if (swap) break;
                }
            }
            out.push(swap
                ? { from: p.from, to: p.to, psName: cnPS, size: p.size, rgb: p.rgb, trck: p.trck }
                : { from: p.from, to: p.to, psName: p.psName, size: p.size, rgb: p.rgb, trck: p.trck });
        }
        if (!changed) return [];
        // merge adjacent segments that ended up identical (no pointless splits)
        var merged = [], m;
        for (m = 0; m < out.length; m++) {
            var last = merged.length ? merged[merged.length - 1] : null;
            var same = last && last.psName === out[m].psName &&
                (last.size === null) === (out[m].size === null) &&
                (last.size === null || String(last.size) === String(out[m].size)) &&
                (!last.rgb) === (!out[m].rgb) &&
                (!last.trck) === (!out[m].trck);
            if (same) last.to = out[m].to;
            else merged.push(out[m]);
        }
        return merged;
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
                    // same family, different weight: the requested style is not
                    // installed and Photoshop kept the nearest weight. The face
                    // the user asked for IS on the glyphs - not a substitution.
                    var wm = metaOfPSName(p.psName), wg = metaOfPSName(got);
                    if (wm && wg && wm.family === wg.family) continue;
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

    function segmentsOf(text, symSide) {
        var segs = [], start = 0, prev = false, i, cur, ch;
        if (!text || !text.length) return segs;
        prev = sideOfCharCtx(text.charAt(0), symSide, text, 0);
        for (i = 1; i < text.length; i++) {
            ch = text.charAt(i);
            // line breaks and blanks carry no glyphs: let them ride with the
            // previous character's side so runs like "I XXV" or wrapped CJK
            // lines stay one range (spec \u00a77: whitespace never blocks)
            if (ch === '\r' || ch === '\n' || ch === ' ' || ch === '\t') { cur = prev; }
            else cur = sideOfCharCtx(ch, symSide, text, i);
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



    function fontPerChar(text, cnPS, enPS, cnSize, enSize, cnColor, enColor, symSide) {
        var cnO = { psName: cnPS, size: cnSize, rgb: cnColor, trck: null };
        var enO = { psName: enPS, size: enSize, rgb: enColor, trck: null };
        var segs = segmentsOf(text, symSide), perChar = [], i, j, o;
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
        var segs = segmentsOf(text, args.symSide);
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
                var plan = fontPerChar(text, cnPS, enPS, args.cnSize, args.enSize, args.syncColor === false ? null : args.cnColor, args.syncColor === false ? null : args.enColor, args.symSide);
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
                    // Photoshop swapped some ranges to a fallback face (the
                    // requested Latin display font lacks those glyphs). Self
                    // repair, once: re-plan every substituted range with the
                    // CJK font (broadest glyph coverage) and rewrite. If the
                    // repair verifies clean the layer counts as fully applied.
                    _substituted = true;
                    var repaired = repairPlanFromActual(used.plan, readRanges(layer.id, text.length), cnPS);
                    var repairProbs = [];
                    if (repaired.length) {
                        try {
                            stage('layer ' + (i + 1) + ' self-repair');
                            applyRangesSafe(layer.id, repaired, text.length, notes);
                            repairProbs = verifyPlan(layer.id, repaired, text.length);
                        } catch (eR) {
                            repairProbs = probs;   // repair failed: report the original verdict
                        }
                    }
                    if (repairProbs.length) {
                        out.ok++;
                        out.path = used.path;
                        out.substituted.push(String(layer.name) + ' -> ' +
                            '\u5b57\u4f53\u88ab Photoshop \u66ff\u6362\uff1a\u8bf7\u6c42 ' + repairProbs[0].wanted + '\uff0c\u5b9e\u9645 ' + repairProbs[0].got + '\uff08\u533a\u95f4 ' + repairProbs[0].range + '\uff09' +
                            ' [' + notes.join(' ') + ']');
                    } else {
                        _substituted = false;
                        out.ok++;
                        out.path = used.path + '+repair';
                    }
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
            // first text layer empty: per spec MD \u00a79 fall through to the
            // next selected text layer instead of giving up
            var li, found = false;
            for (li = 1; li < layers.length; li++) {
                text = textContentsOf(layers[li]);
                if (text.length) { layer = layers[li]; found = true; break; }
            }
            if (!found) {
                out.emptyReason = 'empty-text';
                out.emptyLayer = String(layers[0].name || '(unnamed)');
                return jval(out);
            }
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
            var segs = segmentsOf(text.substring(rr.from, Math.min(rr.to, text.length)), 'auto');
            for (var s = 0; s < segs.length; s++) {
                var side = segs[s][2] ? 'cn' : 'en';
                // spaces ride with either side; a whitespace-only segment says
                // nothing about the font the user actually sees - skipping them
                // keeps detection honest for mixed runs like "hello \u4e16\u754c"
                var segTxt = text.substring(rr.from + segs[s][0], rr.from + segs[s][1]);
                if (!/[^ \t\n\r\u00A0]/.test(segTxt)) continue;
                seen[side] = true;
                if (side === 'cn') {
                    if (!cnFont && rr.psName) { var mf = metaOfPSName(rr.psName); if (mf) cnFont = { family: mf.family, style: mf.style }; }
                    if (!cnColor && rr.rgb) cnColor = rr.rgb;
                    if (rr.size != null) cnSizes[rr.size] = true;
                    else unknown.cn = true;
                } else {
                    if (!enFont && rr.psName) { var ef = metaOfPSName(rr.psName); if (ef) enFont = { family: ef.family, style: ef.style }; }
                    if (!enColor && rr.rgb) enColor = rr.rgb;
                    if (rr.size != null) enSizes[rr.size] = true;
                    else unknown.en = true;
                }
            }
            // per-side size capture is complete in the block above; the old
            // unconditional `unknown=true` when ONE range lacked a size
            // mis-flagged mixed sizes for whole mixed-style layers.
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

    /* ---- font snapshot / restore (auto-kerning safety net) ----
       Photoshop's DOM textItem writes can silently roll a scripted
       mixed-font state back to the font that was active before. These
       three helpers snapshot per-character fonts, compare after the DOM
       writes, and re-apply the exact fonts when they were clobbered. */
    function fontSnapshotOf(layerId, textLen) {
        var rr = readRanges(layerId, textLen), out = [], i;
        for (i = 0; i < rr.length; i++) {
            out.push({ from: rr[i].from, to: rr[i].to, psName: rr[i].psName || null });
        }
        return out;
    }
    function fontsDiffer(snap, now) {
        if (!snap || !now || !snap.length || !now.length) return false;
        var n = 0, i, j;
        // count distinct font-covered chars in each; different counts = changed
        for (i = 0; i < snap.length; i++) n += (snap[i].to - snap[i].from);
        var m = 0;
        for (j = 0; j < now.length; j++) m += (now[j].to - now[j].from);
        if (n !== m) return true;
        // same coverage: compare psName per overlapping span
        for (i = 0; i < snap.length; i++) {
            for (j = 0; j < now.length; j++) {
                if (now[j].to <= snap[i].from || now[j].from >= snap[i].to) continue;
                if ((now[j].psName || '') !== (snap[i].psName || '')) return true;
            }
        }
        return false;
    }
    function snapshotPlan(snap, textLen) {
        var out = [], i, p;
        for (i = 0; i < snap.length; i++) {
            p = snap[i];
            if (!p.psName) continue;
            if (p.from < 0) p.from = 0;
            if (p.to > textLen) p.to = textLen;
            if (p.to <= p.from) continue;
            out.push({ from: p.from, to: p.to, psName: p.psName, size: null, rgb: null, trck: null });
        }
        return out;
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
            // DOM property writes (autoKerning / useAutoLeading) make Photoshop
            // re-store the whole text object from its own cache, which can roll
            // a just-applied mixed-font write back to the old font. Snapshot the
            // per-character fonts first, compare after, re-apply if clobbered.
            var kernText = textContentsOf(layer);
            var fontSnap = (kernText.length) ? fontSnapshotOf(layer.id, kernText.length) : null;
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
            // DOM writes above may have rolled mixed fonts back (PS re-stores
            // the whole text object from its cache). Restore the snapshot.
            if (fontSnap && fontSnap.length) {
                var afterKern = readRanges(layer.id, kernText.length);
                if (fontsDiffer(fontSnap, afterKern)) {
                    try {
                        stage('font-restore layer ' + (i + 1));
                        applyRanges(layer.id, snapshotPlan(fontSnap, kernText.length), kernText.length);
                        out.fontRestored = (out.fontRestored || 0) + 1;
                    } catch (eR) {
                        if (!inArray(out.skipped, 'font-restore: ' + errText(eR))) out.skipped.push('font-restore: ' + errText(eR));
                    }
                }
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

        // CJK punctuation only: the paired-outer nudge targets fullwidth
        // brackets/quotes. Halfwidth (ASCII) punctuation keeps its own spacing.
        var symRe = /[\u2000-\u206F\u2E00-\u2E7F\u3000-\u303F\uFF01-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65]/;
        var excl = { '#': 1, '*': 1, '\u00A5': 1, '\u00B7': 1, '~': 1, '%': 1, '&': 1, '.': 1, '/': 1, '\\': 1, '-': 1, '+': 1 };
        // paired OUTER nudge: fullwidth pairs only (Chinese punctuation)
        var openPairsOuter = {
            '\uFF08': '\uFF09', '\uFF3B': '\uFF3D', '\u3010': '\u3011', '\u300A': '\u300B',
            '\u3008': '\u3009', '\u201C': '\u201D', '\u2018': '\u2019',
            '\u300C': '\u300D', '\u300E': '\u300F', '\uFF5B': '\uFF5D'
        };
        var closeMapOuter = {};
        for (var pk in openPairsOuter) if (openPairsOuter.hasOwnProperty(pk)) closeMapOuter[openPairsOuter[pk]] = pk;

        var stack = [], matched = [], idx, ch;
        for (idx = 0; idx < text.length; idx++) {
            ch = text.charAt(idx);
            if (openPairsOuter[ch]) stack.push(idx);
            else if (closeMapOuter[ch] && stack.length && openPairsOuter[text.charAt(stack[stack.length - 1])] === ch) {
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
