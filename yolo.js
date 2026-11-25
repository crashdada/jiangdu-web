// 40 类江都麻将 YOLO 模型（ONNX）浏览器端推理
// 模型：640×640 输入，40 类（万/筒/条 + 东南西北中发白 + 春夏秋冬 + 百搭 + 背）
// 支持自适应双排切片高清推理（Dual-Band ROI Slicing），彻底解决长条手牌压缩失真漏检

import * as ort from './ort/ort.wasm.min.mjs';
import { YOLO_CLASS_CODES } from './tiles.js';

const MODEL_URL = 'models/tile-yolo.onnx';
let INPUT = 640;
const CONF = 0.25;
const IOU = 0.40;

/** 兼容导出：直接返回合法统一牌码 */
export function toTileCode(code) {
  return YOLO_CLASS_CODES.includes(code) ? code : null;
}

let sessionPromise = null;

async function getSession() {
  if (!sessionPromise) {
    const base = document.baseURI || window.location.href;
    ort.env.wasm.wasmPaths = {
      mjs: new URL('./ort/ort-wasm-simd-threaded.mjs', base).href,
      wasm: new URL('./ort/ort-wasm-simd-threaded.wasm', base).href,
    };
    ort.env.wasm.numThreads = 1;   // 单线程：不要求跨域隔离(COOP/COEP)
    ort.env.wasm.simd = true;
    sessionPromise = ort.InferenceSession.create(new URL(MODEL_URL, base).href, {
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

function ios(a, b) {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const smaller = Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
  return smaller > 0 ? inter / smaller : 0;
}

/** YOLOv8 输出 [1, 4+nc, N] → 检测框 */
function decode(output, lb, offsetX = 0, offsetY = 0) {
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
      rankConf: best,
      x0: (cx - w / 2 - lb.dx) / lb.scale + offsetX,
      y0: (cy - h / 2 - lb.dy) / lb.scale + offsetY,
      x1: (cx + w / 2 - lb.dx) / lb.scale + offsetX,
      y1: (cy + h / 2 - lb.dy) / lb.scale + offsetY,
    });
  }
  return cand;
}

async function inferCanvas(session, canvas, offsetX = 0, offsetY = 0) {
  const lb = letterbox(canvas);
  const input = toTensor(lb.canvas);
  const feeds = {};
  feeds[session.inputNames[0]] = input;
  const out = await session.run(feeds);
  const tensor = out[session.outputNames[0]];
  return decode(tensor, lb, offsetX, offsetY);
}

/**
 * 基于牌面物理颜色特征精校易混牌：
 * 1. 六条(全绿) vs 九条(中列红条)：九条中间列含红条，六条无红条；
 * 2. 绿色牌背 vs 白色牌面：整块高占比纯绿像素的框物理上必为牌背（防止高分辨率切片把纯绿牌背误判为百搭）。
 * 仅对极少数候选框读取小图块，耗时 <0.3ms。
 */
function refineByColorFeatures(canvas, dets) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width;
  const H = canvas.height;
  for (const d of dets) {
    const needBamboo = d.tile === '6t' || d.tile === '9t';
    const needBackCheck = d.tile === 'JOKER';
    if (!needBamboo && !needBackCheck) continue;

    const x0 = Math.max(0, Math.round(d.box[0]));
    const y0 = Math.max(0, Math.round(d.box[1]));
    const x1 = Math.min(W, Math.round(d.box[2]));
    const y1 = Math.min(H, Math.round(d.box[3]));
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw < 20 || bh < 20) continue;

    // 内缩 12% 避开倒角阴影
    const inX0 = x0 + Math.round(bw * 0.12);
    const inY0 = y0 + Math.round(bh * 0.12);
    const inW = Math.max(1, Math.round(bw * 0.76));
    const inH = Math.max(1, Math.round(bh * 0.76));

    if (needBackCheck) {
      const { data } = ctx.getImageData(inX0, inY0, inW, inH);
      const total = inW * inH;
      let greenCnt = 0;
      for (let i = 0; i < total; i++) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        if (g > 60 && (g - r) > 15 && (g - b) > 15) greenCnt++;
      }
      if (greenCnt / total > 0.55) {
        d.tile = 'BACK';
        d.raw = 'BACK';
      }
      continue;
    }

    // 六条 vs 九条：取中心主列（若横放则取中心主行）
    let rx0, ry0, rw, rh;
    if (bw > bh * 1.15) {
      rx0 = inX0;
      ry0 = inY0 + Math.round(inH * 0.32);
      rw = inW;
      rh = Math.max(1, Math.round(inH * 0.36));
    } else {
      rx0 = inX0 + Math.round(inW * 0.32);
      ry0 = inY0;
      rw = Math.max(1, Math.round(inW * 0.36));
      rh = inH;
    }

    const { data } = ctx.getImageData(rx0, ry0, rw, rh);
    const total = rw * rh;
    let redCnt = 0;
    for (let i = 0; i < total; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      if (r > 70 && (r - g) > 25 && (r - b) > 25) redCnt++;
    }
    const midRedRatio = redCnt / total;
    if (d.tile === '6t' && midRedRatio > 0.10) {
      d.tile = '9t';
      d.raw = '9t';
    } else if (d.tile === '9t' && midRedRatio < 0.03) {
      d.tile = '6t';
      d.raw = '6t';
    }
  }
}

/**
 * 对一张 canvas 做检测。
 * 自适应横向高清切片推理（Horizontal Overlapping ROI Slicing）：
 * 宽幅横排手牌按 X 轴切分为左右重叠切片（0~58%W, 42%~100%W），
 * 使单张牌输入网络的线性分辨率提升 1.72×（像素面积约 3×），
 * 并结合全局视野兜底与物理颜色精校，显著提高检出率与易混牌准确率。
 */
export async function detect(canvas) {
  const session = await getSession();
  const W = canvas.width;
  const H = canvas.height;

  let allCandidates = [];

  // 1. 全局视野推理（兜底跨接缝牌）
  const globalCands = await inferCanvas(session, canvas, 0, 0);
  allCandidates.push(...globalCands);

  // 2. 自适应横向重叠高清切片推理（仅宽图启用）
  if (W >= H && H >= 240) {
    const seamMargin = Math.max(10, Math.round(W * 0.008));

    // 左半高清切片 (0 ~ 0.58*W)
    const leftW = Math.round(0.58 * W);
    const cLeft = document.createElement('canvas');
    cLeft.width = leftW;
    cLeft.height = H;
    cLeft.getContext('2d').drawImage(canvas, 0, 0, leftW, H, 0, 0, leftW, H);
    const leftCands = await inferCanvas(session, cLeft, 0, 0);
    for (const c of leftCands) {
      if (c.x1 >= leftW - seamMargin) continue; // 剔除切缝截断半牌
      allCandidates.push(c);
    }

    // 右半高清切片 (0.42*W ~ W)
    const rightX = Math.round(0.42 * W);
    const rightW = W - rightX;
    const cRight = document.createElement('canvas');
    cRight.width = rightW;
    cRight.height = H;
    cRight.getContext('2d').drawImage(canvas, rightX, 0, rightW, H, 0, 0, rightW, H);
    const rightCands = await inferCanvas(session, cRight, rightX, 0);
    for (const c of rightCands) {
      if (c.x0 <= rightX + seamMargin) continue; // 剔除切缝截断半牌
      allCandidates.push(c);
    }
  }

  // 3. 尺度自适应 NMS 去重与物理尺寸过滤
  const scaleRef = Math.min(2.0, Math.max(0.4, W / 1600));
  const minW = 65 * scaleRef;
  const minH = 85 * scaleRef;
  const maxDim = 340 * scaleRef;
  const proxX = 45 * scaleRef;
  const proxY = 55 * scaleRef;

  allCandidates.sort((a, b) => b.rankConf - a.rankConf);
  const keep = [];
  for (const c of allCandidates) {
    const w = c.x1 - c.x0;
    const h = c.y1 - c.y0;
    // 物理尺寸与长宽比过滤：剔除边缘小碎片、细条及巨大阴影
    if (w < minW || h < minH || w > maxDim || h > maxDim) continue;
    const aspect = w / h;
    if (aspect < 0.40 || aspect > 2.3) continue;

    // 剔除最右边缘的怪异牌背（桌布边缘反光）
    const tileCode = YOLO_CLASS_CODES[c.cls];
    if (c.x1 > W - 20 * scaleRef && tileCode === 'BACK' && w > 180 * scaleRef) continue;

    const cx = (c.x0 + c.x1) / 2;
    const cy = (c.y0 + c.y1) / 2;

    let suppress = false;
    for (const k of keep) {
      if (iou(k, c) > 0.38 || ios(k, c) > 0.58) {
        suppress = true;
        break;
      }
      const kcx = (k.x0 + k.x1) / 2;
      const kcy = (k.y0 + k.y1) / 2;
      if (Math.abs(cx - kcx) < proxX && Math.abs(cy - kcy) < proxY) {
        suppress = true;
        break;
      }
    }
    if (!suppress) {
      keep.push(c);
    }
  }

  const dets = keep
    .map((c) => {
      const code = YOLO_CLASS_CODES[c.cls] || null;
      return {
        raw: code,
        tile: code,
        conf: Math.round(c.conf * 1000) / 1000,
        box: [Math.round(c.x0), Math.round(c.y0), Math.round(c.x1), Math.round(c.y1)],
      };
    })
    .filter((d) => d.tile && d.conf >= CONF);

  // 4. 物理颜色特征精校（六条/九条、纯绿牌背）
  refineByColorFeatures(canvas, dets);

  dets.sort((a, b) => (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
  return dets;
}
