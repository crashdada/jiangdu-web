// 按检测框把牌聚成「组」，并按摆法判定组型
// 3 张一行 = 碰；3 张成三角 = 暗刻；4 张一行 = 明杠；2 张 = 对子；单张 = 花/待定

function cx(d) {
  return (d.box[0] + d.box[2]) / 2;
}

function cy(d) {
  return (d.box[1] + d.box[3]) / 2;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function groupDetections(dets) {
  if (!dets.length) return [];

  const medW = median(dets.map((d) => d.box[2] - d.box[0])) || 100;
  const medH = median(dets.map((d) => d.box[3] - d.box[1])) || 130;

  // 单链聚类：两块牌之间的间隙足够小就算同一组
  const n = dets.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = dets[i].box;
      const b = dets[j].box;
      const gapX = Math.max(0, Math.max(a[0], b[0]) - Math.min(a[2], b[2]));
      const gapY = Math.max(0, Math.max(a[1], b[1]) - Math.min(a[3], b[3]));
      if (gapX < medW * 0.28 && gapY < medH * 0.38) union(i, j);
    }
  }

  const clusters = {};
  for (let i = 0; i < n; i++) {
    const r = find(i);
    (clusters[r] = clusters[r] || []).push(i);
  }

  const groups = [];
  for (const idxs of Object.values(clusters)) {
    // 簇内按从上到下、从左到右
    idxs.sort((a, b) => (dets[a].box[1] - dets[b].box[1]) || (dets[a].box[0] - dets[b].box[0]));

    let k = 0;
    while (k < idxs.length) {
      const chunk = idxs.slice(k, k + 3);
      k += 3;
      const tiles = chunk.map((i) => dets[i]);

      // 张数决定组型
      let kind;
      if (tiles.length === 1) kind = 'FLOWER';
      else if (tiles.length === 2) kind = 'PAIR';
      else {
        // 三张：看纵向散开程度判断是不是品字
        const ys = tiles.map(cy);
        const spread = Math.max(...ys) - Math.min(...ys);
        kind = spread > medH * 0.45 ? 'AN_KE' : 'MING_KE';
      }

      // 同组取票数最高的牌名（三张理应相同，YOLO 偶尔会飘）
      const tally = {};
      tiles.forEach((t) => {
        tally[t.tile] = (tally[t.tile] || 0) + 1;
      });
      const best = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
      const conf = Math.max(...tiles.map((t) => t.conf));

      groups.push({
        kind,
        tile: best ? best[0] : null,
        count: Math.max(tiles.length, kind === 'PAIR' ? 2 : 3),
        jokers: 0,
        conf,
        boxes: tiles.map((t) => t.box),
      });
    }
  }

  groups.sort((a, b) => (a.boxes[0][1] - b.boxes[0][1]) || (a.boxes[0][0] - b.boxes[0][0]));
  return groups;
}
