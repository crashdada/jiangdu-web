// 按检测框把牌聚成「组」，并按江都麻将规则判定组型
// 江都麻将无顺子，所有组由同种牌（或同种牌+百搭、或1面+3背）构成：
// - 3 张一行 = 碰 (MING_KE)
// - 3 张品字 = 暗刻 (AN_KE)
// - 4 张一行 = 明杠 (MING_GANG)
// - 1 面 + 3 背 = 暗杠 (AN_GANG)
// - 2 张 = 对子 (PAIR)
// - 单张花牌 = 花 (FLOWER)

const FLOWER_CODES = ['chun', 'xia', 'qiu', 'dong'];

function cy(d) {
  return (d.box[1] + d.box[3]) / 2;
}

export function groupDetections(dets) {
  if (!dets || !dets.length) {
    const empty = [];
    empty.groups = [];
    empty.flowers = [];
    return empty;
  }

  // 1. 分离花牌
  const flowers = [];
  const normalDets = [];
  for (const d of dets) {
    if (FLOWER_CODES.includes(d.tile)) {
      flowers.push(d.tile);
    } else {
      normalDets.push(d);
    }
  }

  if (!normalDets.length) {
    const res = [];
    res.groups = [];
    res.flowers = flowers;
    return res;
  }

  // 2. 分离牌背、百搭与常规面牌
  const backs = normalDets.filter((t) => t.tile === 'BACK');
  const jokers = normalDets.filter((t) => t.tile === 'JOKER');
  const faces = normalDets.filter((t) => t.tile !== 'BACK' && t.tile !== 'JOKER');

  const groups = [];

  // 3. 处理暗杠（牌背 + 最近的非牌背牌面）
  if (backs.length > 0) {
    const backBoxes = backs.map((b) => b.box);
    const backCx = backBoxes.reduce((s, b) => s + (b[0] + b[2]) / 2, 0) / backBoxes.length;
    const backCy = backBoxes.reduce((s, b) => s + (b[1] + b[3]) / 2, 0) / backBoxes.length;

    let chosenFace = null;
    let chosenIdx = -1;
    let minDist = Infinity;

    for (let i = 0; i < faces.length; i++) {
      const f = faces[i];
      const d = Math.hypot((f.box[0] + f.box[2]) / 2 - backCx, (f.box[1] + f.box[3]) / 2 - backCy);
      if (d < minDist) {
        minDist = d;
        chosenFace = f;
        chosenIdx = i;
      }
    }

    if (chosenFace) {
      faces.splice(chosenIdx, 1);
    }

    groups.push({
      kind: 'AN_GANG',
      tile: chosenFace ? chosenFace.tile : null,
      count: 4,
      jokers: 0,
      conf: Math.max(...backs.map((b) => b.conf), chosenFace ? chosenFace.conf : 0.5),
      boxes: chosenFace ? [...backBoxes, chosenFace.box] : backBoxes,
    });
  }

  // 4. 常规面牌按牌码聚合（江都麻将同组必为同牌）
  const byCode = {};
  for (const f of faces) {
    (byCode[f.tile] = byCode[f.tile] || []).push(f);
  }

  for (const [code, flist] of Object.entries(byCode)) {
    // 纵向散开程度判断是不是品字暗刻
    const ys = flist.map(cy);
    const spread = flist.length > 1 ? (Math.max(...ys) - Math.min(...ys)) : 0;
    const medH = flist.reduce((s, t) => s + (t.box[3] - t.box[1]), 0) / flist.length;

    let kind;
    if (flist.length >= 4) {
      kind = 'MING_GANG';
    } else if (flist.length === 3) {
      kind = spread > medH * 0.40 ? 'AN_KE' : 'MING_KE';
    } else {
      kind = 'PAIR';
    }

    groups.push({
      kind,
      tile: code,
      count: flist.length,
      jokers: 0,
      conf: Math.max(...flist.map((t) => t.conf)),
      boxes: flist.map((t) => t.box),
    });
  }

  // 5. 将百搭牌附着到对子或未满3张的刻子组上
  for (const j of jokers) {
    const cand = groups.find((g) => (g.kind === 'PAIR' || g.kind === 'MING_KE') && g.count < 3);
    if (cand) {
      cand.jokers += 1;
      cand.count += 1;
      if (cand.count === 3) cand.kind = 'AN_KE';
      cand.boxes.push(j.box);
    } else {
      groups.push({
        kind: 'PAIR',
        tile: null,
        count: 1,
        jokers: 1,
        conf: j.conf,
        boxes: [j.box],
      });
    }
  }

  // 整体按几何坐标从上到下、从左到右排序
  groups.sort((a, b) => {
    const aY = a.boxes[0] ? a.boxes[0][1] : 0;
    const bY = b.boxes[0] ? b.boxes[0][1] : 0;
    const aX = a.boxes[0] ? a.boxes[0][0] : 0;
    const bX = b.boxes[0] ? b.boxes[0][0] : 0;
    return (aY - bY) || (aX - bX);
  });

  groups.flowers = flowers;
  groups.groups = groups;
  return groups;
}
