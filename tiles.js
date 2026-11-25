// 江都麻将 · 统一 40 类牌码定义（单一真源）
//
// 规范：
//   数牌  1w..9w (万) / 1t..9t (条) / 1b..9b (筒)
//   字牌  E(东) S(南) W(西) N(北) Z(中) F(发) B(白)
//   花牌  f1(春) f2(夏) f3(秋) f4(冬)
//   特殊  JOKER(百搭) BACK(牌背)

export const HONOR_CODES = ['E', 'S', 'W', 'N', 'Z', 'F', 'B'];
export const FLOWER_CODES = ['f1', 'f2', 'f3', 'f4'];
export const SPECIAL_CODES = ['JOKER', 'BACK'];

export const FLOWERS = [
  { code: 'f1', label: '春' },
  { code: 'f2', label: '夏' },
  { code: 'f3', label: '秋' },
  { code: 'f4', label: '冬' },
];

/**
 * 端侧 YOLO 模型（web/models/tile-yolo.onnx）输出通道 0..39 对应的统一牌码顺序。
 * 与训练权重通道严格绑定，请勿重排。
 */
export const YOLO_CLASS_CODES = [
  '1w', '1t', '1b', '7w', '7t', '7b', '3w', '3t', '3b', 'E',
  'Z',  '9w', '9t', '9b', '2w', '2t', '2b', '5w', '5t', '5b',
  '8w', '8t', '8b', '6w', '6t', '6b', 'f4', 'N',  'S',  'F',
  '4w', '4t', '4b', 'f2', 'f1', 'B',  'JOKER', 'f3', 'BACK', 'W',
];

export const CN_DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
export const HONOR_LABELS = { E: '东', S: '南', W: '西', N: '北', Z: '中', F: '发', B: '白' };
export const FLOWER_LABELS = { f1: '春', f2: '夏', f3: '秋', f4: '冬' };
export const SPECIAL_LABELS = { JOKER: '百搭', BACK: '牌背' };
export const SUIT_LABELS = { w: '万', t: '条', b: '筒' };

/** 将统一牌码转为 UI 展示用中文名称 */
export function tileLabel(code) {
  if (!code) return '未知';
  if (HONOR_LABELS[code]) return HONOR_LABELS[code];
  if (FLOWER_LABELS[code]) return FLOWER_LABELS[code];
  if (SPECIAL_LABELS[code]) return SPECIAL_LABELS[code];
  const m = /^([1-9])([wtb])$/.exec(code);
  if (m) return CN_DIGITS[Number(m[1]) - 1] + SUIT_LABELS[m[2]];
  return code;
}

/** 将中文花牌名或花牌码转为统一花牌码 (f1..f4) */
export function flowerCodeOf(s) {
  const t = (s || '').trim();
  const map = {
    春: 'f1', 夏: 'f2', 秋: 'f3', 冬: 'f4',
    f1: 'f1', f2: 'f2', f3: 'f3', f4: 'f4',
  };
  return map[t] || null;
}
