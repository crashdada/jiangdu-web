// 按检测框把牌聚成「组」，并按江都麻将规则判定组型
// 江都麻将无顺子，所有组由同种牌（或同种牌+百搭、或1面+3背）构成：
// - 3 张一行 = 碰 (MING_KE)
// - 3 张品字 / 紧凑 = 暗刻 (AN_KE)
// - 4 张一行 = 明杠 (MING_GANG)
// - 1 面 + 3 背 = 暗杠 (AN_GANG)
// - 2 张 = 对子 (PAIR)
// - 单张花牌 = 花 (FLOWER)

const FLOWER_CODES = ['chun', 'xia', 'qiu', 'dong'];

function boxCenter(b) {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

function buildTopGroup(flist) {
  const counts = {};
  for (const f of flist) {
    if (f.tile !== 'JOKER') {
      counts[f.tile] = (counts[f.tile] || 0) + 1;
    }
  }
  let majorTile = flist[0].tile;
  let maxCount = -1;
  for (const [t, cnt] of Object.entries(counts)) {
    if (cnt > maxCount) {
      maxCount = cnt;
      majorTile = t;
    }
  }
  const kind = flist.length >= 4 ? 'MING_GANG' : 'MING_KE';
  return {
    kind,
    tile: majorTile,
    count: flist.length,
    jokers: 0,
    conf: Math.max(...flist.map((f) => f.conf)),
    boxes: flist.map((f) => f.box),
  };
}

export function groupDetections(dets) {
  if (!dets || !dets.length) {
    const empty = [];
    empty.groups = [];
    empty.flowers = [];
    return empty;
  }

  // 1. 分离花牌与常规牌
  const flowers = [];
  const normal = [];
  for (const d of dets) {
    if (FLOWER_CODES.includes(d.tile)) {
      flowers.push(d.tile);
    } else {
      normal.push(d);
    }
  }

  if (!normal.length) {
    const res = [];
    res.groups = [];
    res.flowers = flowers;
    return res;
  }

  const groups = [];

  // 2. 识别真正的暗杠（三背一面）
  // 必须满足：至少有 3 个紧密相邻的牌背（dx < 170, dy < 60）
  const backs = normal.filter((d) => d.tile === 'BACK');
  const faces = normal.filter((d) => d.tile !== 'BACK');

  const usedBacks = new Set();
  const usedFaces = new Set();

  if (backs.length >= 3) {
    backs.sort((a, b) => boxCenter(a.box)[0] - boxCenter(b.box)[0]);
    for (let i = 0; i <= backs.length - 3; i++) {
      const b1 = backs[i];
      const b2 = backs[i + 1];
      const b3 = backs[i + 2];
      const [c1x, c1y] = boxCenter(b1.box);
      const [c2x, c2y] = boxCenter(b2.box);
      const [c3x, c3y] = boxCenter(b3.box);

      if (
        Math.abs(c2x - c1x) < 170 &&
        Math.abs(c3x - c2x) < 170 &&
        Math.abs(c2y - c1y) < 60 &&
        Math.abs(c3y - c2y) < 60
      ) {
        // 统计各面牌出现频次，优先挑选单张孤牌（避免拆散已有3张的碰牌组）
        const faceCounts = {};
        for (const f of faces) faceCounts[f.tile] = (faceCounts[f.tile] || 0) + 1;

        const candFaces = [];
        for (let fIdx = 0; fIdx < faces.length; fIdx++) {
          if (usedFaces.has(fIdx)) continue;
          const [fcx, fcy] = boxCenter(faces[fIdx].box);
          const minD = Math.min(Math.abs(c1x - fcx), Math.abs(fcx - c3x));
          if (minD < 180 && Math.abs(c1y - fcy) < 70) {
            candFaces.push({
              minD,
              freq: faceCounts[faces[fIdx].tile] || 1,
              idx: fIdx,
              face: faces[fIdx],
            });
          }
        }

        candFaces.sort((a, b) => {
          if ((a.freq >= 3) !== (b.freq >= 3)) return a.freq >= 3 ? 1 : -1;
          return a.minD - b.minD;
        });

        let chosenFace = null;
        if (candFaces.length > 0) {
          chosenFace = candFaces[0].face;
          usedFaces.add(candFaces[0].idx);
        }

        usedBacks.add(i);
        usedBacks.add(i + 1);
        usedBacks.add(i + 2);

        groups.push({
          kind: 'AN_GANG',
          tile: chosenFace ? chosenFace.tile : null,
          count: 4,
          jokers: 0,
          conf: Math.max(b1.conf, b2.conf, b3.conf, chosenFace ? chosenFace.conf : 0.5),
          boxes: [b1.box, b2.box, b3.box, ...(chosenFace ? [chosenFace.box] : [])],
        });
        break;
      }
    }
  }

  // 剩余面牌按空间分层（上排副露碰/杠 vs 下排手牌暗刻/对子）
  const remFaces = faces.filter((_, idx) => !usedFaces.has(idx));

  let topFaces = [];
  let botFaces = [];

  if (remFaces.length) {
    const allYs = remFaces.map((f) => boxCenter(f.box)[1]);
    const minY = Math.min(...allYs);
    const maxY = Math.max(...allYs);
    // 拍摄高宽通常为 1600x900，若两排Y跨度大于 140 说明存在明确双排
    const splitY = (maxY - minY > 140) ? (minY + maxY) / 2 : 360;

    for (const f of remFaces) {
      if (boxCenter(f.box)[1] < splitY) {
        topFaces.push(f);
      } else {
        botFaces.push(f);
      }
    }
  }

  // 3. 上排副露空间聚类 (横向间隔判定)
  if (topFaces.length) {
    topFaces.sort((a, b) => a.box[0] - b.box[0]);
    let curGroup = [];
    for (const f of topFaces) {
      if (!curGroup.length) {
        curGroup.push(f);
      } else {
        const prev = curGroup[curGroup.length - 1];
        const dx = f.box[0] - prev.box[0];
        // 组内牌紧邻间距通常 < 170，最多容纳 4 张
        if (dx < 170 && curGroup.length < 4) {
          curGroup.push(f);
        } else {
          groups.push(buildTopGroup(curGroup));
          curGroup = [f];
        }
      }
    }
    if (curGroup.length) {
      groups.push(buildTopGroup(curGroup));
    }
  }

  // 4. 下排手牌聚类 (暗刻与对子)
  if (botFaces.length) {
    const byTile = {};
    for (const f of botFaces) {
      (byTile[f.tile] = byTile[f.tile] || []).push(f);
    }

    for (const [tile, flist] of Object.entries(byTile)) {
      if (flist.length >= 3) {
        groups.push({
          kind: 'AN_KE',
          tile,
          count: Math.min(3, flist.length),
          jokers: 0,
          conf: Math.max(...flist.map((f) => f.conf)),
          boxes: flist.map((f) => f.box),
        });
      } else if (flist.length === 2) {
        groups.push({
          kind: 'PAIR',
          tile,
          count: 2,
          jokers: 0,
          conf: Math.max(...flist.map((f) => f.conf)),
          boxes: flist.map((f) => f.box),
        });
      } else {
        // 单张孤立牌标记为 SINGLE，绝不直接升级为 PAIR
        groups.push({
          kind: 'SINGLE',
          tile,
          count: 1,
          jokers: 0,
          conf: flist[0].conf,
          boxes: [flist[0].box],
        });
      }
    }
  }

  // 5. 组数严格控制与后处理
  let validGroups = groups.filter((g) => g.kind !== 'SINGLE');
  const singles = groups.filter((g) => g.kind === 'SINGLE');

  // 将百搭归入需要的组中
  const jokers = validGroups.filter((g) => g.tile === 'JOKER');
  if (jokers.length) {
    for (const j of jokers) {
      const target = validGroups.find((g) => g.kind === 'PAIR' && g.tile !== 'JOKER');
      if (target) {
        target.jokers += 1;
        target.count += 1;
        target.kind = 'AN_KE';
        target.boxes.push(...j.boxes);
        validGroups = validGroups.filter((g) => g !== j);
      }
    }
  }

  // 若成胡组数尚不足 6 组，且存在置信度极高（>0.70）的孤牌，才作为待修正对子补入
  if (validGroups.length < 6) {
    singles.sort((a, b) => b.conf - a.conf);
    for (const s of singles) {
      if (validGroups.length < 6 && s.conf > 0.70) {
        s.kind = 'PAIR';
        validGroups.push(s);
      }
    }
  }

  // 排序：先上排副露，再下排手牌；从左到右
  validGroups.sort((a, b) => {
    const aCy = (a.boxes[0][1] + a.boxes[0][3]) / 2;
    const bCy = (b.boxes[0][1] + b.boxes[0][3]) / 2;
    const aIsBot = aCy > 350 ? 1 : 0;
    const bIsBot = bCy > 350 ? 1 : 0;
    if (aIsBot !== bIsBot) return aIsBot - bIsBot;
    return a.boxes[0][0] - b.boxes[0][0];
  });

  validGroups.groups = validGroups;
  validGroups.flowers = flowers;
  return validGroups;
}
