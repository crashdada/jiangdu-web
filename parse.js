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
 * 从自然语言回答里抽组。
 * 认定规则：一行里同时出现「组型词」和「牌名」才算一组。
 * 张数由组型决定（暗杠/明杠 4，刻/碰 3，对子 2，花 1）。
 */
export function parseProse(raw) {
  const groups = [];
  const flowers = [];
  const dropped = [];
  const seen = new Set();

  for (const rawLine of String(raw).split(/[\n；;]/)) {
    const line = rawLine.replace(/^[\s\-*•\d.、)）]+/, '').trim();
    if (!line || line.length > 200) continue;

    let kind = null;
    for (const [w, k] of KIND_WORDS) {
      if (line.includes(w)) {
        kind = k;
        break;
      }
    }
    if (!kind) continue;

    if (kind === 'FLOWER') {
      // 「春夏秋冬之一」这种说法会同时命中四个字，不能照单全收
      const hit = ['春', '夏', '秋', '冬'].filter((f) => line.includes(f));
      if (hit.length === 1) {
        const c = flowerOf(hit[0]);
        if (c && !flowers.includes(c)) flowers.push(c);
      } else if (hit.length > 1) {
        dropped.push(`花牌不确定: ${line}`);
      }
      continue;
    }

    const tile = findTileIn(line);
    if (!tile) {
      dropped.push(`没找到牌名: ${line}`);
      continue;
    }
    const count = COUNT_BY_KIND[kind];
    const key = `${kind}|${tile}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const jokers = (line.match(/百搭/g) || []).length;
    const kindFinal = jokers > 0 && count >= 3 ? 'AN_KE' : kind;
    groups.push({ kind: kindFinal, tile, jokers: Math.min(jokers, 2), count, raw: [line] });
  }

  return { groups, flowers, dropped, note: '' };
}

