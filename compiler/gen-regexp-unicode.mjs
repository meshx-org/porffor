// generates the unicode table section of compiler/builtins/regexp.ts from node's own ICU (and
// the emoji sequence files of its unicode version, fetched from unicode.org, as candidates)
// usage: node compiler/gen-regexp-unicode.mjs <output.ts>, then splice into regexp.ts

const MAX = 0x110000;

const varint = (arr, n) => { // 7-bit groups, little end first, high bit = continue
  while (n > 127) { arr.push((n & 127) | 128); n >>>= 7; }
  arr.push(n);
};
const zigzag = n => n < 0 ? (-n * 2 - 1) : n * 2;

const normalize = ranges => { // sort + merge adjacent/overlapping
  ranges.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of ranges) {
    if (out.length && s <= out[out.length - 1][1] + 1) out[out.length - 1][1] = Math.max(e, out[out.length - 1][1]);
    else out.push([s, e]);
  }
  return out;
};

const xorRangesSimple = (a, b) => { // symmetric difference (one-off, bitset is fine)
  const bits = new Uint8Array(MAX);
  for (const [s, e] of a) for (let i = s; i <= e; i++) bits[i] ^= 1;
  for (const [s, e] of b) for (let i = s; i <= e; i++) bits[i] ^= 1;
  const out = [];
  let start = -1;
  for (let i = 0; i < MAX; i++) {
    if (bits[i] && start === -1) start = i;
    if (!bits[i] && start !== -1) { out.push([start, i - 1]); start = -1; }
  }
  if (start !== -1) out.push([start, MAX - 1]);
  return out;
};

// scan a \p property via node's regex engine

const scanProp = (expr, flag = 'u') => {
  if (flag === 'v') { // strings could swallow neighbours in a chunk, so cp by cp
    const re = new RegExp(`^\\p{${expr}}$`, 'v');
    const ranges = [];
    for (let cp = 0; cp < MAX; cp++) if (re.test(String.fromCodePoint(cp))) ranges.push([ cp, cp ]);
    return normalize(ranges);
  }
  const re = new RegExp(`\\p{${expr}}`, 'g' + flag);
  const reSingle = new RegExp(`\\p{${expr}}`, flag);
  const ranges = [];
  let rs = -1, rePrev = -2;
  const push = cp => {
    if (cp === rePrev + 1) { rePrev = cp; return; }
    if (rs !== -1) ranges.push([rs, rePrev]);
    rs = cp; rePrev = cp;
  };

  const CHUNK = 0x8000;
  for (let base = 0; base < MAX; base += CHUNK) {
    const end = Math.min(base + CHUNK, MAX);
    // surrogate cps tested individually to avoid pair-merging artifacts in the chunk string
    for (let cp = Math.max(base, 0xD800); cp < Math.min(end, 0xE000); cp++) {
      if (reSingle.test(String.fromCodePoint(cp))) push(cp);
    }
    let str = '';
    for (let cp = base; cp < end; cp++) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;
      str += String.fromCodePoint(cp);
    }
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(str))) push(str.codePointAt(m.index));
  }
  if (rs !== -1) ranges.push([rs, rePrev]);
  return normalize(ranges);
};

const GC = ['Lu','Ll','Lt','Lm','Lo','Mn','Mc','Me','Nd','Nl','No','Pc','Pd','Ps','Pe','Pi','Pf','Po','Sm','Sc','Sk','So','Zs','Zl','Zp','Cc','Cf','Co','Cs','Cn'];
console.error('scanning general categories...');
const gcOf = new Uint8Array(MAX).fill(GC.indexOf('Cn'));
for (let i = 0; i < GC.length; i++) {
  if (GC[i] === 'Cn') continue;
  for (const [s, e] of scanProp(`General_Category=${GC[i]}`)) gcOf.fill(i, s, e + 1);
}

// blob is run count, then varint length + gc index per run
const gcBytes = [];
{
  const runs = [];
  let runStart = 0;
  for (let i = 1; i <= MAX; i++) {
    if (i === MAX || gcOf[i] !== gcOf[runStart]) { runs.push([i - runStart, gcOf[runStart]]); runStart = i; }
  }
  varint(gcBytes, runs.length);
  for (const [len, gc] of runs) { varint(gcBytes, len); gcBytes.push(gc); }
  console.error(`gc: ${runs.length} runs, ${gcBytes.length} bytes`);
}

const gcMaskRanges = mask => {
  const out = [];
  let start = -1;
  for (let i = 0; i < MAX; i++) {
    const inSet = (mask & (1 << gcOf[i])) !== 0;
    if (inSet && start === -1) start = i;
    if (!inSet && start !== -1) { out.push([start, i - 1]); start = -1; }
  }
  if (start !== -1) out.push([start, MAX - 1]);
  return out;
};

const maskOf = names => names.reduce((m, n) => m | (1 << GC.indexOf(n)), 0);
const M = {
  L: maskOf(['Lu','Ll','Lt','Lm','Lo']),
  LC: maskOf(['Lu','Ll','Lt']),
  M: maskOf(['Mn','Mc','Me']),
  N: maskOf(['Nd','Nl','No']),
  P: maskOf(['Pc','Pd','Ps','Pe','Pi','Pf','Po']),
  S: maskOf(['Sm','Sc','Sk','So']),
  Z: maskOf(['Zs','Zl','Zp']),
  C: maskOf(['Cc','Cf','Co','Cs','Cn']),
};

// [canonical name, base gc mask (xor-encoded against), aliases...]
const BINPROPS = [
  ['ASCII', 0],
  ['ASCII_Hex_Digit', 0, 'AHex'],
  ['Alphabetic', M.L | maskOf(['Nl']), 'Alpha'],
  ['Any', 0],
  ['Assigned', 0x3fffffff ^ (1 << GC.indexOf('Cn'))],
  ['Bidi_Control', 0, 'Bidi_C'],
  ['Bidi_Mirrored', 0, 'Bidi_M'],
  ['Case_Ignorable', maskOf(['Mn','Me','Cf','Lm','Sk']), 'CI'],
  ['Cased', M.LC],
  ['Changes_When_Casefolded', maskOf(['Lu','Lt']), 'CWCF'],
  ['Changes_When_Casemapped', M.LC, 'CWCM'],
  ['Changes_When_Lowercased', maskOf(['Lu']), 'CWL'],
  ['Changes_When_NFKC_Casefolded', maskOf(['Lu','Lt']), 'CWKCF'],
  ['Changes_When_Titlecased', maskOf(['Ll']), 'CWT'],
  ['Changes_When_Uppercased', maskOf(['Ll']), 'CWU'],
  ['Dash', 0],
  ['Default_Ignorable_Code_Point', 0, 'DI'],
  ['Deprecated', 0, 'Dep'],
  ['Diacritic', maskOf(['Lm','Sk']), 'Dia'],
  ['Emoji', 0],
  ['Emoji_Component', 0, 'EComp'],
  ['Emoji_Modifier', 0, 'EMod'],
  ['Emoji_Modifier_Base', 0, 'EBase'],
  ['Emoji_Presentation', 0, 'EPres'],
  ['Extended_Pictographic', 0, 'ExtPict'],
  ['Extender', 0, 'Ext'],
  ['Grapheme_Base', 0x3fffffff ^ maskOf(['Cc','Cf','Co','Cs','Cn','Zl','Zp','Mn','Me']), 'Gr_Base'],
  ['Grapheme_Extend', maskOf(['Mn','Me']), 'Gr_Ext'],
  ['Hex_Digit', 0, 'Hex'],
  ['IDS_Binary_Operator', 0, 'IDSB'],
  ['IDS_Trinary_Operator', 0, 'IDST'],
  ['ID_Continue', M.L | maskOf(['Nl','Mn','Mc','Nd','Pc']), 'IDC'],
  ['ID_Start', M.L | maskOf(['Nl']), 'IDS'],
  ['Ideographic', 0, 'Ideo'],
  ['Join_Control', 0, 'Join_C'],
  ['Logical_Order_Exception', 0, 'LOE'],
  ['Lowercase', maskOf(['Ll']), 'Lower'],
  ['Math', maskOf(['Sm'])],
  ['Noncharacter_Code_Point', 0, 'NChar'],
  ['Pattern_Syntax', 0, 'Pat_Syn'],
  ['Pattern_White_Space', 0, 'Pat_WS'],
  ['Quotation_Mark', 0, 'QMark'],
  ['Radical', 0],
  ['Regional_Indicator', 0, 'RI'],
  ['Sentence_Terminal', 0, 'STerm'],
  ['Soft_Dotted', 0, 'SD'],
  ['Terminal_Punctuation', 0, 'Term'],
  ['Unified_Ideograph', 0, 'UIdeo'],
  ['Uppercase', maskOf(['Lu']), 'Upper'],
  ['Variation_Selector', 0, 'VS'],
  ['White_Space', 0, 'space', 'WSpace'],
  ['XID_Continue', M.L | maskOf(['Nl','Mn','Mc','Nd','Pc']), 'XIDC'],
  ['XID_Start', M.L | maskOf(['Nl']), 'XIDS'],
];

console.error('scanning binary properties...');
const propBytes = [];
const propOffsets = [];
for (const [name, baseMask] of BINPROPS) {
  propOffsets.push(propBytes.length);
  let ranges;
  if (name === 'Any') ranges = [[0, MAX - 1]];
  else if (name === 'ASCII') ranges = [[0, 0x7F]];
  else if (name === 'Assigned') ranges = xorRangesSimple(gcMaskRanges(1 << GC.indexOf('Cn')), [[0, MAX - 1]]);
  else ranges = scanProp(name);

  const xr = baseMask ? xorRangesSimple(ranges, gcMaskRanges(baseMask)) : ranges;
  varint(propBytes, baseMask);
  varint(propBytes, xr.length);
  let last = 0;
  for (const [s, e] of xr) { varint(propBytes, s - last); varint(propBytes, e - s); last = e + 1; }
  console.error(`  ${name}: ${xr.length} xor-ranges`);
}
propOffsets.push(propBytes.length);
console.error(`binary props total: ${propBytes.length} bytes`);

// Script and Script_Extensions: every cp has one (sc, scx) combo, stored as runs of combo index.
// [canonical name, aliases...], index 0 is Unknown (the default for unlisted cps)
const SCRIPTS = [
  ['Unknown', 'Zzzz'], ['Adlam', 'Adlm'], ['Ahom'], ['Anatolian_Hieroglyphs', 'Hluw'], ['Arabic', 'Arab'],
  ['Armenian', 'Armn'], ['Avestan', 'Avst'], ['Balinese', 'Bali'], ['Bamum', 'Bamu'], ['Bassa_Vah', 'Bass'],
  ['Batak', 'Batk'], ['Bengali', 'Beng'], ['Beria_Erfe', 'Berf'], ['Bhaiksuki', 'Bhks'],
  ['Bopomofo', 'Bopo'], ['Brahmi', 'Brah'], ['Braille', 'Brai'], ['Buginese', 'Bugi'], ['Buhid', 'Buhd'],
  ['Canadian_Aboriginal', 'Cans'], ['Carian', 'Cari'], ['Caucasian_Albanian', 'Aghb'], ['Chakma', 'Cakm'],
  ['Cham'], ['Cherokee', 'Cher'], ['Chorasmian', 'Chrs'], ['Common', 'Zyyy'], ['Coptic', 'Copt', 'Qaac'],
  ['Cuneiform', 'Xsux'], ['Cypriot', 'Cprt'], ['Cypro_Minoan', 'Cpmn'], ['Cyrillic', 'Cyrl'],
  ['Deseret', 'Dsrt'], ['Devanagari', 'Deva'], ['Dives_Akuru', 'Diak'], ['Dogra', 'Dogr'],
  ['Duployan', 'Dupl'], ['Egyptian_Hieroglyphs', 'Egyp'], ['Elbasan', 'Elba'], ['Elymaic', 'Elym'],
  ['Ethiopic', 'Ethi'], ['Garay', 'Gara'], ['Georgian', 'Geor'], ['Glagolitic', 'Glag'], ['Gothic', 'Goth'],
  ['Grantha', 'Gran'], ['Greek', 'Grek'], ['Gujarati', 'Gujr'], ['Gunjala_Gondi', 'Gong'],
  ['Gurmukhi', 'Guru'], ['Gurung_Khema', 'Gukh'], ['Han', 'Hani'], ['Hangul', 'Hang'],
  ['Hanifi_Rohingya', 'Rohg'], ['Hanunoo', 'Hano'], ['Hatran', 'Hatr'], ['Hebrew', 'Hebr'],
  ['Hiragana', 'Hira'], ['Imperial_Aramaic', 'Armi'], ['Inherited', 'Qaai', 'Zinh'],
  ['Inscriptional_Pahlavi', 'Phli'], ['Inscriptional_Parthian', 'Prti'], ['Javanese', 'Java'],
  ['Kaithi', 'Kthi'], ['Kannada', 'Knda'], ['Katakana', 'Kana'], ['Kawi'], ['Kayah_Li', 'Kali'],
  ['Kharoshthi', 'Khar'], ['Khitan_Small_Script', 'Kits'], ['Khmer', 'Khmr'], ['Khojki', 'Khoj'],
  ['Khudawadi', 'Sind'], ['Kirat_Rai', 'Krai'], ['Lao', 'Laoo'], ['Latin', 'Latn'], ['Lepcha', 'Lepc'],
  ['Limbu', 'Limb'], ['Linear_A', 'Lina'], ['Linear_B', 'Linb'], ['Lisu'], ['Lycian', 'Lyci'],
  ['Lydian', 'Lydi'], ['Mahajani', 'Mahj'], ['Makasar', 'Maka'], ['Malayalam', 'Mlym'], ['Mandaic', 'Mand'],
  ['Manichaean', 'Mani'], ['Marchen', 'Marc'], ['Masaram_Gondi', 'Gonm'], ['Medefaidrin', 'Medf'],
  ['Meetei_Mayek', 'Mtei'], ['Mende_Kikakui', 'Mend'], ['Meroitic_Cursive', 'Merc'],
  ['Meroitic_Hieroglyphs', 'Mero'], ['Miao', 'Plrd'], ['Modi'], ['Mongolian', 'Mong'], ['Mro', 'Mroo'],
  ['Multani', 'Mult'], ['Myanmar', 'Mymr'], ['Nabataean', 'Nbat'], ['Nag_Mundari', 'Nagm'],
  ['Nandinagari', 'Nand'], ['New_Tai_Lue', 'Talu'], ['Newa'], ['Nko', 'Nkoo'], ['Nushu', 'Nshu'],
  ['Nyiakeng_Puachue_Hmong', 'Hmnp'], ['Ogham', 'Ogam'], ['Ol_Chiki', 'Olck'], ['Ol_Onal', 'Onao'],
  ['Old_Hungarian', 'Hung'], ['Old_Italic', 'Ital'], ['Old_North_Arabian', 'Narb'], ['Old_Permic', 'Perm'],
  ['Old_Persian', 'Xpeo'], ['Old_Sogdian', 'Sogo'], ['Old_South_Arabian', 'Sarb'], ['Old_Turkic', 'Orkh'],
  ['Old_Uyghur', 'Ougr'], ['Oriya', 'Orya'], ['Osage', 'Osge'], ['Osmanya', 'Osma'],
  ['Pahawh_Hmong', 'Hmng'], ['Palmyrene', 'Palm'], ['Pau_Cin_Hau', 'Pauc'], ['Phags_Pa', 'Phag'],
  ['Phoenician', 'Phnx'], ['Psalter_Pahlavi', 'Phlp'], ['Rejang', 'Rjng'], ['Runic', 'Runr'],
  ['Samaritan', 'Samr'], ['Saurashtra', 'Saur'], ['Sharada', 'Shrd'], ['Shavian', 'Shaw'],
  ['Siddham', 'Sidd'], ['Sidetic', 'Sidt'], ['SignWriting', 'Sgnw'], ['Sinhala', 'Sinh'],
  ['Sogdian', 'Sogd'], ['Sora_Sompeng', 'Sora'], ['Soyombo', 'Soyo'], ['Sundanese', 'Sund'],
  ['Sunuwar', 'Sunu'], ['Syloti_Nagri', 'Sylo'], ['Syriac', 'Syrc'], ['Tagalog', 'Tglg'],
  ['Tagbanwa', 'Tagb'], ['Tai_Le', 'Tale'], ['Tai_Tham', 'Lana'], ['Tai_Viet', 'Tavt'], ['Tai_Yo', 'Tayo'],
  ['Takri', 'Takr'], ['Tamil', 'Taml'], ['Tangsa', 'Tnsa'], ['Tangut', 'Tang'], ['Telugu', 'Telu'],
  ['Thaana', 'Thaa'], ['Thai'], ['Tibetan', 'Tibt'], ['Tifinagh', 'Tfng'], ['Tirhuta', 'Tirh'],
  ['Todhri', 'Todr'], ['Tolong_Siki', 'Tols'], ['Toto'], ['Tulu_Tigalari', 'Tutg'], ['Ugaritic', 'Ugar'],
  ['Vai', 'Vaii'], ['Vithkuqi', 'Vith'], ['Wancho', 'Wcho'], ['Warang_Citi', 'Wara'],
  ['Yezidi', 'Yezi'], ['Yi', 'Yiii'], ['Zanabazar_Square', 'Zanb'],
];

console.error('scanning scripts...');
const scOf = new Uint8Array(MAX);
const scxOf = new Array(MAX); // only set where scx is not just {sc}
{
  const scxLists = new Map();
  for (let i = 1; i < SCRIPTS.length; i++) {
    for (const [s, e] of scanProp(`Script=${SCRIPTS[i][0]}`)) scOf.fill(i, s, e + 1);
    for (const [s, e] of scanProp(`Script_Extensions=${SCRIPTS[i][0]}`)) {
      for (let cp = s; cp <= e; cp++) {
        let l = scxLists.get(cp);
        if (!l) scxLists.set(cp, l = []);
        l.push(i);
      }
    }
  }
  for (let cp = 0; cp < MAX; cp++) {
    const l = scxLists.get(cp) ?? [ 0 ];
    if (l.length !== 1 || l[0] !== scOf[cp]) scxOf[cp] = l;
  }
}

// combos are (sc, scx list), scx list empty when it is just {sc}
const scriptBytes = [];
{
  const comboIdx = new Map();
  const combos = [];
  const comboAt = cp => {
    const key = scOf[cp] + (scxOf[cp] ? ':' + scxOf[cp].join(',') : '');
    let idx = comboIdx.get(key);
    if (idx === undefined) {
      comboIdx.set(key, idx = combos.length);
      combos.push([ scOf[cp], scxOf[cp] ?? [] ]);
    }
    return idx;
  };
  const runs = [];
  let runStart = 0, runCombo = comboAt(0);
  for (let i = 1; i <= MAX; i++) {
    const c = i === MAX ? -1 : comboAt(i);
    if (c !== runCombo) { runs.push([ i - runStart, runCombo ]); runStart = i; runCombo = c; }
  }
  varint(scriptBytes, combos.length);
  for (const [ sc, scx ] of combos) {
    varint(scriptBytes, sc);
    varint(scriptBytes, scx.length);
    for (const x of scx) varint(scriptBytes, x);
  }
  varint(scriptBytes, runs.length);
  for (const [ len, c ] of runs) { varint(scriptBytes, len); varint(scriptBytes, c); }
  console.error(`scripts: ${combos.length} combos, ${runs.length} runs, ${scriptBytes.length} bytes`);
}
const scriptDirStr = SCRIPTS.flatMap((names, i) => names.map(n => `${n}=${i}`)).join(';');

// properties of strings (v flag): the emoji sequence files of node's unicode version are the
// candidates, node's own \p{...}/v the judge. RGI_Emoji is the union of the other six, so not stored
const STRING_PROPS = [ 'Basic_Emoji', 'Emoji_Keycap_Sequence', 'RGI_Emoji_Modifier_Sequence', 'RGI_Emoji_Flag_Sequence', 'RGI_Emoji_Tag_Sequence', 'RGI_Emoji_ZWJ_Sequence' ];
console.error('fetching emoji sequences...');
const emojiSeqs = new Map(STRING_PROPS.map(x => [ x, [] ]));
for (const file of [ 'emoji-sequences.txt', 'emoji-zwj-sequences.txt' ]) {
  const url = `https://www.unicode.org/Public/${process.versions.unicode}.0/emoji/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  for (const line of (await res.text()).split('\n')) {
    const l = line.replace(/#.*/, '').trim();
    if (!l) continue;
    const [ cps, type ] = l.split(';').map(x => x.trim());
    const list = emojiSeqs.get(type);
    if (!list) continue;
    if (cps.includes('..')) {
      const [ a, b ] = cps.split('..').map(x => parseInt(x, 16));
      for (let c = a; c <= b; c++) list.push([ c ]);
    } else list.push(cps.split(/\s+/).map(x => parseInt(x, 16)));
  }
}

// per property: varint range count, ranges as (gap, length) varints, varint string count, then
// the strings sorted, each as shared prefix length with the one before, suffix length, and the
// suffix cps as zigzag deltas (from the cp above in the string before, else the cp before)
const stringPropBytes = [];
const stringPropOffsets = [];
const cmpCps = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
for (const name of STRING_PROPS) {
  const list = emojiSeqs.get(name);
  const re = new RegExp(`^\\p{${name}}$`, 'v');
  for (const s of list) if (!re.test(String.fromCodePoint(...s))) throw new Error(`${name}: node disagrees on ${s.map(x => x.toString(16))}`);
  const singles = normalize(list.filter(s => s.length === 1).map(s => [ s[0], s[0] ]));
  const scanned = scanProp(name, 'v');
  if (JSON.stringify(singles) !== JSON.stringify(scanned)) throw new Error(`${name}: single code points differ from node`);
  const multi = list.filter(s => s.length > 1).sort(cmpCps);

  stringPropOffsets.push(stringPropBytes.length);
  varint(stringPropBytes, singles.length);
  let last = 0;
  for (const [ s, e ] of singles) { varint(stringPropBytes, s - last); varint(stringPropBytes, e - s); last = e + 1; }
  varint(stringPropBytes, multi.length);
  let prev = [];
  for (const s of multi) {
    let p = 0;
    while (p < s.length && p < prev.length && s[p] === prev[p]) p++;
    varint(stringPropBytes, p);
    varint(stringPropBytes, s.length - p);
    for (let i = p; i < s.length; i++) varint(stringPropBytes, zigzag(s[i] - (i < prev.length ? prev[i] : i > 0 ? s[i - 1] : 0)));
    prev = s;
  }
  console.error(`  ${name}: ${singles.length} ranges, ${multi.length} strings`);
}
{
  // RGI_Emoji must be exactly the union
  const re = new RegExp('^\\p{RGI_Emoji}$', 'v');
  const all = [ ...emojiSeqs.values() ].flat();
  for (const s of all) if (!re.test(String.fromCodePoint(...s))) throw new Error('RGI_Emoji is not the union');
  const singles = normalize(all.filter(s => s.length === 1).map(s => [ s[0], s[0] ]));
  if (JSON.stringify(singles) !== JSON.stringify(scanProp('RGI_Emoji', 'v'))) throw new Error('RGI_Emoji single code points differ');
}
console.error(`string props: ${stringPropBytes.length} bytes`);
const stringPropDirStr = [ ...STRING_PROPS, 'RGI_Emoji' ].map((n, i) => `${n}=${i}`).join(';');

const cpLower = cp => { const s = String.fromCodePoint(cp).toLowerCase(); return [...s].length === 1 ? s.codePointAt(0) : cp; };
const cpUpper = cp => { const s = String.fromCodePoint(cp).toUpperCase(); return [...s].length === 1 ? s.codePointAt(0) : cp; };

console.error('building iu fold classes...');
const foldRep = new Map(); // cp -> canonical rep (min of ui-equivalence class)
{
  const seen = new Set();
  for (let cp = 0; cp < MAX; cp++) {
    if (seen.has(cp)) continue;
    if (cpLower(cp) === cp && cpUpper(cp) === cp) continue;

    const cls = new Set([cp]);
    const queue = [cp];
    while (queue.length) {
      const c = queue.pop();
      for (const n of [cpLower(c), cpUpper(c)]) {
        if (!cls.has(n)) { cls.add(n); queue.push(n); }
      }
    }

    // partition the closure by node's actual ui equivalence (closure can over-join)
    const members = [...cls].sort((a, b) => a - b);
    const groups = [];
    for (const c of members) {
      let placed = false;
      for (const g of groups) {
        if (new RegExp(`^\\u{${g[0].toString(16)}}$`, 'iu').test(String.fromCodePoint(c))) { g.push(c); placed = true; break; }
      }
      if (!placed) groups.push([c]);
    }
    for (const g of groups) {
      for (const c of g) { seen.add(c); if (g.length > 1 && c !== g[0]) foldRep.set(c, g[0]); }
    }
  }
  console.error(`iu fold: ${foldRep.size} mapped cps`);
}

// non-u canonicalize (spec 22.2.2.9): toUpperCase, single-unit results only, no ascii <- non-ascii
const canonNonU = new Map();
for (let ch = 0; ch < 0x10000; ch++) {
  const u = String.fromCharCode(ch).toUpperCase();
  if (u.length !== 1) continue;
  const cu = u.charCodeAt(0);
  if (ch >= 128 && cu < 128) continue;
  if (cu !== ch) canonNonU.set(ch, cu);
}
console.error(`non-u canon: ${canonNonU.size} mapped units`);

// map encoded as varint runs of (gap from last start, count*2 + stride-1, zigzag delta)
const encodeMap = map => {
  const keys = [...map.keys()].sort((a, b) => a - b);
  const runs = [];
  for (const cp of keys) {
    const delta = map.get(cp) - cp;
    const last = runs[runs.length - 1];
    if (last && delta === last.delta) {
      if (last.count === 1) {
        const stride = cp - last.start;
        if (stride === 1 || stride === 2) { last.stride = stride; last.count = 2; continue; }
      } else if (cp === last.start + last.count * last.stride) { last.count++; continue; }
    }
    runs.push({ start: cp, count: 1, stride: 1, delta });
  }
  const bytes = [];
  varint(bytes, runs.length);
  let lastStart = 0;
  for (const r of runs) {
    varint(bytes, r.start - lastStart);
    varint(bytes, r.count * 2 + (r.stride - 1));
    varint(bytes, zigzag(r.delta));
    lastStart = r.start;
  }
  return { bytes, runs: runs.length };
};

const foldEnc = encodeMap(foldRep);
const canonEnc = encodeMap(canonNonU);
console.error(`iu fold: ${foldEnc.runs} runs, ${foldEnc.bytes.length} bytes; non-u canon: ${canonEnc.runs} runs, ${canonEnc.bytes.length} bytes`);

// property name directory: "name=code" entries joined by ';', code b<idx> = binary prop, g<hex> = gc mask

const GC_LONG = {
  Lu: 'Uppercase_Letter', Ll: 'Lowercase_Letter', Lt: 'Titlecase_Letter', Lm: 'Modifier_Letter', Lo: 'Other_Letter',
  Mn: 'Nonspacing_Mark', Mc: 'Spacing_Mark', Me: 'Enclosing_Mark',
  Nd: 'Decimal_Number', Nl: 'Letter_Number', No: 'Other_Number',
  Pc: 'Connector_Punctuation', Pd: 'Dash_Punctuation', Ps: 'Open_Punctuation', Pe: 'Close_Punctuation',
  Pi: 'Initial_Punctuation', Pf: 'Final_Punctuation', Po: 'Other_Punctuation',
  Sm: 'Math_Symbol', Sc: 'Currency_Symbol', Sk: 'Modifier_Symbol', So: 'Other_Symbol',
  Zs: 'Space_Separator', Zl: 'Line_Separator', Zp: 'Paragraph_Separator',
  Cc: 'Control', Cf: 'Format', Co: 'Private_Use', Cs: 'Surrogate', Cn: 'Unassigned',
};
const dirEntries = [];
for (let i = 0; i < GC.length; i++) {
  dirEntries.push([GC[i], 'g' + (1 << i).toString(16)]);
  dirEntries.push([GC_LONG[GC[i]], 'g' + (1 << i).toString(16)]);
}
dirEntries.push(['L', 'g' + M.L.toString(16)], ['Letter', 'g' + M.L.toString(16)],
  ['LC', 'g' + M.LC.toString(16)], ['Cased_Letter', 'g' + M.LC.toString(16)],
  ['M', 'g' + M.M.toString(16)], ['Mark', 'g' + M.M.toString(16)], ['Combining_Mark', 'g' + M.M.toString(16)],
  ['N', 'g' + M.N.toString(16)], ['Number', 'g' + M.N.toString(16)],
  ['P', 'g' + M.P.toString(16)], ['Punctuation', 'g' + M.P.toString(16)], ['punct', 'g' + M.P.toString(16)],
  ['S', 'g' + M.S.toString(16)], ['Symbol', 'g' + M.S.toString(16)],
  ['Z', 'g' + M.Z.toString(16)], ['Separator', 'g' + M.Z.toString(16)],
  ['C', 'g' + M.C.toString(16)], ['Other', 'g' + M.C.toString(16)],
  ['cntrl', 'g' + (1 << GC.indexOf('Cc')).toString(16)],
  ['digit', 'g' + (1 << GC.indexOf('Nd')).toString(16)]);
for (let i = 0; i < BINPROPS.length; i++) {
  const [name, _base, ...aliases] = BINPROPS[i];
  dirEntries.push([name, 'b' + i]);
  for (const a of aliases) dirEntries.push([a, 'b' + i]);
}
const dirStr = dirEntries.map(([n, c]) => `${n}=${c}`).join(';');
console.error(`directory: ${dirEntries.length} names, ${dirStr.length} bytes`);

const escStr = bytes => {
  let out = '';
  for (const b of bytes) {
    if (b === 0x27 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else out += '\\x' + b.toString(16).padStart(2, '0');
  }
  return out;
};

const wrap = s => `'${s}'`; // single literal: builtins can't concat-fold, keep it one segment

const propOffsetsBytes = [];
for (const o of propOffsets) varint(propOffsetsBytes, o);

const out = `// autogenerated by gen-unicode.js from node's unicode support (${process.version}) - do not edit
// compact tables consumed by the code above; data as funcs since builtins only export funcs

export const __Porffor_regex_ucdGc = (): bytestring => ${wrap(escStr(gcBytes))};

export const __Porffor_regex_ucdProps = (): bytestring => ${wrap(escStr(propBytes))};

export const __Porffor_regex_ucdPropOffsets = (): bytestring => ${wrap(escStr(propOffsetsBytes))};

export const __Porffor_regex_ucdDir = (): bytestring => ${wrap(dirStr.replace(/\\/g, '\\\\').replace(/'/g, "\\'"))};

export const __Porffor_regex_ucdFold = (): bytestring => ${wrap(escStr(foldEnc.bytes))};

export const __Porffor_regex_ucdCanon = (): bytestring => ${wrap(escStr(canonEnc.bytes))};

export const __Porffor_regex_ucdScripts = (): bytestring => ${wrap(escStr(scriptBytes))};

export const __Porffor_regex_ucdScriptDir = (): bytestring => ${wrap(scriptDirStr)};

export const __Porffor_regex_ucdStringProps = (): bytestring => ${wrap(escStr(stringPropBytes))};

export const __Porffor_regex_ucdStringPropOffsets = (): bytestring => ${wrap(escStr(stringPropOffsets.flatMap(o => { const b = []; varint(b, o); return b; })))};

export const __Porffor_regex_ucdStringPropDir = (): bytestring => ${wrap(stringPropDirStr)};
`;

const total = stringPropBytes.length + scriptBytes.length + scriptDirStr.length + gcBytes.length + propBytes.length + propOffsetsBytes.length + dirStr.length + foldEnc.bytes.length + canonEnc.bytes.length;
console.error(`total data: ${total} bytes (${(total / 1024).toFixed(1)}KB)`);

import fs from 'node:fs';
fs.writeFileSync(process.argv[2] ?? 'regexp_data.ts', out);
console.error(`wrote ${process.argv[2] ?? 'regexp_data.ts'}`);
