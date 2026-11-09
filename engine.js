// 江都麻将 · 胡子引擎（与 tools/engine-ref.mjs 逐字一致）
// 浏览器和 Node 测试共用这一份，避免"测的和跑的不是同一段代码"。
//
// 牌码：
//   数牌  1w..9w (万) / 1t..9t (条) / 1b..9b (筒)
//   字牌  E 东  S 南  W 西  N 北  Z 中  F 发  B 白
//   花    chun xia qiu dong

const HONORS = ['E', 'S', 'W', 'N', 'Z', 'F', 'B'];
const FLOWER_HU = 4;

export const GROUP_KINDS = ['PAIR', 'MING_KE', 'AN_KE', 'MING_GANG', 'AN_GANG'];

export function parseTile(code) {
  const honorRank = HONORS.indexOf(code);
  if (honorRank >= 0) {
    return { code, suit: 'H', rank: honorRank + 1 };
  }
  const m = /^([1-9])([wtb])$/.exec(code);
  if (!m) throw new Error(`bad tile code: ${code}`);
  return { code, suit: m[2], rank: Number(m[1]) };
}

/** 牌的档位。胡数只需要「中张 / 非中张」两档。 */
export function tileFacts(code) {
  const t = parseTile(code);
  const isHonor = t.suit === 'H';
  const isWind = isHonor && t.rank <= 4;
  const isDragon = isHonor && t.rank >= 5;
  // 中张 = 数牌 2..8
  const isMiddle = !isHonor && t.rank >= 2 && t.rank <= 8;
  return { ...t, isHonor, isWind, isDragon, isMiddle };
}

/**
 * 单个组的胡数。
 *   base : 碰 = 2 (中张) / 4 (幺九·字·风)
 *   暗刻 ×2，明杠 ×4，暗杠 ×8
 *   含百搭的刻子一律按暗刻档
 */
export function groupHuZi(g) {
  const f = tileFacts(g.tile);
  const base = f.isMiddle ? 2 : 4;
  const jokers = g.jokers ?? 0;

  switch (g.kind) {
    case 'PAIR':
      return f.isDragon || f.isWind ? 2 : 0;
    case 'MING_KE':
      return jokers > 0 ? base * 2 : base;
    case 'AN_KE':
      return base * 2;
    case 'MING_GANG':
      return base * 4;
    case 'AN_GANG':
      return base * 8;
    default:
      throw new Error(`bad group kind: ${g.kind}`);
  }
}

export function huZi(hand) {
  const flowers = (hand.flowers ?? []).length * FLOWER_HU;
  const groups = (hand.groups ?? []).reduce((s, g) => s + groupHuZi(g), 0);
  return flowers + groups;
}

/**
 * 番：只有刻/杠计番（对子不计）。
 *   中发白 每个刻/杠 1 番
 *   门风 1 番、圈风 1 番（同一组同时命中则 2 番）
 *   自己对应的那张花在手 1 番
 */
export function fan(hand) {
  let f = 0;
  for (const g of hand.groups ?? []) {
    if (g.kind === 'PAIR') continue;
    const facts = tileFacts(g.tile);
    if (facts.isDragon) f += 1;
    const tags = g.fan ?? [];
    if (tags.includes('MEN_FENG')) f += 1;
    if (tags.includes('QUAN_FENG')) f += 1;
  }
  const own = hand.ownFlower;
  if (own && (hand.flowers ?? []).includes(own)) f += 1;
  return f;
}

/** 番数 = 2^番 */
export function multiplier(fanCount) {
  return 2 ** fanCount;
}

export function score(hand) {
  const h = huZi(hand);
  const f = fan(hand);
  return { huZi: h, fan: f, multiplier: multiplier(f), score: h * multiplier(f) };
}
