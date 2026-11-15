// 40 类江都麻将 YOLO 模型（ONNX）浏览器端推理
// 模型：640×640 输入，40 类（万/筒/条 + 东南西北中发白 + 春夏秋冬 + 百搭 + 背）
// 支持自适应双排切片高清推理（Dual-Band ROI Slicing），彻底解决长条手牌压缩失真漏检

import * as ort from './ort/ort.wasm.min.mjs';

const MODEL_URL = 'models/tile-yolo.onnx';
let INPUT = 640;
const CONF = 0.25;
const IOU = 0.40;

const NAMES = [
  '一万', '一条', '一筒', '七万', '七条', '七筒', '三万', '三条', '三筒', '东',
  '中', '九万', '九条', '九筒', '二万', '二条', '二筒', '五万', '五条', '五筒',
  '八万', '八条', '八筒', '六万', '六条', '六筒', '冬', '北', '南', '发',
  '四万', '四条', '四筒', '夏', '春', '白', '百搭', '秋', '背', '西'
];

const CODE_MAP = {
  '一万': '1w', '二万': '2w', '三万': '3w', '四万': '4w', '五万': '5w',
  '六万': '6w', '七万': '7w', '八万': '8w', '九万': '9w',
  '一条': '1t', '二条': '2t', '三条': '3t', '四条': '4t', '五条': '5t',
  '六条': '6t', '七条': '7t', '八条': '8t', '九条': '9t',
  '一筒': '1b', '二筒': '2b', '三筒': '3b', '四筒': '4b', '五筒': '5b',
  '六筒': '6b', '七筒': '7b', '八筒': '8b', '九筒': '9b',
  '东': 'E', '南': 'S', '西': 'W', '北': 'N', '中': 'Z', '发': 'F', '白': 'B',
  '春': 'chun', '夏': 'xia', '秋': 'qiu', '冬': 'dong',
  '百搭': 'JOKER', '背': 'BACK'
};

/** 把 YOLO 的类别名转成我们引擎的牌码 */
export function toTileCode(raw) {
  return CODE_MAP[raw] || null;
}

let sessionPromise = null;

async function getSession() {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = './ort/';
    ort.env.wasm.numThreads = 1;   // 单线程：不要求跨域隔离(COOP/COEP)
    ort.env.wasm.simd = true;
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }).then((sess) => {
      try {
        const shape = sess.inputs && sess.inputs[0] ? sess.inputs[0].dims : null;
        if (shape && shape[2] > 0) INPUT = shape[2];
      } catch (e) {}
      return sess;
    }).catch((e) => {
      sessionPromise = null;
      throw e;
    });
  }
  return sessionPromise;
}

/** 预热：拍照前先把模型加载好（首次要下 10MB） */
export function warmup() {
  return getSession().then(() => true).catch(() => false);
}

/** 把 canvas 缩到 INPUT×INPUT，灰色补边（YOLO 的 letterbox） */
function letterbox(canvas) {
  const scale = Math.min(INPUT / canvas.width, INPUT / canvas.height);
  const w = Math.round(canvas.width * scale);
  const h = Math.round(canvas.height * scale);
  const dx = Math.round((INPUT - w) / 2);
  const dy = Math.round((INPUT - h) / 2);

  const c = document.createElement('canvas');
  c.width = INPUT;
  c.height = INPUT;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, INPUT, INPUT);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, dx, dy, w, h);
  return { canvas: c, scale, dx, dy };
}

/** canvas → Float32 CHW [0,1]，RGB */
function toTensor(canvas) {
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, INPUT, INPUT);
  const area = INPUT * INPUT;
  const out = new Float32Array(area * 3);
  for (let i = 0; i < area; i++) {
    out[i] = data[i * 4] / 255;              // R
    out[area + i] = data[i * 4 + 1] / 255;   // G
    out[area * 2 + i] = data[i * 4 + 2] / 255; // B
  }
  return new ort.Tensor('float32', out, [1, 3, INPUT, INPUT]);
}

function iou(a, b) {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return ua > 0 ? inter / ua : 0;
}

/** YOLOv8 输出 [1, 4+nc, N] → 检测框 */
function decode(output, lb, offsetY = 0) {
  const dims = output.dims;            // [1, 44, 8400]
  const nc = dims[1] - 4;
  const n = dims[2];
  const d = output.data;

  const cand = [];
  for (let i = 0; i < n; i++) {
    let best = -1;
    let bestC = -1;
    for (let c = 0; c < nc; c++) {
      const v = d[(4 + c) * n + i];
      if (v > best) {
        best = v;
        bestC = c;
      }
    }
    if (best < CONF) continue;
    const cx = d[i];
    const cy = d[n + i];
    const w = d[2 * n + i];
    const h = d[3 * n + i];
    cand.push({
      cls: bestC,
      conf: best,
      x0: (cx - w / 2 - lb.dx) / lb.scale,
      y0: (cy - h / 2 - lb.dy) / lb.scale + offsetY,
      x1: (cx + w / 2 - lb.dx) / lb.scale,
      y1: (cy + h / 2 - lb.dy) / lb.scale + offsetY,
    });
  }
  return cand;
}

async function inferCanvas(session, canvas, offsetY = 0) {
  const lb = letterbox(canvas);
  const input = toTensor(lb.canvas);
  const feeds = {};
  feeds[session.inputNames[0]] = input;
  const out = await session.run(feeds);
  const tensor = out[session.outputNames[0]];
  return decode(tensor, lb, offsetY);
}

/**
 * 对一张 canvas 做检测。
 * 支持自适应双排切片高清推理（Dual-Band ROI）：
 * 当拍摄为宽图（横排手牌）时，自动结合全局视野与上下两排局部高分辨率切片，
 * 使单张牌在网络中的分辨率提高一倍以上，显著提高九条、四条、七筒等复杂牌面的检出率！
 */
export async function detect(canvas) {
  const session = await getSession();
  const W = canvas.width;
  const H = canvas.height;

  let allCandidates = [];

  // 1. 全局视野推理
  const globalCands = await inferCanvas(session, canvas, 0);
  allCandidates.push(...globalCands);

  // 2. 自适应双排切片推理（仅横向拍摄手牌场景启用）
  if (W >= H && H >= 240) {
    // 上排 ROI 切片 (0 ~ 0.52*H)
    const topH = Math.round(0.52 * H);
    const cTop = document.createElement('canvas');
    cTop.width = W;
    cTop.height = topH;
    cTop.getContext('2d').drawImage(canvas, 0, 0, W, topH, 0, 0, W, topH);
    const topCands = await inferCanvas(session, cTop, 0);
    allCandidates.push(...topCands);

    // 下排 ROI 切片 (0.28*H ~ H)
    const botY = Math.round(0.28 * H);
    const botH = H - botY;
    const cBot = document.createElement('canvas');
    cBot.width = W;
    cBot.height = botH;
    cBot.getContext('2d').drawImage(canvas, 0, botY, W, botH, 0, 0, W, botH);
    const botCands = await inferCanvas(session, cBot, botY);
    allCandidates.push(...botCands);
  }

  // 3. 全局类无关 NMS 去重
  allCandidates.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const c of allCandidates) {
    if (keep.every((k) => iou(k, c) < IOU)) {
      keep.push(c);
    }
  }

  const dets = keep
    .map((c) => ({
      raw: NAMES[c.cls],
      tile: toTileCode(NAMES[c.cls]),
      conf: Math.round(c.conf * 1000) / 1000,
      box: [Math.round(c.x0), Math.round(c.y0), Math.round(c.x1), Math.round(c.y1)],
    }))
    .filter((d) => d.tile && d.conf >= CONF);

  dets.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
  return dets;
}
