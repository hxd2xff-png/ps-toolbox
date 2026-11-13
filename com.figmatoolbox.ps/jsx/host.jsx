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

    var HOST_VERSION = '4.4.7';
    var _writeAttempted = false;
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
       every hop is checked. activeLayers and selectedLayers are merged and
       de-duplicated; activeLayer is the final fallback. The source is reported
       back. */

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

        // Different Photoshop versions expose multi-selection through different
        // properties. Do not let a non-empty activeLayers result hide the more
        // complete selectedLayers result (or vice versa).
        var refs = [], sources = [], notes = [], seen = {}, l = null, i, one, id, key;
        function addList(list, source) {
            if (!list || typeof list.length !== 'number') return;
            for (var n = 0; n < list.length; n++) {
                try {
                    one = list[n];
                    if (!one) continue;
                    id = null;
                    try { id = one.id; } catch (eId) { }
                    key = (id !== null && id !== undefined) ? String(id) : ('ref-' + refs.length);
                    if (seen[key]) continue;
                    seen[key] = true;
                    refs.push(one);
                    if (!inArray(sources, source)) sources.push(source);
                } catch (eItem) { }
            }
        }
        try { l = asArray(d.activeLayers); } catch (e1) { }
        addList(l, 'activeLayers');
        try { l = asArray(d.selectedLayers); } catch (e2) { }
        addList(l, 'selectedLayers');
        // Action Manager exposes multi-selection on ExtendScript hosts without DOM collections.
        if (!refs.length) {
            try {
                var selectionRef = new ActionReference();
                selectionRef.putProperty(S('property'), S('targetLayersIDs'));
                selectionRef.putEnumerated(S('document'), S('ordinal'), S('targetEnum'));
                var selectionDesc = executeActionGet(selectionRef);
                var ids = selectionDesc.getList(S('targetLayersIDs'));
                var wanted = {};
                for (i = 0; i < ids.count; i++) wanted[String(ids.getReference(i).getIdentifier())] = true;
                function findSelected(items) {
                    for (var j = 0; j < items.length; j++) {
                        var item = items[j];
                        if (wanted[String(item.id)]) addList([item], 'targetLayersIDs');
                        if (item.typename === 'LayerSet') findSelected(item.layers);
                    }
                }
                findSelected(d.layers);
            } catch (eAM) { notes.push('targetLayersIDs-unavailable: ' + errText(eAM)); }
        }
        if (!refs.length) {
            try {
                one = d.activeLayer;
                if (one) addList([one], 'activeLayer');
            } catch (e3) { }
        }
        if (!refs.length) return { refs: [], from: 'empty' };
        return { refs: refs, from: sources.join('+'), notes: notes };
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

    function collectTextLayers(src) {
        var layers = [], seen = {}, failed = [];
        function visit(layer) {
            try {
                var key = String(layer.id);
                if (seen[key]) return;
                seen[key] = true;
                if (layer.typename === 'LayerSet') {
                    for (var i = 0; i < layer.layers.length; i++) visit(layer.layers[i]);
                } else if (isTextLayer(layer)) layers.push(layer);
            } catch (e) { failed.push({ name: String(layer.name || '?'), stage: 'collect', reason: errText(e) }); }
        }
        for (var i = 0; i < src.refs.length; i++) visit(src.refs[i]);
        return { layers: layers, failed: failed };
    }

    // Automatic detection resolves only selected IDs and selected group subtrees.
    // Keep the DOM-based collector above for explicit write operations.
    var _autoSelection = null;
    function automaticSelection() {
        var d = docSafe(), ids = [], docId = '', notes = [];
        if (!d) return { sig: 'no-document', from: 'no-document', layers: [], notes: notes };
        try { docId = String(d.id); } catch (eDoc) { }
        try {
            var ref = new ActionReference();
            ref.putProperty(S('property'), S('targetLayersIDs'));
            ref.putEnumerated(S('document'), S('ordinal'), S('targetEnum'));
            var list = executeActionGet(ref).getList(S('targetLayersIDs'));
            for (var i = 0; i < list.count; i++) ids.push(list.getReference(i).getIdentifier());
        } catch (eSelection) {
            // Merge only exposed selection collections; never resolve via d.layers.
            ids = [];
            var selectedSeen = {};
            function appendSelected(items) {
                if (!items) return;
                for (var k = 0; k < items.length; k++) {
                    try {
                        var selectedId = items[k].id, selectedKey = String(selectedId);
                        if (selectedId !== undefined && selectedId !== null && !selectedSeen[selectedKey]) {
                            selectedSeen[selectedKey] = true; ids.push(selectedId);
                        }
                    } catch (eItem) { }
                }
            }
            try { appendSelected(asArray(d.activeLayers)); } catch (eA) { }
            try { appendSelected(asArray(d.selectedLayers)); } catch (eS) { }
            if (ids.length) notes.push('selection-dom-multiple');
            else {
                try { appendSelected([d.activeLayer]); } catch (eActive) { }
                notes.push('selection-active-only');
            }
        }
        ids.sort(function(a,b){return a-b;});
        var sig = docId + ':' + ids.join(',');
        if (!notes.length && _autoSelection && _autoSelection.sig === sig) return _autoSelection;
        var layers = [], seen = {}, containsGroup = false;
        function descriptor(id, index) {
            var r = new ActionReference();
            if (index) r.putIndex(S('layer'), id);
            else r.putIdentifier(S('layer'), id);
            return executeActionGet(r);
        }
        function section(v) {
            return hasKey(v, 'layerSection') ? v.getEnumerationValue(S('layerSection')) : S('layerSectionContent');
        }
        function add(v) {
            if (!hasKey(v, 'layerKind') || v.getInteger(S('layerKind')) !== 3) return;
            var id = v.getInteger(S('layerID'));
            if (seen[String(id)]) return;
            seen[String(id)] = true;
            layers.push({id:id, name:hasKey(v,'name') ? v.getString(S('name')) : ''});
        }
        function fallback(id) {
            var refs = [], lists = [], found = false;
            try { lists.push(asArray(d.activeLayers)); } catch (eA) { }
            try { lists.push(asArray(d.selectedLayers)); } catch (eS) { }
            try { lists.push([d.activeLayer]); } catch (eL) { }
            for (var a = 0; a < lists.length; a++) {
                var items = lists[a];
                if (!items) continue;
                for (var b = 0; b < items.length; b++) {
                    try { if (items[b].id === id) { refs.push(items[b]); found = true; } } catch (eItem) { }
                }
            }
            if (found) {
                var collected = collectTextLayers({refs:refs});
                for (var c = 0; c < collected.layers.length; c++) {
                    var layer = collected.layers[c], key = String(layer.id);
                    if (!seen[key]) { seen[key] = true; layers.push(layer); }
                }
                notes.push('selected-dom-fallback:' + id);
            }
        }
        for (var n = 0; n < ids.length; n++) {
            var beforeCount = layers.length;
            try {
                var v = descriptor(ids[n], false);
                if (v.getInteger(S('layerID')) !== ids[n]) throw new Error('layer-id-mismatch');
                if (section(v) !== S('layerSectionStart')) { add(v); continue; }
                containsGroup = true;
                // AM group children occupy lower indices, ending at its sectionEnd.
                var groupIndex = v.getInteger(S('itemIndex'));
                var atIndex = null;
                try { atIndex = descriptor(groupIndex, true); } catch (eIndex) { }
                if (!atIndex || atIndex.getInteger(S('layerID')) !== ids[n]) {
                    groupIndex--;
                    atIndex = descriptor(groupIndex, true);
                    if (atIndex.getInteger(S('layerID')) !== ids[n]) throw new Error('group-index-unresolved');
                }
                var depth = 1, index = groupIndex - 1;
                for (; index >= 0 && depth > 0; index--) {
                    var child = descriptor(index, true), sec = section(child);
                    if (sec === S('layerSectionEnd')) depth--;
                    else if (sec === S('layerSectionStart')) depth++;
                    else add(child);
                }
                if (depth) throw new Error('group-boundary-unresolved');
            } catch (eLayer) {
                // Discard a partially resolved subtree before attempting known DOM refs.
                while (layers.length > beforeCount) { var removed = layers.pop(); delete seen[String(removed.id)]; }
                notes.push('selection-read:' + ids[n] + ':' + errText(eLayer));
                fallback(ids[n]);
            }
        }
        var result = {sig:sig, from:notes.length ? 'automatic-active-or-partial' : 'targetLayersIDs',
            layers:layers, selectedCount:ids.length, notes:notes};
        // Failed reads stay retryable on the next poll.
        // A stable selected group ID does not imply stable children.
        _autoSelection = (notes.length || containsGroup) ? null : result;
        return result;
    }

    /* ---------------- font index ---------------- */

    var _fontIndex = null;
    function fontIndex() {
        if (_fontIndex) return _fontIndex;
        var list = [], fonts = app.fonts, count = fonts.length;
        for (var i = 0; i < count; i++) {
            try {
                var f = fonts[i], ps = '';
                try { ps = f.postScriptName ? String(f.postScriptName) : ''; } catch (ePS) { }
                if (!ps) { try { ps = f.name ? String(f.name) : ''; } catch (eName) { } }
                if (ps) list.push({ family: String(f.family), style: String(f.style), name: ps });
            } catch (eFont) { /* A broken face must not hide all later fonts. */ }
        }
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
    var _fontMetaByPSName = null;
    function metaOfPSName(psName) {
        var list = fontIndex(), i;
        if (!_fontMetaByPSName) {
            _fontMetaByPSName = {};
            for (i = 0; i < list.length; i++) {
                if (!Object.prototype.hasOwnProperty.call(_fontMetaByPSName, list[i].name)) _fontMetaByPSName[list[i].name] = list[i];
            }
        }
        return Object.prototype.hasOwnProperty.call(_fontMetaByPSName, psName) ? _fontMetaByPSName[psName] : null;
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
    function layerScaleOf(layerId, snapshot) {
        try {
            var tk = snapshot || textKeyOf(layerId);
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
            if (st.hasKey(S('size'))) {
                var u = st.getUnitDoubleValue(S('size'));
                if (u && isFinite(u)) info.size = Math.round(u * 100) / 100;
            } else if (st.hasKey(S('Sz  '))) {
                var u2 = st.getUnitDoubleValue(S('Sz  '));
                if (u2 && isFinite(u2)) info.size = Math.round(u2 * 100) / 100;
            }
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
    function readRanges(layerId, textLen, snapshot) {
        var tk = snapshot || textKeyOf(layerId);
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
        out.sort(function(a, b) { return a.from - b.from || a.to - b.to; });
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
        var tk = textKeyOf(layerId);
        _layerScale = layerScaleOf(layerId, tk);   // share this read with transform lookup
        var old = tk.getList(S('textStyleRange'));
        var list = new ActionList();
        // Intersect new overrides with old style boundaries so unspecified
        // fields retain each original range's size, color, tracking and metadata.
        var split = [], pi, oi, cuts, start, end, cut, original, part, key;
        for (pi = 0; pi < plan.length; pi++) {
            original = plan[pi]; cuts = [original.from, original.to];
            for (oi = 0; oi < old.count; oi++) {
                part = old.getObjectValue(oi);
                start = part.getInteger(S('from')); end = part.getInteger(S('to'));
                if (start > original.from && start < original.to) cuts.push(start);
                if (end > original.from && end < original.to) cuts.push(end);
            }
            cuts.sort(function(a,b){return a-b;});
            for (cut = 1; cut < cuts.length; cut++) {
                if (cuts[cut] === cuts[cut-1]) continue;
                part = {}; for (key in original) if (original.hasOwnProperty(key)) part[key] = original[key];
                part.from = cuts[cut-1]; part.to = cuts[cut]; split.push(part);
            }
        }
        var i, seg, base, item, style;
        for (i = 0; i < split.length; i++) {
            seg = split[i];
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
        _writeAttempted = true;
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
                _sizeModeTrying = -1;
                throw eSize;
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
        var problems = [], i, j, p, a, got, cursor, from, to, rgb, planCursor = 0, actualStart = 0;
        for (i = 0; i < plan.length; i++) {
            p = plan[i];
            if (p.from !== planCursor || p.to <= p.from) problems.push({field:'plan-coverage',range:planCursor+'-'+p.from,plan:p.from+'-'+p.to});
            planCursor = p.to;
            cursor = p.from;
            while (actualStart < actual.length && actual[actualStart].to <= p.from) actualStart++;
            for (j = actualStart; j < actual.length; j++) {
                a = actual[j];
                if (a.from >= Math.min(p.to, textLen)) break;
                from = Math.max(p.from, a.from);
                to = Math.min(p.to, a.to, textLen);
                if (from >= to) continue;
                if (from > cursor) problems.push({field:'coverage', range:cursor+'-'+from, plan:p.from+'-'+p.to});
                cursor = Math.max(cursor, to);
                if (p.psName) {
                    got = a.psName || '(none)';
                    if (got !== p.psName) problems.push({field:'font', wanted:p.psName, got:got, range:from+'-'+to, plan:p.from+'-'+p.to});
                }
                rgb = rgbSafe(p.rgb);
                if (rgb && (!a.rgb || Math.abs(a.rgb.r-rgb.r)>1/255 || Math.abs(a.rgb.g-rgb.g)>1/255 || Math.abs(a.rgb.b-rgb.b)>1/255))
                    problems.push({field:'color', range:from+'-'+to, plan:p.from+'-'+p.to});
            }
            if (cursor < Math.min(p.to, textLen)) problems.push({field:'coverage', range:cursor+'-'+Math.min(p.to,textLen), plan:p.from+'-'+p.to});
        }
        if (planCursor < textLen) problems.push({field:'plan-coverage',range:planCursor+'-'+textLen});
        return problems;
    }

    // read the sizes back: a size write can be accepted and still do nothing.
    // With a layer transform the textKey stores base values; the character
    // panel shows base x K, so compare against want x K (the requested size).
    function verifySizes(layerId, plan, textLen) {
        var actual = readRanges(layerId, textLen);
        var K = (_layerScale > 0 ? _layerScale : 1);
        var bad = [], i, j, p, a, want, cursor, from, to, shown, planCursor = 0, actualStart = 0;
        for (i = 0; i < plan.length; i++) {
            p = plan[i];
            want = numOrNull(p.size);
            if (p.to <= p.from || p.from !== planCursor) bad.push({want:want,got:'invalid-plan-coverage',range:planCursor+'-'+p.from});
            planCursor = p.to;
            if (want === null) continue;
            cursor = p.from;
            while (actualStart < actual.length && actual[actualStart].to <= p.from) actualStart++;
            for (j = actualStart; j < actual.length; j++) {
                a = actual[j]; if (a.from >= Math.min(p.to,textLen)) break;
                from = Math.max(p.from,a.from); to = Math.min(p.to,a.to,textLen);
                if (from >= to) continue;
                if (from > cursor) bad.push({want:want,got:'uncovered',range:cursor+'-'+from});
                cursor = Math.max(cursor,to);
                shown = (a.size === null) ? null : a.size * K;
                if (shown === null || Math.abs(shown-want) > Math.max(0.5,want*0.01))
                    bad.push({want:want,got:(shown===null?'null':Math.round(shown*100)/100),range:from+'-'+to});
            }
            if (cursor < Math.min(p.to,textLen)) bad.push({want:want,got:'uncovered',range:cursor+'-'+Math.min(p.to,textLen)});
        }
        if (planCursor < textLen) bad.push({want:null,got:'invalid-plan-coverage',range:planCursor+'-'+textLen});
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

    function fontPerChar(text, cnPS, enPS, cnSize, enSize, cnColor, enColor, symbolFontSide) {
        var cnO = { psName: cnPS, size: cnSize, rgb: cnColor, trck: null };
        var enO = { psName: enPS, size: enSize, rgb: enColor, trck: null };
        // Unicode punctuation/symbol categories only; letters, digits and spaces keep their roles.
        function symbolAt(index) {
            var code = text.charCodeAt(index), other;
            if (code >= 0xDC00 && code <= 0xDFFF && index > 0) { other = text.charCodeAt(index-1); if (other >= 0xD800 && other <= 0xDBFF) code = 0x10000 + (other-0xD800)*1024 + code-0xDC00; }
            else if (code >= 0xD800 && code <= 0xDBFF && index+1 < text.length) { other = text.charCodeAt(index+1); if (other >= 0xDC00 && other <= 0xDFFF) code = 0x10000 + (code-0xD800)*1024 + other-0xDC00; }
            var lo = 0, hi = symbolRanges.length/2-1, mid;
            while (lo <= hi) { mid = Math.floor((lo+hi)/2); if (code < symbolRanges[mid*2]) hi = mid-1; else if (code > symbolRanges[mid*2+1]) lo = mid+1; else return true; }
            return false;
        }
        var symbolRanges = [33,47,58,64,91,96,123,126,161,169,171,172,174,177,180,180,182,184,187,187,191,191,215,215,247,247,706,709,722,735,741,747,749,749,751,767,885,885,894,894,900,901,903,903,1014,1014,1154,1154,1370,1375,1417,1418,1421,1423,1470,1470,1472,1472,1475,1475,1478,1478,1523,1524,1542,1551,1563,1563,1565,1567,1642,1645,1748,1748,1758,1758,1769,1769,1789,1790,1792,1805,2038,2041,2046,2047,2096,2110,2142,2142,2184,2184,2404,2405,2416,2416,2546,2547,2554,2555,2557,2557,2678,2678,2800,2801,2928,2928,3059,3066,3191,3191,3199,3199,3204,3204,3407,3407,3449,3449,3572,3572,3647,3647,3663,3663,3674,3675,3841,3863,3866,3871,3892,3892,3894,3894,3896,3896,3898,3901,3973,3973,4030,4037,4039,4044,4046,4058,4170,4175,4254,4255,4347,4347,4960,4968,5008,5017,5120,5120,5741,5742,5787,5788,5867,5869,5941,5942,6100,6102,6104,6107,6144,6154,6464,6464,6468,6469,6622,6655,6686,6687,6816,6822,6824,6829,6990,6991,7002,7018,7028,7039,7164,7167,7227,7231,7294,7295,7360,7367,7379,7379,8125,8125,8127,8129,8141,8143,8157,8159,8173,8175,8189,8190,8208,8231,8240,8286,8314,8318,8330,8334,8352,8385,8448,8449,8451,8454,8456,8457,8468,8468,8470,8472,8478,8483,8485,8485,8487,8487,8489,8489,8494,8494,8506,8507,8512,8516,8522,8525,8527,8527,8586,8587,8592,9257,9280,9290,9372,9449,9472,10101,10132,11123,11126,11263,11493,11498,11513,11516,11518,11519,11632,11632,11776,11822,11824,11869,11904,11929,11931,12019,12032,12245,12272,12287,12289,12292,12296,12320,12336,12336,12342,12343,12349,12351,12443,12444,12448,12448,12539,12539,12688,12689,12694,12703,12736,12773,12783,12783,12800,12830,12842,12871,12880,12880,12896,12927,12938,12976,12992,13311,19904,19967,42128,42182,42238,42239,42509,42511,42611,42611,42622,42622,42738,42743,42752,42774,42784,42785,42889,42890,43048,43051,43062,43065,43124,43127,43214,43215,43256,43258,43260,43260,43310,43311,43359,43359,43457,43469,43486,43487,43612,43615,43639,43641,43742,43743,43760,43761,43867,43867,43882,43883,44011,44011,64297,64297,64434,64466,64830,64847,64912,64913,64968,64975,65020,65023,65040,65049,65072,65106,65108,65126,65128,65131,65281,65295,65306,65312,65339,65344,65371,65381,65504,65510,65512,65518,65532,65533,65792,65794,65847,65855,65913,65929,65932,65934,65936,65948,65952,65952,66000,66044,66463,66463,66512,66512,66927,66927,67671,67671,67703,67704,67871,67871,67903,67903,68176,68184,68223,68223,68296,68296,68336,68342,68409,68415,68505,68508,68974,68974,69006,69007,69293,69293,69328,69336,69461,69465,69510,69513,69703,69709,69819,69820,69822,69825,69952,69955,70004,70005,70085,70088,70093,70093,70107,70107,70109,70111,70200,70205,70313,70313,70612,70613,70615,70616,70731,70735,70746,70747,70749,70749,70854,70854,71105,71127,71233,71235,71264,71276,71353,71353,71484,71487,71739,71739,72004,72006,72162,72162,72255,72262,72346,72348,72350,72354,72448,72457,72673,72673,72769,72773,72816,72817,73463,73464,73539,73551,73685,73713,73727,73727,74864,74868,77809,77810,92782,92783,92917,92917,92983,92991,92996,92997,93549,93551,93847,93850,94178,94178,113820,113820,113823,113823,117760,117999,118010,118012,118016,118451,118458,118480,118496,118512,118608,118723,118784,119029,119040,119078,119081,119140,119146,119148,119171,119172,119180,119209,119214,119274,119296,119361,119365,119365,119552,119638,120513,120513,120539,120539,120571,120571,120597,120597,120629,120629,120655,120655,120687,120687,120713,120713,120745,120745,120771,120771,120832,121343,121399,121402,121453,121460,121462,121475,121477,121483,123215,123215,123647,123647,124415,124415,125278,125279,126124,126124,126128,126128,126254,126254,126704,126705,126976,127019,127024,127123,127136,127150,127153,127167,127169,127183,127185,127221,127245,127405,127462,127490,127504,127547,127552,127560,127568,127569,127584,127589,127744,128728,128732,128748,128752,128764,128768,128985,128992,129003,129008,129008,129024,129035,129040,129095,129104,129113,129120,129159,129168,129197,129200,129211,129216,129217,129232,129240,129280,129623,129632,129645,129648,129660,129664,129674,129678,129734,129736,129736,129741,129756,129759,129770,129775,129784,129792,129938,129940,130031,130042,130042];
        var segs = segmentsOf(text), perChar = [], i, j, o, symbolO;
        for (i = 0; i < segs.length; i++) {
            o = segs[i][2] ? cnO : enO;
            symbolO = { psName: symbolFontSide === 'cn' ? cnPS : enPS, size: o.size, rgb: o.rgb, trck: null };
            for (j = segs[i][0]; j < segs[i][1]; j++) {
                if ((symbolFontSide === 'cn' || symbolFontSide === 'en') && symbolAt(j)) {
                    perChar[j] = symbolO;
                } else perChar[j] = o;
            }
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
        var collected = collectTextLayers(src), layers = collected.layers;
        out.failed = collected.failed;
        out.source = src.from;
        out.sourceNotes = src.notes || [];
        out.selectionLimited = src.from.indexOf('activeLayer') >= 0 && src.from.indexOf('activeLayers') < 0;
        out.total = layers.length;
        out.empty = layers.length === 0;
        if (!layers.length) return jval(out);

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
            _writeAttempted = false;
            try {
                _substituted = false;   // per layer: never leak the previous verdict
                stage('layer ' + (i + 1) + '/' + layers.length + ' read');
                _trace = '';
                text = textContentsOf(layer);
                if (!text.length) { out.ok++; continue; }
                var plan = fontPerChar(text, cnPS, enPS, args.cnSize, args.enSize, args.syncColor === false ? null : args.cnColor, args.syncColor === false ? null : args.enColor, args.symbolFontSide);
                _trace = 'ranges=' + plan.length + ' cn=' + (cnPS || 'none') + ' en=' + (enPS || 'none');
                var notes = [];
                stage('layer ' + (i + 1) + ' write ' + plan.length + ' ranges');
                var used = applyRangesSafe(layer.id, plan, text.length, notes);
                stage('layer ' + (i + 1) + ' verify');
                var probs = verifyPlan(layer.id, used.plan, text.length);
                // verifyPlan reports three kinds of problem. A font mismatch means
                // Photoshop substituted the font: the written result STAYS (it may
                // be partially correct) and re-running the whole-layer DOM fallback
                // would repaint one font over the ranges that did take, so it is
                // reported as a substitution and the layer is still usable.
                // A coverage gap or a colour mismatch is NOT a substitution: the
                // requested ranges were not actually written, so the layer counts
                // as failed, never as a plain success.
                var fontProbs = [], hardProbs = [];
                for (var pi = 0; pi < probs.length; pi++) {
                    if (probs[pi].field === 'font') fontProbs.push(probs[pi]);
                    else hardProbs.push(probs[pi]);
                }
                _substituted = fontProbs.length > 0;
                if (hardProbs.length) {
                    var hardRanges = [], hardFields = [], seenField = {};
                    for (var hi = 0; hi < hardProbs.length; hi++) {
                        hardRanges.push(hardProbs[hi]);
                        if (!seenField[hardProbs[hi].field]) { seenField[hardProbs[hi].field] = true; hardFields.push(hardProbs[hi].field); }
                    }
                    out.path = used.path;
                    out.failed.push({ id: layer.id, name: String(layer.name),
                        reason: '\u5199\u5165\u540e\u56de\u8bfb\u4e0e\u8bf7\u6c42\u4e0d\u7b26\uff1a' + hardFields.join('/') +
                            '\uff08\u9996\u4e2a\u533a\u95f4 ' + hardProbs[0].range + '\uff09',
                        stage: _stage, line: null, trace: _trace,
                        writeAttempted: true, state: 'unknown',
                        integrity: '\u5df2\u53d1\u751f\u5199\u5165\uff0c\u56de\u8bfb\u5b58\u5728\u672a\u5199\u5165\u6216\u989c\u8272\u4e0d\u7b26\u533a\u95f4\uff0c\u6df7\u6392\u5b8c\u6574\u6027\u672a\u77e5',
                        fields: hardFields, ranges: hardRanges, substituted: fontProbs.length > 0 });
                    for (var hs = 0; hs < notes.length; hs++) if (!inArray(out.notes, notes[hs])) out.notes.push(notes[hs]);
                    continue;
                }
                if (fontProbs.length) {
                    out.path = used.path;
                    out.substituted.push(String(layer.name) + ' -> ' +
                        '\u5b57\u4f53\u88ab Photoshop \u66ff\u6362\uff1a\u8bf7\u6c42 ' + fontProbs[0].wanted + '\uff0c\u5b9e\u9645 ' + fontProbs[0].got + '\uff08\u533a\u95f4 ' + fontProbs[0].range + '\uff09' +
                        ' [' + notes.join(' ') + ']');
                    for (var fs = 0; fs < notes.length; fs++) if (!inArray(out.notes, notes[fs])) out.notes.push(notes[fs]);
                    continue;
                }
                out.ok++;
                out.path = used.path;
                for (var n = 0; n < notes.length; n++) if (!inArray(out.notes, notes[n])) out.notes.push(notes[n]);
            } catch (e) {
                out.failed.push({ id: layer.id, name: String(layer.name), reason: errText(e), stage: _stage,
                    line: e.line, trace: _trace, writeAttempted: _writeAttempted,
                    state: _writeAttempted ? 'unknown' : 'unchanged',
                    integrity: _writeAttempted ? '可能部分修改，混排完整性未知' : '未发生写入' });
            }
        }
        return jval(out);
    }

    /* ---------------- style detect (fill the form) ---------------- */

    function detectFontMix() {
        stage('collect');
        var selection = automaticSelection();
        var src = {from:selection.from, notes:selection.notes, refs:new Array(selection.selectedCount || 0)};
        var collected = {layers:selection.layers, failed:[]}, layers = collected.layers;
        var fields = {}, names = ['cnFont','enFont','cnSize','enSize','cnColor','enColor'];
        var out = { empty: true, source: src.from, sourceNotes: src.notes || [], layerCount: layers.length, selectedCount: src.refs.length,
            // same rule as applyFontMix: when only the active layer could be read,
            // say so, otherwise the message "只确认活动层" never reaches the panel
            selectionLimited: src.from.indexOf('activeLayer') >= 0 && src.from.indexOf('activeLayers') < 0 || selection.notes.length > 0,
            operation: 'detect-font', failed: collected.failed, fields: fields, layers: [] };
        var seen = {cn:false, en:false}, styleSeen = {cn:false, en:false}, errors = false;
        // Detection only: exclude known whitespace/punctuation, not unknown
        // letters or digits. Keep the shared write classifier and colors intact.
        function styleWhitespace(ch) {
            var code = ch && ch.length ? ch.charCodeAt(0) : -1;
            return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32 || code === 160 || code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 8203 || code === 65279;
        }
        function stylePunctuation(ch) {
            var code = ch && ch.length ? ch.charCodeAt(0) : -1;
            return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) ||
                (code >= 91 && code <= 96) || (code >= 123 && code <= 126) ||
                code === 161 || code === 171 || code === 183 || code === 187 || code === 191 ||
                (code >= 8208 && code <= 8231) || code === 8249 || code === 8250;
        }
        function styleSideOf(ch, hasBody) {
            if (styleWhitespace(ch)) return null;
            if (isCJK(ch)) return 'cn';
            return hasBody && stylePunctuation(ch) ? null : 'en';
        }
        for (var n = 0; n < names.length; n++) fields[names[n]] = {state:'empty', value:null, sources:[]};
        function add(key, value, source) {
            var f = fields[key], fingerprint = value === null ? null : jval(value);
            f.sources.push(source);
            if (value === null) {
                f.state = 'unrecognized'; f.value = null;
                if (key.indexOf('Font') >= 0) source.reason = source.psName ? 'font-index-miss' : 'font-identity-missing';
                return;
            }
            if (f.state === 'unrecognized' || f.state === 'mixed') return;
            if (f.state === 'empty') { f.state = 'consistent'; f.value = value; }
            else if (jval(f.value) !== fingerprint) { f.state = 'mixed'; f.value = null; }
        }
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            out.layers.push({id:layer.id, name:String(layer.name)});
            try {
                stage('read-ranges');
                var text = textContentsOf(layer);
                if (!text.length) continue;
                out.empty = false;
                var snapshot = textKeyOf(layer.id);
                var ranges = readRanges(layer.id, text.length, snapshot), K = layerScaleOf(layer.id, snapshot);
                // Split at color-side or font/size participation changes.
                // Eligibility is per layer, never derived from another selection.
                var hasBody = false;
                for (var c = 0; c < text.length; c++) {
                    var ch = text.charAt(c);
                    if (!isCJK(ch) && !styleWhitespace(ch) && !stylePunctuation(ch)) { hasBody = true; break; }
                }
                var p = 0, r = 0, rr, end, runStart, side, nextSide, styleSide, nextStyleSide, meta, source;
                while (p < text.length) {
                    while (r < ranges.length && ranges[r].to <= p) r++;
                    rr = (r < ranges.length && ranges[r].from <= p && ranges[r].to > p) ? ranges[r] : null;
                    end = rr ? Math.min(text.length, rr.to) : (r < ranges.length ? Math.min(text.length, ranges[r].from) : text.length);
                    side = isCJK(text.charAt(p)) ? 'cn' : 'en';
                    styleSide = styleSideOf(text.charAt(p), hasBody);
                    runStart = p++;
                    while (p < end) {
                        nextSide = isCJK(text.charAt(p)) ? 'cn' : 'en';
                        nextStyleSide = styleSideOf(text.charAt(p), hasBody);
                        if (nextSide !== side || nextStyleSide !== styleSide) break;
                        p++;
                    }
                    seen[side] = true;
                    if (styleSide) {
                        styleSeen[styleSide] = true;
                        meta = rr && rr.psName ? metaOfPSName(rr.psName) : null;
                        source = {id:layer.id, name:String(layer.name), from:runStart, to:p, psName:rr ? rr.psName : null};
                        add(styleSide+'Font', meta ? {family:meta.family, style:meta.style} : null, source);
                        add(styleSide+'Size', rr && rr.size != null ? Math.round(rr.size*K*100)/100 : null, {id:layer.id,from:runStart,to:p});
                    }
                    add(side+'Color', rr && rr.rgb ? rr.rgb : null, {id:layer.id,from:runStart,to:p});
                }
            } catch (e) { errors = true; out.failed.push({id:layer.id,name:String(layer.name),reason:errText(e),stage:_stage,line:e.line}); }
        }
        for (n = 0; n < names.length; n++) {
            var key = names[n], field = fields[key], sideKey = key.substr(0,2);
            var fieldSeen = key.indexOf('Color') >= 0 ? seen : styleSeen;
            if (errors || collected.failed.length) { field.state = 'error'; field.value = null; }
            else if (!fieldSeen[sideKey] && fieldSeen[sideKey === 'cn' ? 'en' : 'cn']) {
                var other = fields[(sideKey === 'cn' ? 'en' : 'cn')+key.substr(2)];
                field.state = other.state; field.value = other.value; field.sources = other.sources; field.convenience = true;
            }
            out[key] = field.value;
            if (key.indexOf('Size') >= 0) out[key+'Mixed'] = field.state === 'mixed';
        }
        return jval(out);
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
        var out = { nodes: 0, applied: 0, failed: 0, empty: true, mode: 'optical', optical: 0, skipped: [], source: '' };
        var src = activeLayerSource();
        var layers = [];
        walkLayers(src.refs, function (l) { if (isTextLayer(l)) layers.push(l); });
        out.source = src.from;
        out.nodes = layers.length;
        if (!layers.length) return jval(out);
        out.empty = false;

        if (!opticalSupported()) {
            out.mode = 'unsupported';
            out.failed = layers.length;
            out.skipped.push('AutoKernType.OPTICAL unavailable in this Photoshop version');
            return jval(out);
        }

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            try {
                stage('optical layer ' + (i + 1) + ' write');
                layer.textItem.autoKerning = AutoKernType.OPTICAL;
                stage('optical layer ' + (i + 1) + ' verify');
                var back = layer.textItem.autoKerning;
                if (back === AutoKernType.OPTICAL || String(back) === String(AutoKernType.OPTICAL)) {
                    out.applied++;
                } else {
                    out.failed++;
                    out.skipped.push(String(layer.name) + ': Photoshop did not retain Optical');
                }
            } catch (eO) {
                out.failed++;
                if (!inArray(out.skipped, errText(eO))) out.skipped.push(String(layer.name) + ': ' + errText(eO));
            }
        }
        out.optical = out.applied;
        out.mode = out.failed ? (out.applied ? 'optical-partial' : 'none') : 'optical';
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
        var selection = automaticSelection();
        var textIds = [];
        for (var i = 0; i < selection.layers.length; i++) textIds.push(selection.layers[i].id);
        textIds.sort(function(a,b){return a-b;});
        return jval({sig:selection.sig, from:selection.from, textCount:textIds.length,
            targetSig:textIds.join(','), readState:selection.notes.length ? 'partial' : 'ready', sourceNotes:selection.notes});
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
        o.layerSource = 'not-scanned';
        o.layerCount = 'not-scanned';
        if (d) {
            try { o.activeLayersType = (d.activeLayers === undefined) ? 'undefined' : typeof d.activeLayers; } catch (e4) { o.activeLayersType = 'throw:' + errText(e4); }
            try { o.selectedLayersType = (d.selectedLayers === undefined) ? 'undefined' : typeof d.selectedLayers; } catch (e5) { o.selectedLayersType = 'throw:' + errText(e5); }
        }
        o.layerKind = (typeof LayerKind !== 'undefined' && LayerKind) ? ('ok:TEXT=' + String(LayerKind.TEXT)) : 'missing';
        o.autoKernType = (typeof AutoKernType !== 'undefined' && AutoKernType) ? ('ok:OPTICAL=' + String(AutoKernType.OPTICAL)) : 'missing';
        try { o.showColorPicker = typeof app.showColorPicker; } catch (e6) { o.showColorPicker = 'err:' + errText(e6); }
        try { o.stringIDToTypeID = typeof stringIDToTypeID; } catch (e7) { o.stringIDToTypeID = 'err:' + errText(e7); }
        o.fonts = _fontIndex ? _fontIndex.length : 'not-indexed';
        o.textLayers = 'not-scanned';
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
