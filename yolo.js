// Mahjong-YOLO (nano) 的浏览器端推理
// 模型：640×640 输入，37 类：1m..9m(万) 1p..9p(筒) 1s..9s(条) 1z..7z(东南西北中发白) 0m/0p/0s(红五)

import * as ort from './ort/ort.wasm.min.mjs';

const MODEL_URL = 'models/tile-yolo.onnx';
const INPUT = 640;
const CONF = 0.35;
const IOU = 0.45;

const NAMES = [
  '1m', '1p', '1s', '1z', '2m', '2p', '2s', '2z', '3m', '3p', '3s', '3z',
  '4m', '4p', '4s', '4z', '5m', '5p', '5s', '5z', '6m', '6p', '6s', '6z',
  '7m', '7p', '7s', '7z', '8m', '8p', '8s', '9m', '9p', '9s', '0m', '0p', '0s',
];

const HONOR = ['E', 'S', 'W', 'N', 'Z', 'F', 'B'];
const SUIT = { m: 'w', p: 'b', s: 't' };

/** 把 YOLO 的类别名转成我们引擎的牌码 */
export function toTileCode(raw) {
  if (!raw || raw.length !== 2) return null;
  const n = Number(raw[0]);
  const s = raw[1];
  if (SUIT[s]) return `${n === 0 ? 5 : n}${SUIT[s]}`;
  if (s === 'z' && n >= 1 && n <= 7) return HONOR[n - 1];
  return null;
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

/** 把 canvas 缩到 640×640，灰色补边（YOLO 的 letterbox） */
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
function decode(output, lb) {
  const dims = output.dims;            // [1, 41, 8400]
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
      y0: (cy - h / 2 - lb.dy) / lb.scale,
      x1: (cx + w / 2 - lb.dx) / lb.scale,
      y1: (cy + h / 2 - lb.dy) / lb.scale,
    });
  }

  // 类无关 NMS：同一块牌只留一个类，避免一个位置冒出三种牌名
  cand.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const c of cand) {
    if (keep.every((k) => iou(k, c) < IOU)) keep.push(c);
  }
  return keep;
}

/**
 * 对一张 canvas 做检测。
 * 返回 [{tile, raw, conf, box:[x0,y0,x1,y1]}]，按从上到下、从左到右排序。
 */
export async function detect(canvas) {
  const session = await getSession();
  const lb = letterbox(canvas);
  const input = toTensor(lb.canvas);
  const feeds = {};
  feeds[session.inputNames[0]] = input;
  const out = await session.run(feeds);
  const tensor = out[session.outputNames[0]];

  const dets = decode(tensor, lb)
    .map((c) => ({
      raw: NAMES[c.cls],
      tile: toTileCode(NAMES[c.cls]),
      conf: Math.round(c.conf * 1000) / 1000,
      box: [c.x0, c.y0, c.x1, c.y1],
    }))
    .filter((d) => d.tile && d.conf >= CONF);

  dets.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
  return dets;
}
