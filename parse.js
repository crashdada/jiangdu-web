// 把模型返回的文字解析成 { groups, flowers }
// App 和测试脚本共用，保证「识别→算分」这段逻辑只有一份

const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export function kindOf(s) {
  const m = {
    碰: 'MING_KE', 明刻: 'MING_KE',
    暗刻: 'AN_KE', 刻: 'AN_KE',
    明杠: 'MING_GANG',
    暗杠: 'AN_GANG',
    对子: 'PAIR',
  };
  return m[(s || '').trim()] || null;
}

/** 模型偶尔把 3 张说成 4 张（差 4 倍胡数），用实际张数纠正组型。 */
export function fixKind(kind, count) {
  if (count < 2 || count > 4) return kind;
  const expect = { PAIR: 2, MING_KE: 3, AN_KE: 3, MING_GANG: 4, AN_GANG: 4 }[kind];
  if (count === expect) return kind;
  if (count === 2) return 'PAIR';
  if (count === 3) return kind === 'AN_GANG' || kind === 'AN_KE' ? 'AN_KE' : 'MING_KE';
  return kind === 'AN_GANG' || kind === 'AN_KE' ? 'AN_GANG' : 'MING_GANG';
}

export function tileOf(s) {
  const t = (s || '').trim();
  const honors = {
    东风: 'E', 南风: 'S', 西风: 'W', 北风: 'N',
    红中: 'Z', 中: 'Z', 发财: 'F', 发: 'F', 白板: 'B', 白: 'B',
  };
  if (honors[t]) return honors[t];
  for (let i = 0; i < 9; i++) {
    if (t.length === 2 && t[0] === CN[i]) {
      const suit = { 筒: 'b', 饼: 'b', 条: 't', 索: 't', 万: 'w', 萬: 'w' }[t[1]];
      return suit ? `${i + 1}${suit}` : null;
    }
  }
  return /^[1-9][wtb]$/.test(t) ? t : null;
}

export function flowerOf(s) {
  return { 春: 'chun', 夏: 'xia', 秋: 'qiu', 冬: 'dong' }[(s || '').trim()] || null;
}

const isJoker = (s) => ['百搭', '百搭牌'].includes((s || '').trim());

export function parseResult(raw) {  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('模型没有返回 JSON：' + raw.slice(0, 200));
  const json = JSON.parse(raw.slice(a, b + 1));

  const groups = [];
  const dropped = [];
  for (const o of json.groups || []) {
    const rawKind = kindOf(o.kind);
    if (!rawKind) {
      dropped.push(`组型不认: ${JSON.stringify(o)}`);
      continue;
    }
    let names = Array.isArray(o.tiles) ? o.tiles.slice() : [];
    if (!names.length && o.tile) {
      const n = Math.min(4, Math.max(1, o.count || 3));
      names = Array(n).fill(o.tile);
    }
    if (!names.length) {
      dropped.push(`没有 tiles: ${JSON.stringify(o)}`);
      continue;
    }
    const jokers = Math.min(4, names.filter(isJoker).length);
    const real = names.map((s) => (s || '').trim()).find((s) => !isJoker(s));
    if (!real) {
      dropped.push(`整组都是百搭: ${JSON.stringify(o)}`);
      continue;
    }
    const tile = tileOf(real);
    if (!tile) {
      dropped.push(`牌名不认: ${real}`);
      continue;
    }
    // 百搭能凑 3 张的暗刻，也能凑 2 张的对子（真值里就有「对子 六筒含百搭」）。
    // 所以只有张数 >= 3 才强制成暗刻。
    const kind = jokers > 0 && names.length >= 3 ? 'AN_KE' : fixKind(rawKind, names.length);
    groups.push({ kind, tile, jokers, count: names.length, raw: names });
  }

  const flowers = [];
  for (const f of json.flowers || []) {
    const c = flowerOf(f);
    if (c && !flowers.includes(c)) flowers.push(c);
  }
  return { groups, flowers, dropped, note: json.note || '' };
}

/* ---- 自然语言回答的解析 ---- */

const KIND_WORDS = [
  ['暗杠', 'AN_GANG'],
  ['明杠', 'MING_GANG'],
  ['暗刻', 'AN_KE'],
  ['碰', 'MING_KE'],
  ['对子', 'PAIR'],
  ['花', 'FLOWER'],
];

/** 张数由组型决定，比信模型报的数字可靠 */
const COUNT_BY_KIND = { AN_GANG: 4, MING_GANG: 4, AN_KE: 3, MING_KE: 3, PAIR: 2, FLOWER: 1 };

const TILE_WORDS = [
  ['红中', 'Z'], ['发财', 'F'], ['白板', 'B'], ['发', 'F'], ['中', 'Z'], ['白', 'B'],
  ['东风', 'E'], ['南风', 'S'], ['西风', 'W'], ['北风', 'N'],
  ['东', 'E'], ['南', 'S'], ['西', 'W'], ['北', 'N'],
  ['幺鸡', '1t'], ['一索', '1t'],
];

/** 模型常写繁体（發 / 東 / 萬 / 條），统一成简体再匹配 */
export function normalizeCn(s) {
  return String(s)
    .replace(/發/g, '发')
    .replace(/東/g, '东')
    .replace(/萬/g, '万')
    .replace(/條/g, '条')
    .replace(/索/g, '条')
    .replace(/餅/g, '饼')
    .replace(/筒/g, '筒')
    .replace(/紅/g, '红')
    .replace(/財/g, '财')
    .replace(/東南西北/g, '东南西北');
}

function findTileIn(line) {
  const t = normalizeCn(line);
  for (const [w, code] of TILE_WORDS) {
    if (t.includes(w)) return code;
  }
  // 一筒…九筒 / 一条…九条 / 一万…九万
  for (let i = 0; i < 9; i++) {
    for (const [suffix, suit] of [['筒', 'b'], ['条', 't'], ['万', 'w'], ['饼', 'b']]) {
      if (t.includes(CN[i] + suffix)) return `${i + 1}${suit}`;
    }
  }
  return null;
}

/**
 * 解析「按摆放顺序报牌名」的回答，得到 [{tile, count}]。
 * 用来给结构里的组预填牌名。
 */
export function parseOrderedNames(raw) {
  const out = [];
  for (const rawLine of String(raw).split(/[\n；;]/)) {
    const line = normalizeCn(rawLine.replace(/^[\s\-*•\d.、)）]+/, '')).trim();
    if (!line || !/张/.test(line)) continue;
    if (KIND_WORDS.some(([w]) => line.includes(w))) continue;
    const tile = findTileIn(line);
    if (!tile) continue;
    const m = /(\d+)\s*张/.exec(line);
    out.push({ tile, count: m ? Number(m[1]) : 3 });
  }
  return out;
}

/**
 * 把有序牌名按张数对齐到结构组上。
 * 两张表都按「从上到下、从左到右」排列，所以优先按张数匹配，兜底按顺序。
 */
export function mergeNames(groups, names) {
  const used = new Set();
  const byCount = groups.map((g) => {
    if (g.kind === 'FLOWER') return { ...g, tile: null };
    let idx = -1;
    for (let i = 0; i < names.length; i++) {
      if (!used.has(i) && names[i].count === g.count) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) used.add(idx);
    return { ...g, tile: idx >= 0 ? names[idx].tile : g.tile };
  });

  // 张数对不上的时候（模型把 2 张说成 3 张之类），按张数匹配会大量失败，
  // 这时退化成「按顺序硬配」——两张表都是从上到下、从左到右排的。
  const matched = byCount.filter((g) => g.tile).length;
  const total = groups.filter((g) => g.kind !== 'FLOWER').length;
  if (matched >= total * 0.6) return byCount;

  const out = [];
  let p = 0;
  for (const g of groups) {
    if (g.kind === 'FLOWER' || p >= names.length) {
      out.push({ ...g, tile: g.kind === 'FLOWER' ? null : g.tile });
      continue;
    }
    out.push({ ...g, tile: names[p].tile });
    p++;
  }
  return out;
}

/**
 * 解析「只报结构」的回答：类型 + 张数，没有牌名。
 * 返回的组 tile 为 null，由用户在界面上点选补齐。
 */
export function parseProse(raw) {
  const groups = [];
  const flowers = [];
  const dropped = [];
  let idx = 0;

  for (const rawLine of String(raw).split(/[\n；;]/)) {
    const line = normalizeCn(rawLine.replace(/^[\s\-*•\d.、)）]+/, '').trim());
    if (!line || line.length > 120) continue;

    let kind = null;
    for (const [w, k] of KIND_WORDS) {
      if (line.includes(w)) {
        kind = k;
        break;
      }
    }
    if (!kind) continue;

    const m = /(\d+)\s*张/.exec(line);
    const count = m ? Number(m[1])
      : kind === 'PAIR' ? 2 : kind === 'FLOWER' ? 1 : kind === 'AN_GANG' || kind === 'MING_GANG' ? 4 : 3;

    if (kind === 'FLOWER') {
      const hit = ['春', '夏', '秋', '冬'].filter((f) => line.includes(f));
      if (hit.length === 1) {
        const c = flowerOf(hit[0]);
        if (c && !flowers.includes(c)) flowers.push(c);
      }
      continue;
    }

    // 有些回答会顺带写牌名，能认出来就先填上，认不出留空给用户点
    const tile = findTileIn(line);
    groups.push({ kind, tile: tile || null, jokers: 0, count, idx: idx++ });
  }

  if (!groups.length) dropped.push('没有解析出任何组');
  return { groups, flowers, dropped, note: '' };
}

