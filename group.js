// 按检测框把牌聚成「组」，并按江都麻将规则判定组型
// 江都麻将无顺子，所有组由同种牌（或同种牌+百搭、或1面+3背）构成：
// - 3 张一行 = 碰 (MING_KE)
// - 3 张品字 / 紧凑 = 暗刻 (AN_KE)
// - 4 张一行 = 明杠 (MING_GANG)
// - 1 面 + 3 背 = 暗杠 (AN_GANG)
// - 2 张 = 对子 (PAIR)
// - 单张花牌 = 花 (FLOWER)

import { FLOWER_CODES } from './tiles.js';

function boxCenter(b) {
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}

function median(arr, fallback) {
  if (!arr.length) return fallback;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 估算竖立单牌的中位宽高，用于尺度自适应几何聚类 */
function estimateTileSize(dets) {
  const ws = [];
  const hs = [];
  for (const d of dets) {
    const w = d.box[2] - d.box[0];
    const h = d.box[3] - d.box[1];
    if (h > w * 1.05) {
      ws.push(w);
      hs.push(h);
    }
  }
  return {
    tileW: median(ws, 135),
    tileH: median(hs, 195),
  };
}

/** 置信度加权多数投票选出组内主牌（竖立牌权重略高于横放牌） */
function voteMajorTile(flist) {
  const scores = {};
  for (const f of flist) {
    if (f.tile === 'JOKER' || f.tile === 'BACK') continue;
    const w = f.box[2] - f.box[0];
    const h = f.box[3] - f.box[1];
    const uprightBonus = h >= w ? 1.3 : 1.0;
    scores[f.tile] = (scores[f.tile] || 0) + f.conf * uprightBonus;
  }
  let bestTile = flist[0].tile;
  let bestScore = -1;
  for (const [t, sc] of Object.entries(scores)) {
    if (sc > bestScore) {
      bestScore = sc;
      bestTile = t;
    }
  }
  return bestTile;
}

function buildTopMeld(flist) {
  const majorTile = voteMajorTile(flist);
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

/**
 * 上排副露（碰/明杠）智能切分：
 * 1. 先按物理横向间隔（> 1.35 * tileW）切分为连续牌段；
 * 2. 段内按同牌面连续长度切分：连续 3 张直接成碰、连续 4 张直接成明杠，
 *    避免紧凑无间隙摆放时跨组强行凑 4 张假明杠；
 * 3. 相邻的残缺短段（长度 1~2，通常由单张误检导致）合并为 3 张碰并通过加权投票纠偏。
 */
function segmentTopRow(topFaces, tileW) {
  const sorted = topFaces.slice().sort((a, b) => boxCenter(a.box)[0] - boxCenter(b.box)[0]);

  // 1. 按物理间距切分为连续段
  const chunks = [];
  let curChunk = [];
  for (const f of sorted) {
    if (!curChunk.length) {
      curChunk.push(f);
    } else {
      const prev = curChunk[curChunk.length - 1];
      const dx = boxCenter(f.box)[0] - boxCenter(prev.box)[0];
      if (dx <= 1.35 * tileW) {
        curChunk.push(f);
      } else {
        chunks.push(curChunk);
        curChunk = [f];
      }
    }
  }
  if (curChunk.length) chunks.push(curChunk);

  const result = [];

  for (const chunk of chunks) {
    // 2. 段内按同牌面切为 runs
    const runs = [];
    for (const f of chunk) {
      const last = runs[runs.length - 1];
      if (last && last[0].tile === f.tile) {
        last.push(f);
      } else {
        runs.push([f]);
      }
    }

    // 3. 完整 3/4 张同牌直接成组，相邻残缺短段（1~2 张）合并纠偏
    let pending = [];
    const flushPending = () => {
      while (pending.length >= 3) {
        const take = pending.length === 4 ? 4 : 3;
        result.push(buildTopMeld(pending.slice(0, take)));
        pending = pending.slice(take);
      }
      if (pending.length >= 2) {
        // 上排物理独立 2 张（通常是 3 张碰漏检 1 张）
        result.push(buildTopMeld(pending));
      } else if (pending.length === 1 && pending[0].conf >= 0.50) {
        result.push(buildTopMeld(pending));
      }
      pending = [];
    };

    for (const run of runs) {
      if (run.length === 3 || run.length === 4) {
        flushPending();
        result.push(buildTopMeld(run));
      } else if (run.length > 4) {
        flushPending();
        for (let i = 0; i < run.length; i += 3) {
          result.push(buildTopMeld(run.slice(i, i + 3)));
        }
      } else {
        pending.push(...run);
        if (pending.length >= 3) {
          result.push(buildTopMeld(pending.slice(0, 3)));
          pending = pending.slice(3);
        }
      }
    }
    flushPending();
  }

  return result;
}

/**
 * 下排手牌（暗刻品字 / 对子）2D 空间连通聚类：
 * 依据物理边界间距将紧邻的牌（含品字下方横放牌与百搭）归为同一物理簇，
 * 彻底解决横放牌误识别或百搭归属错乱导致的暗刻退化问题。
 */
function clusterBottomRow(botFaces, tileW, tileH) {
  const n = botFaces.length;
  const visited = new Array(n).fill(false);
  const gapXThr = 0.35 * tileW;
  const gapYThr = 0.35 * tileH;

  const isNear = (a, b) => {
    const gapX = Math.max(0, Math.max(a.box[0], b.box[0]) - Math.min(a.box[2], b.box[2]));
    const gapY = Math.max(0, Math.max(a.box[1], b.box[1]) - Math.min(a.box[3], b.box[3]));
    return gapX <= gapXThr && gapY <= gapYThr;
  };

  const groups = [];
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    const comp = [];
    const queue = [i];
    visited[i] = true;
    while (queue.length) {
      const u = queue.shift();
      comp.push(botFaces[u]);
      for (let v = 0; v < n; v++) {
        if (!visited[v] && isNear(botFaces[u], botFaces[v])) {
          visited[v] = true;
          queue.push(v);
        }
      }
    }

    const nonJokers = comp.filter((f) => f.tile !== 'JOKER');
    // 高置信度百搭计为真百搭；低置信度（多为横放花牌/条牌误判）按同组实体牌合并
    const realJokers = comp.filter((f) => f.tile === 'JOKER' && f.conf >= 0.75);
    const majorTile = nonJokers.length ? voteMajorTile(nonJokers) : 'JOKER';
    const maxConf = Math.max(...comp.map((f) => f.conf));
    const boxes = comp.map((f) => f.box);

    if (comp.length >= 3) {
      groups.push({
        kind: 'AN_KE',
        tile: majorTile,
        count: Math.min(3, comp.length),
        jokers: Math.min(2, realJokers.length),
        conf: maxConf,
        boxes,
      });
    } else if (comp.length === 2) {
      groups.push({
        kind: 'PAIR',
        tile: majorTile,
        count: 2,
        jokers: Math.min(1, realJokers.length),
        conf: maxConf,
        boxes,
      });
    } else {
      groups.push({
        kind: 'SINGLE',
        tile: majorTile,
        count: 1,
        jokers: 0,
        conf: maxConf,
        boxes,
      });
    }
  }

  return groups;
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
      if (!flowers.includes(d.tile)) flowers.push(d.tile);
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

  const { tileW, tileH } = estimateTileSize(normal);
  const groups = [];

  // 2. 识别真正的暗杠（三背一面）
  // 必须满足：至少有 3 个紧密相邻的牌背（支持一手多个暗杠）
  const backs = normal.filter((d) => d.tile === 'BACK');
  const faces = normal.filter((d) => d.tile !== 'BACK');

  const usedBacks = new Set();
  const usedFaces = new Set();

  if (backs.length >= 3) {
    backs.sort((a, b) => boxCenter(a.box)[0] - boxCenter(b.box)[0]);
    for (let i = 0; i <= backs.length - 3; i++) {
      if (usedBacks.has(i) || usedBacks.has(i + 1) || usedBacks.has(i + 2)) continue;
      const b1 = backs[i];
      const b2 = backs[i + 1];
      const b3 = backs[i + 2];
      const [c1x, c1y] = boxCenter(b1.box);
      const [c2x, c2y] = boxCenter(b2.box);
      const [c3x, c3y] = boxCenter(b3.box);

      if (
        Math.abs(c2x - c1x) < 1.35 * tileW &&
        Math.abs(c3x - c2x) < 1.35 * tileW &&
        Math.abs(c2y - c1y) < 0.35 * tileH &&
        Math.abs(c3y - c2y) < 0.35 * tileH
      ) {
        const faceCounts = {};
        for (const f of faces) faceCounts[f.tile] = (faceCounts[f.tile] || 0) + 1;

        const candFaces = [];
        for (let fIdx = 0; fIdx < faces.length; fIdx++) {
          if (usedFaces.has(fIdx)) continue;
          const [fcx, fcy] = boxCenter(faces[fIdx].box);
          const minD = Math.min(Math.abs(c1x - fcx), Math.abs(fcx - c3x));
          if (minD < 1.45 * tileW && Math.abs(c1y - fcy) < 0.40 * tileH) {
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
      }
    }
  }

  // 3. 剩余面牌按最大垂直间隙自适应分为上排副露 vs 下排手牌
  const remFaces = faces.filter((_, idx) => !usedFaces.has(idx));
  let topFaces = [];
  let botFaces = [];
  let splitY = 0;

  if (remFaces.length) {
    const sortedYs = remFaces.map((f) => boxCenter(f.box)[1]).sort((a, b) => a - b);
    let maxGap = 0;
    let gapMid = sortedYs[0];
    for (let i = 1; i < sortedYs.length; i++) {
      const g = sortedYs[i] - sortedYs[i - 1];
      if (g > maxGap) {
        maxGap = g;
        gapMid = (sortedYs[i] + sortedYs[i - 1]) / 2;
      }
    }

    if (maxGap > 0.55 * tileH) {
      splitY = gapMid;
      for (const f of remFaces) {
        if (boxCenter(f.box)[1] < splitY) topFaces.push(f);
        else botFaces.push(f);
      }
    } else {
      // 单排情况：按品字/空间聚类处理
      splitY = sortedYs[0] - 1;
      botFaces = remFaces.slice();
    }
  }

  // 4. 上排副露切分 + 下排 2D 空间聚类
  if (topFaces.length) {
    groups.push(...segmentTopRow(topFaces, tileW));
  }
  if (botFaces.length) {
    groups.push(...clusterBottomRow(botFaces, tileW, tileH));
  }

  // 5. 组数后处理与排序
  let validGroups = groups.filter((g) => g.kind !== 'SINGLE');
  const singles = groups.filter((g) => g.kind === 'SINGLE');

  // 孤立百搭归入下排对子
  const orphanJokers = singles.filter((s) => s.tile === 'JOKER' && s.conf >= 0.75);
  for (const j of orphanJokers) {
    const target = validGroups.find((g) => g.kind === 'PAIR' && g.tile !== 'JOKER');
    if (target) {
      target.jokers += 1;
      target.count += 1;
      target.kind = 'AN_KE';
      target.boxes.push(...j.boxes);
    }
  }

  // 若组数不足 6 组且存在高置信度非百搭孤牌，作为待修正对子补入
  const remSingles = singles.filter((s) => s.tile !== 'JOKER');
  if (validGroups.length < 6) {
    remSingles.sort((a, b) => b.conf - a.conf);
    for (const s of remSingles) {
      if (validGroups.length < 6 && s.conf > 0.70) {
        s.kind = 'PAIR';
        validGroups.push(s);
      }
    }
  }

  // 排序：先上排副露，再下排手牌；同排从左到右
  validGroups.sort((a, b) => {
    const aCy = boxCenter(a.boxes[0])[1];
    const bCy = boxCenter(b.boxes[0])[1];
    const aIsBot = splitY > 0 && aCy >= splitY ? 1 : 0;
    const bIsBot = splitY > 0 && bCy >= splitY ? 1 : 0;
    if (aIsBot !== bIsBot) return aIsBot - bIsBot;
    return a.boxes[0][0] - b.boxes[0][0];
  });

  validGroups.groups = validGroups;
  validGroups.flowers = flowers;
  return validGroups;
}
