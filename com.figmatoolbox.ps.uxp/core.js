'use strict';
// UTF-16 offsets and character ownership intentionally match the existing CEP implementation.
function isCJK(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 0x3000 && c <= 0x303f) || (c >= 0x3040 && c <= 0x30ff) ||
    (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef);
}
function segmentsOf(text) {
  const result = [];
  for (let i = 0; i < text.length; i++) {
    const side = isCJK(text[i]) ? 'cn' : 'en';
    const last = result[result.length - 1];
    if (last && last.side === side) last.to = i + 1;
    else result.push({from:i, to:i+1, side});
  }
  return result;
}
// Unicode punctuation/symbol categories, mirrored from com.figmatoolbox.ps/jsx/host.jsx:820
// (same coded table, pasted verbatim; letters, digits and spaces keep their cn/en roles).
const symbolRanges = [33,47,58,64,91,96,123,126,161,169,171,172,174,177,180,180,182,184,187,187,191,191,215,215,247,247,706,709,722,735,741,747,749,749,751,767,885,885,894,894,900,901,903,903,1014,1014,1154,1154,1370,1375,1417,1418,1421,1423,1470,1470,1472,1472,1475,1475,1478,1478,1523,1524,1542,1551,1563,1563,1565,1567,1642,1645,1748,1748,1758,1758,1769,1769,1789,1790,1792,1805,2038,2041,2046,2047,2096,2110,2142,2142,2184,2184,2404,2405,2416,2416,2546,2547,2554,2555,2557,2557,2678,2678,2800,2801,2928,2928,3059,3066,3191,3191,3199,3199,3204,3204,3407,3407,3449,3449,3572,3572,3647,3647,3663,3663,3674,3675,3841,3863,3866,3871,3892,3892,3894,3894,3896,3896,3898,3901,3973,3973,4030,4037,4039,4044,4046,4058,4170,4175,4254,4255,4347,4347,4960,4968,5008,5017,5120,5120,5741,5742,5787,5788,5867,5869,5941,5942,6100,6102,6104,6107,6144,6154,6464,6464,6468,6469,6622,6655,6686,6687,6816,6822,6824,6829,6990,6991,7002,7018,7028,7039,7164,7167,7227,7231,7294,7295,7360,7367,7379,7379,8125,8125,8127,8129,8141,8143,8157,8159,8173,8175,8189,8190,8208,8231,8240,8286,8314,8318,8330,8334,8352,8385,8448,8449,8451,8454,8456,8457,8468,8468,8470,8472,8478,8483,8485,8485,8487,8487,8489,8489,8494,8494,8506,8507,8512,8516,8522,8525,8527,8527,8586,8587,8592,9257,9280,9290,9372,9449,9472,10101,10132,11123,11126,11263,11493,11498,11513,11516,11518,11519,11632,11632,11776,11822,11824,11869,11904,11929,11931,12019,12032,12245,12272,12287,12289,12292,12296,12320,12336,12336,12342,12343,12349,12351,12443,12444,12448,12448,12539,12539,12688,12689,12694,12703,12736,12773,12783,12783,12800,12830,12842,12871,12880,12880,12896,12927,12938,12976,12992,13311,19904,19967,42128,42182,42238,42239,42509,42511,42611,42611,42622,42622,42738,42743,42752,42774,42784,42785,42889,42890,43048,43051,43062,43065,43124,43127,43214,43215,43256,43258,43260,43260,43310,43311,43359,43359,43457,43469,43486,43487,43612,43615,43639,43641,43742,43743,43760,43761,43867,43867,43882,43883,44011,44011,64297,64297,64434,64466,64830,64847,64912,64913,64968,64975,65020,65023,65040,65049,65072,65106,65108,65126,65128,65131,65281,65295,65306,65312,65339,65344,65371,65381,65504,65510,65512,65518,65532,65533,65792,65794,65847,65855,65913,65929,65932,65934,65936,65948,65952,65952,66000,66044,66463,66463,66512,66512,66927,66927,67671,67671,67703,67704,67871,67871,67903,67903,68176,68184,68223,68223,68296,68296,68336,68342,68409,68415,68505,68508,68974,68974,69006,69007,69293,69293,69328,69336,69461,69465,69510,69513,69703,69709,69819,69820,69822,69825,69952,69955,70004,70005,70085,70088,70093,70093,70107,70107,70109,70111,70200,70205,70313,70313,70612,70613,70615,70616,70731,70735,70746,70747,70749,70749,70854,70854,71105,71127,71233,71235,71264,71276,71353,71353,71484,71487,71739,71739,72004,72006,72162,72162,72255,72262,72346,72348,72350,72354,72448,72457,72673,72673,72769,72773,72816,72817,73463,73464,73539,73551,73685,73713,73727,73727,74864,74868,77809,77810,92782,92783,92917,92917,92983,92991,92996,92997,93549,93551,93847,93850,94178,94178,113820,113820,113823,113823,117760,117999,118010,118012,118016,118451,118458,118480,118496,118512,118608,118723,118784,119029,119040,119078,119081,119140,119146,119148,119171,119172,119180,119209,119214,119274,119296,119361,119365,119365,119552,119638,120513,120513,120539,120539,120571,120571,120597,120597,120629,120629,120655,120655,120687,120687,120713,120713,120745,120745,120771,120771,120832,121343,121399,121402,121453,121460,121462,121475,121477,121483,123215,123215,123647,123647,124415,124415,125278,125279,126124,126124,126128,126128,126254,126254,126704,126705,126976,127019,127024,127123,127136,127150,127153,127167,127169,127183,127185,127221,127245,127405,127462,127490,127504,127547,127552,127560,127568,127569,127584,127589,127744,128728,128732,128748,128752,128764,128768,128985,128992,129003,129008,129008,129024,129035,129040,129095,129104,129113,129120,129159,129168,129197,129200,129211,129216,129217,129232,129240,129280,129623,129632,129645,129648,129660,129664,129674,129678,129734,129736,129736,129741,129756,129759,129770,129775,129784,129792,129938,129940,130031,130042,130042];
function symbolAt(text, index) {
  let code = text.charCodeAt(index), other;
  if (code >= 0xDC00 && code <= 0xDFFF && index > 0) {
    other = text.charCodeAt(index - 1);
    if (other >= 0xD800 && other <= 0xDBFF) code = 0x10000 + (other - 0xD800) * 1024 + code - 0xDC00;
  } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
    other = text.charCodeAt(index + 1);
    if (other >= 0xDC00 && other <= 0xDFFF) code = 0x10000 + (code - 0xD800) * 1024 + other - 0xDC00;
  }
  let lo = 0, hi = symbolRanges.length / 2 - 1, mid;
  while (lo <= hi) {
    mid = Math.floor((lo + hi) / 2);
    if (code < symbolRanges[mid * 2]) hi = mid - 1;
    else if (code > symbolRanges[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}
function symbolSideOf(config) {
  const side = config && config.symbolFontSide;
  return side === 'cn' || side === 'en' ? side : null;
}
// The font side of one character. A punctuation/symbol position follows symbolFontSide
// when the user asked for one; every other position keeps the cn/en role of its segment.
function charFontSide(text, index, symSide, segSide) {
  if (symSide && symbolAt(text, index)) return symSide;
  return segSide;
}
const clone = value => JSON.parse(JSON.stringify(value));
function numberValue(v) { return v && typeof v === 'object' ? v._value : v; }
function scaleOf(tk) {
  const xx = tk.transform && numberValue(tk.transform.xx);
  return Number.isFinite(xx) && Math.abs(xx) > 0.0001 ? Math.abs(xx) : 1;
}
function validateRanges(tk) {
  if (!tk || typeof tk.textKey !== 'string' || !Array.isArray(tk.textStyleRange)) throw Error('textKey/textStyleRange 描述符缺失');
  const len = tk.textKey.length;
  let cursor = 0;
  for (const r of tk.textStyleRange) {
    if (!Number.isInteger(r.from) || !Number.isInteger(r.to) || r.from !== cursor || r.to <= r.from || !r.textStyle) throw Error('文本区间不连续或样式缺失');
    cursor = r.to;
    if (cursor >= len) break; // Photoshop may include one terminal character.
  }
  if (cursor < len) throw Error('文本区间覆盖不完整');
  return tk;
}
function field() { return {state:'empty', value:null, sources:[]}; }
function aggregate(records, fonts = [], failed = []) {
  const fields = {}, seen = {cn:false,en:false};
  // A PostScript name the font index does not know means Photoshop has no such font.
  // CEP reports these by family+style and stops before writing (host.jsx:914-916);
  // detect() only reads, so it hands the names back for the panel to show.
  const missSet = [];
  for (const side of ['cn','en']) for (const kind of ['Font','Size','Color','Tracking']) fields[side+kind] = field();
  const index = new Map(fonts.map(f => [f.postScriptName || f.name, f]));
  function add(key,value,source) {
    const f = fields[key]; f.sources.push(source);
    if (value == null) { f.state='unrecognized'; f.value=null; }
    else if (f.state==='empty') { f.state='consistent'; f.value=value; }
    else if (f.state==='consistent' && JSON.stringify(f.value)!==JSON.stringify(value)) { f.state='mixed'; f.value=null; }
    else if (f.state==='unrecognized') f.value=null;
  }
  for (const {id,name,tk} of records) {
    validateRanges(tk);
    const scale = scaleOf(tk);
    for (const seg of segmentsOf(tk.textKey)) {
      seen[seg.side] = true;
      for (const r of tk.textStyleRange) {
        const from=Math.max(seg.from,r.from),to=Math.min(seg.to,r.to);
        if (from>=to) continue;
        const st=r.textStyle, f=index.get(st.fontPostScriptName), source={id,name,from,to,psName:st.fontPostScriptName || null};
        if (!f && st.fontPostScriptName && missSet.indexOf(st.fontPostScriptName) < 0) missSet.push(String(st.fontPostScriptName));
        add(seg.side+'Font',f?{family:f.family,style:f.style}:null,source);
        const size=numberValue(st.size);
        add(seg.side+'Size',Number.isFinite(size)?Math.round(size*scale*100)/100:null,source);
        const color=st.color;
        add(seg.side+'Color',color && [color.red,color.grain,color.blue].every(Number.isFinite)?{r:color.red/255,g:color.grain/255,b:color.blue/255}:null,source);
        add(seg.side+'Tracking',Number.isInteger(st.tracking)?st.tracking:null,source);
      }
    }
  }
  for (const side of ['cn','en']) for (const kind of ['Font','Size','Color','Tracking']) {
    if (failed.length) fields[side+kind]={...fields[side+kind],state:'error',value:null};
    else if (!seen[side] && seen[side==='cn'?'en':'cn']) fields[side+kind]={...fields[(side==='cn'?'en':'cn')+kind],convenience:true};
    else if (fields[side+kind].state==='empty' && seen[side]) fields[side+kind].state='unrecognized';
  }
  return {operation:'detect-font',empty:!records.some(r=>r.tk.textKey.length),layerCount:records.length,fields,failed,missingFonts:missSet,layers:records.map(({id,name})=>({id,name}))};
}
function buildTextKey(original,config,options) {
  validateRanges(original);
  const tk=clone(original), ranges=[];
  // Photoshop variable fonts expose named instances (for example Noto Sans SC Medium)
  // through family/style, while the PostScript name can resolve to the collection's
  // default face. Keep the official trio as the primary write, with a family/style-only
  // fallback for hosts that still normalize the PS name to Light.
  const fontMode=(options && options.fontMode)||'ps-family-style';
  // symbolFontSide: null keeps the CEP default (a symbol follows the cn/en role of its
  // segment); 'cn'/'en' reassigns *punctuation/symbol positions only* to that side's
  // font, while size and colour still come from the segment the position sits in.
  const symSide=symbolSideOf(config);
  for (const seg of segmentsOf(tk.textKey)) for (const old of original.textStyleRange) {
    const from=Math.max(seg.from,old.from),to=Math.min(seg.to,old.to);
    if (from>=to) continue;
    // Per-character ownership, exactly like host.jsx:826-828: each position is judged on
    // its own, so a comma in the middle of an en run still goes where the user asked.
    // Neighbours that resolve to the same side merge back into one range.
    let cut=from;
    for (let j=from+1;j<=to;j++) {
      if (j<to && charFontSide(tk.textKey,j,symSide,seg.side)===charFontSide(tk.textKey,j-1,symSide,seg.side)) continue;
      const item=clone(old), style=item.textStyle;
      item.from=cut; item.to=j;
      const fontSide=charFontSide(tk.textKey,cut,symSide,seg.side);
      const f=config[fontSide+'Font'];
      if (f && !f.postScriptName) throw Error('字体缺少 PostScript 名');
      if (f && f.postScriptName) {
        // A cloned textStyleRange carries the previous face's design axes. Photoshop
        // prioritizes those values over the new named instance, so a Light style kept
        // fontDesignAxes:[{fontDesignAxesVectors:300}] and silently resolved a Medium
        // request back to Light. Clear the stale axis with the rest of the font identity
        // and let Photoshop derive the axis from the requested PostScript name.
        for (const key of ['fontPostScriptName','fontName','fontStyleName','fontScript','fontTechnology','fontAvailable','fontDesignAxes']) delete style[key];
        if (fontMode!=='family-style' || !f.family) style.fontPostScriptName=f.postScriptName;
        // 变量字体的命名实例还必须带上 family/style/fontAvailable；仅写 PostScript
        // 名时 UXP 会退回集合默认实例（实测 Medium 被落成 Light）。
        if (f.family) style.fontName=f.family;
        if (f.style) style.fontStyleName=f.style;
        style.fontAvailable=true;
      }
      const tracking=config[seg.side+'Tracking'];
      if (tracking!=null) {
        if (!Number.isFinite(tracking) || !Number.isInteger(tracking)) throw Error('字距 tracking 须为整数');
        style.tracking=tracking;
      }
      const size=config[seg.side+'Size'];
      if (size!=null) {
        if (!Number.isFinite(size) || size<=0) throw Error('字号必须是正数');
        // Photoshop treats the AM value as the size shown in the Character panel and
        // stores its own pre-transform base value. CEP writes the requested number
        // unchanged (host.jsx:590) and compares read-back * layer scale afterwards.
        style.size={_unit:'pointsUnit',_value:size};
        delete style.impliedFontSize;
      }
      const color=config[seg.side+'Color'];
      if (config.syncColor && color) {
        if (![color.r,color.g,color.b].every(n=>Number.isFinite(n)&&n>=0&&n<=1)) throw Error('颜色值超出范围');
        style.color={_obj:'RGBColor',red:color.r*255,grain:color.g*255,blue:color.b*255};
      }
      ranges.push(item);
      cut=j;
    }
  }
  // Preserve terminal style metadata while avoiding an opaque stale engineData snapshot.
  const terminal=original.textStyleRange.find(r=>r.to>tk.textKey.length);
  if (terminal && tk.textKey.length) ranges.push({...clone(terminal),from:tk.textKey.length});
  tk.textStyleRange=ranges;
  delete tk.engineData;
  return tk;
}
function fontMatchesWanted(style,wanted) {
  if (!wanted) return true;
  if (style.fontPostScriptName===wanted.postScriptName) return true;
  // Some UXP hosts normalize the PostScript name of a variable-font named instance
  // (Medium -> Light) even though family/style read back as the requested instance.
  // Family/style is the only public identity for those instances, so accept it as a
  // successful resolution instead of reporting a false substitution.
  return !!(wanted.family && style.fontName===wanted.family &&
    (!wanted.style || style.fontStyleName===wanted.style));
}
function verifyApplied(actual, expected, config) {
  validateRanges(actual);
  if (actual.textKey!==expected.textKey) throw Error('回读文本发生变化');
  const problems=[],scale=scaleOf(actual);
  for (const p of expected.textStyleRange) {
    if (p.from>=actual.textKey.length) continue;
    for (const a of actual.textStyleRange) {
      const from=Math.max(p.from,a.from),to=Math.min(p.to,a.to,actual.textKey.length);
      if (from>=to) continue;
      const side=charFontSide(actual.textKey,from,symbolSideOf(config),isCJK(actual.textKey[from])?'cn':'en');
      // Size, colour and tracking come from the *segment* side: a symbol only borrows
      // the other side's font, its size/colour/tracking stay with the segment it sits in.
      const owner=isCJK(actual.textKey[from])?'cn':'en';
      const wanted=config[side+'Font'];
      if (wanted && !fontMatchesWanted(a.textStyle,wanted)) problems.push({
        from,to,field:'font',
        wanted:wanted.postScriptName || null,
        wantedLabel:[wanted.family,wanted.style].filter(Boolean).join(' ') || wanted.postScriptName || null,
        got:a.textStyle.fontPostScriptName || null,
        gotFamily:a.textStyle.fontName || null,
        gotStyle:a.textStyle.fontStyleName || null
      });
      const wantSize=config[owner+'Size'];
      if (wantSize!=null && !Number.isFinite(numberValue(a.textStyle.size))) problems.push({from,to,field:'size'});
      else if (wantSize!=null && Math.abs(numberValue(a.textStyle.size)*scale-wantSize)>0.5) problems.push({from,to,field:'size'});
      if (config[owner+'Tracking']!=null && a.textStyle.tracking!==config[owner+'Tracking']) problems.push({from,to,field:'tracking'});
      if (config.syncColor && config[owner+'Color']) {
        const color=a.textStyle.color || {},want=config[owner+'Color'];
        if (!['red','grain','blue'].every((k,i)=>Number.isFinite(color[k])&&Math.abs(color[k]-want[['r','g','b'][i]]*255)<=1)) problems.push({from,to,field:'color'});
      }
    }
  }
  return problems;
}
function restored(actual, original) {
  validateRanges(actual); validateRanges(original);
  if (actual.textKey!==original.textKey) return false;
  // Compare every original boundary against every overlapping returned style.
  for (const p of original.textStyleRange) for (const a of actual.textStyleRange) {
    if (Math.max(p.from,a.from)>=Math.min(p.to,a.to,original.textKey.length)) continue;
    if (JSON.stringify(p.textStyle)!==JSON.stringify(a.textStyle)) return false;
  }
  return JSON.stringify(actual.paragraphStyleRange)===JSON.stringify(original.paragraphStyleRange) && JSON.stringify(actual.transform)===JSON.stringify(original.transform);
}
module.exports={isCJK,segmentsOf,aggregate,buildTextKey,verifyApplied,validateRanges,restored,symbolAt,symbolSideOf,charFontSide};
