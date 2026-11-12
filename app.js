'use strict';

import { huZi, fan, multiplier, groupHuZi, tileFacts } from './engine.js';
import { PROSE_PROMPT, NAMES_PROMPT, ROT_PROMPT } from './prompts.js';
import { parseProse, parseOrderedNames, mergeNames } from './parse.js';

/* ============ 展示用文字 ============ */

const HONORS = ['E', 'S', 'W', 'N', 'Z', 'F', 'B'];
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const HONOR_CN = ['东', '南', '西', '北', '中', '发', '白'];

function tileLabel(code) {
  const f = tileFacts(code);
  if (f.isHonor) return HONOR_CN[f.rank - 1];
  const suitCn = { w: '万', t: '条', b: '筒' }[f.suit];
  return CN[f.rank - 1] + suitCn;
}

function kindLabel(k) {
  return { PAIR: '对子', MING_KE: '碰', AN_KE: '暗刻', MING_GANG: '明杠', AN_GANG: '暗杠' }[k];
}

/* ============ 状态 ============ */

const FLOWERS = [
  { code: 'chun', label: '春' },
  { code: 'xia', label: '夏' },
  { code: 'qiu', label: '秋' },
  { code: 'dong', label: '冬' },
];

const SEATS = ['庄 东/春', '下家 南/夏', '对家 西/秋', '末家 北/冬'];
const WINDS = ['东', '南', '西', '北'];

const state = {
  groups: [],
  flowers: [],
  seat: null,
  roundWind: null,
  settings: loadSettings(),
  lastRot: null,
  busy: false,
};

function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(localStorage.getItem('jd_settings') || '{}'); } catch (e) { raw = {}; }
  return {
    base: raw.base || 'https://api.deepseek.com',
    model: raw.model || 'deepseek-flash',
    key: raw.key || '',
  };
}

function saveSettings() {
  localStorage.setItem('jd_settings', JSON.stringify(state.settings));
}

/* 门风与对应花是同一条位置关系：庄=东+春、下家=南+夏、对家=西+秋、末家=北+冬 */
function seatWind() { return state.seat == null ? null : HONORS[state.seat]; }
function ownFlower() { return state.seat == null ? null : FLOWERS[state.seat].code; }

function currentHand() {
  const sw = seatWind();
  const rw = state.roundWind == null ? null : HONORS[state.roundWind];
  // 还没选牌名的组不参与算分
  const groups = state.groups
    .filter((g) => g.tile)
    .map((g) => {
      const tags = [];
      if (sw && g.tile === sw) tags.push('MEN_FENG');
      if (rw && g.tile === rw) tags.push('QUAN_FENG');
      return { ...g, fan: tags };
    });
  return { groups, flowers: state.flowers.slice(), ownFlower: ownFlower() };
}

/* ============ 渲染 ============ */

const $ = (id) => document.getElementById(id);

function render() {
  const hand = currentHand();
  const hz = huZi(hand);
  const fn = fan(hand);
  const mul = multiplier(fn);

  $('score-num').textContent = hz * mul;
  $('score-sub').textContent = `胡子 ${hz} × 2^${fn} = ×${mul}`;

  // 加组
  const addChips = $('add-chips');
  addChips.innerHTML = '';
  ['PAIR', 'MING_KE', 'AN_KE', 'MING_GANG', 'AN_GANG'].forEach((k) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = kindLabel(k);
    b.onclick = () => openPicker(k);
    addChips.appendChild(b);
  });

  // 组列表
  $('groups-title').textContent = `已录 ${state.groups.length} 组`;
  const box = $('groups');
  box.innerHTML = '';
  if (!state.groups.length) {
    box.innerHTML = '<p class="empty">还没有组。可以拍照识别，也可以手动加。</p>';
  }
  state.groups.forEach((g, i) => box.appendChild(groupCard(g, i)));

  // 花牌
  const fl = $('flower-chips');
  fl.innerHTML = '';
  FLOWERS.forEach((f) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = f.label;
    b.setAttribute('aria-pressed', state.flowers.includes(f.code) ? 'true' : 'false');
    b.onclick = () => {
      const k = state.flowers.indexOf(f.code);
      if (k >= 0) state.flowers.splice(k, 1); else state.flowers.push(f.code);
      render();
    };
    fl.appendChild(b);
  });

  // 我是哪家
  const seatBox = $('seat-chips');
  seatBox.innerHTML = '';
  SEATS.forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.style.fontSize = '12px';
    b.setAttribute('aria-pressed', state.seat === i ? 'true' : 'false');
    b.onclick = () => { state.seat = state.seat === i ? null : i; render(); };
    seatBox.appendChild(b);
  });

  // 圈风
  const windBox = $('wind-chips');
  windBox.innerHTML = '';
  WINDS.forEach((label, i) => {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.setAttribute('aria-pressed', state.roundWind === i ? 'true' : 'false');
    b.onclick = () => { state.roundWind = state.roundWind === i ? null : i; render(); };
    windBox.appendChild(b);
  });

  $('ver').textContent = 'v0.5.5 web';
}

function groupCard(g, i) {
  const el = document.createElement('div');
  el.className = 'group';

  const row1 = document.createElement('div');
  row1.className = 'row1';
  const nameTxt = g.tile ? `${kindLabel(g.kind)} ${tileLabel(g.tile)}` : `${kindLabel(g.kind)} ？`;
  const huTxt = g.tile ? `${groupHuZi(g)} 胡` : '点此选牌';
  row1.innerHTML = `<span class="name">${nameTxt}</span><span class="hu">${huTxt}</span>`;
  row1.style.cursor = 'pointer';
  row1.onclick = () => openPicker(g.kind, i);
  el.appendChild(row1);

  const row2 = document.createElement('div');
  row2.className = 'row2';

  if (g.jokers > 0) {
    const t = document.createElement('span');
    t.className = 'txt';
    t.textContent = `含百搭 ${g.jokers} 张（按暗刻算）`;
    row2.appendChild(t);
    const minus = document.createElement('button');
    minus.className = 'small-btn';
    minus.textContent = '−';
    minus.onclick = () => {
      g.jokers -= 1;
      if (g.jokers <= 0) { g.jokers = 0; }
      render();
    };
    row2.appendChild(minus);
  }

  const plus = document.createElement('button');
  plus.className = 'small-btn';
  plus.textContent = g.jokers === 0 ? '＋ 加百搭' : '＋';
  plus.onclick = () => {
    g.jokers = Math.min(3, g.jokers + 1);
    // 百搭凑成 3 张就算暗刻；两张的对子（如「六筒+百搭」）仍是对子
    if (g.jokers > 0 && g.kind !== 'PAIR') g.kind = 'AN_KE';
    render();
  };
  row2.appendChild(plus);

  const sp = document.createElement('span');
  sp.className = 'spacer';
  row2.appendChild(sp);

  // 组型错了也能改：按顺序切换
  const kindBtn = document.createElement('button');
  kindBtn.className = 'small-btn';
  kindBtn.textContent = '改类型';
  kindBtn.onclick = () => {
    const order = ['MING_KE', 'AN_KE', 'MING_GANG', 'AN_GANG', 'PAIR'];
    const k = order.indexOf(g.kind);
    g.kind = order[(k + 1) % order.length];
    render();
  };
  row2.appendChild(kindBtn);

  const del = document.createElement('button');
  del.className = 'small-btn';
  del.textContent = '删除';
  del.onclick = () => { state.groups.splice(i, 1); render(); };
  row2.appendChild(del);

  el.appendChild(row2);

  const sw = seatWind();
  const rw = state.roundWind == null ? null : HONORS[state.roundWind];
  const tags = [];
  if (sw && g.tile === sw) tags.push('门风');
  if (rw && g.tile === rw) tags.push('圈风');
  if (tags.length) {
    const t = document.createElement('div');
    t.className = 'tag';
    t.textContent = '计番：' + tags.join(' + ');
    el.appendChild(t);
  }

  return el;
}

/* ============ 选牌 ============ */

let pickingKind = null;
let editingIndex = null;

function openPicker(kind, editIdx) {
  pickingKind = kind;
  editingIndex = typeof editIdx === 'number' ? editIdx : null;
  $('picker-title').textContent = (editingIndex === null ? '选牌 · ' : '改牌 · ') + kindLabel(kind);
  const body = $('picker-body');
  body.innerHTML = '';

  const rows = [
    { head: '万', suit: 'w' },
    { head: '条', suit: 't' },
    { head: '筒', suit: 'b' },
  ];
  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'tile-row';
    const h = document.createElement('span');
    h.className = 'head';
    h.textContent = r.head;
    row.appendChild(h);
    for (let i = 1; i <= 9; i++) {
      const b = document.createElement('button');
      b.className = 'tile';
      b.textContent = CN[i - 1];
      b.onclick = () => pickTile(`${i}${r.suit}`);
      row.appendChild(b);
    }
    body.appendChild(row);
  });

  const row = document.createElement('div');
  row.className = 'tile-row';
  const h = document.createElement('span');
  h.className = 'head';
  h.textContent = '字';
  row.appendChild(h);
  HONORS.forEach((code) => {
    const b = document.createElement('button');
    b.className = 'tile';
    b.textContent = tileLabel(code);
    b.onclick = () => pickTile(code);
    row.appendChild(b);
  });
  body.appendChild(row);

  $('picker').hidden = false;
}

function pickTile(tile) {
  if (editingIndex !== null && state.groups[editingIndex]) {
    state.groups[editingIndex].tile = tile;
  } else {
    state.groups.push({ kind: pickingKind, tile, jokers: 0 });
  }
  editingIndex = null;
  $('picker').hidden = true;
  render();
}

/* ============ 云端识别 ============ */


async function apiCall(content, maxTokens) {
  const s = state.settings;
  if (!s.key) throw new Error('还没填 API Key，点右上角「设置」');
  const res = await fetch(s.base.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + s.key,
    },
    body: JSON.stringify({
      model: s.model,
      temperature: 0,
      max_tokens: maxTokens || 1500,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  const c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!c) throw new Error('模型正文为空');
  return c;
}

function imageContent(dataUrl) {
  return { type: 'image_url', image_url: { url: dataUrl } };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片读取失败'));
    img.src = src;
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsDataURL(file);
  });
}

function canvasOf(img, maxSide) {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function rotateCanvas(src, deg) {
  const rad = (deg * Math.PI) / 180;
  const swap = deg === 90 || deg === 270;
  const c = document.createElement('canvas');
  c.width = swap ? src.height : src.width;
  c.height = swap ? src.width : src.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function jpeg(canvas, q) {
  return canvas.toDataURL('image/jpeg', q || 0.92);
}

async function detectRotation(canvas) {
  try {
    const small = canvasToSmall(canvas, 700);
    const txt = await apiCall(
      [{ type: 'text', text: ROT_PROMPT }, imageContent(jpeg(small))],
      8
    );
    if (txt.includes('270')) return 270;
    if (txt.includes('180')) return 180;
    if (txt.includes('90')) return 90;
    return 0;
  } catch (e) {
    return 0;
  }
}

function canvasToSmall(canvas, maxSide) {
  const s = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

async function isUpright(canvas) {
  try {
    const txt = await apiCall(
      [
        { type: 'text', text: '图中麻将牌上的汉字现在是正立的吗？只回答「是」或「否」。' },
        imageContent(jpeg(canvasToSmall(canvas, 700))),
      ],
      8
    );
    return !txt.includes('否');
  } catch (e) {
    return true;
  }
}

function kindOf(s) {
  const m = { 碰: 'MING_KE', 明刻: 'MING_KE', 暗刻: 'AN_KE', 刻: 'AN_KE', 明杠: 'MING_GANG', 暗杠: 'AN_GANG', 对子: 'PAIR' };
  return m[(s || '').trim()] || null;
}

function fixKind(kind, count) {
  if (count < 2 || count > 4) return kind;
  const expect = { PAIR: 2, MING_KE: 3, AN_KE: 3, MING_GANG: 4, AN_GANG: 4 }[kind];
  if (count === expect) return kind;
  if (count === 2) return 'PAIR';
  if (count === 3) return kind === 'AN_GANG' || kind === 'AN_KE' ? 'AN_KE' : 'MING_KE';
  return kind === 'AN_GANG' || kind === 'AN_KE' ? 'AN_GANG' : 'MING_GANG';
}

function tileOf(s) {
  const t = (s || '').trim();
  const honors = { 东风: 'E', 南风: 'S', 西风: 'W', 北风: 'N', 红中: 'Z', 中: 'Z', 发财: 'F', 发: 'F', 白板: 'B', 白: 'B' };
  if (honors[t]) return honors[t];
  for (let i = 0; i < 9; i++) {
    if (t.length === 2 && t[0] === CN[i]) {
      const suit = { 筒: 'b', 饼: 'b', 条: 't', 索: 't', 万: 'w', 萬: 'w' }[t[1]];
      return suit ? `${i + 1}${suit}` : null;
    }
  }
  return /^[1-9][wtb]$/.test(t) ? t : null;
}

function flowerOf(s) {
  return { 春: 'chun', 夏: 'xia', 秋: 'qiu', 冬: 'dong' }[(s || '').trim()] || null;
}

function parseResult(raw) {
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('模型没有返回 JSON：' + raw.slice(0, 200));
  const json = JSON.parse(raw.slice(a, b + 1));

  const groups = [];
  for (const o of json.groups || []) {
    const rawKind = kindOf(o.kind);
    if (!rawKind) continue;
    let names = Array.isArray(o.tiles) ? o.tiles.slice() : [];
    if (!names.length && o.tile) {
      const n = Math.min(4, Math.max(1, o.count || 3));
      names = Array(n).fill(o.tile);
    }
    if (!names.length) continue;
    const isJoker = (s) => ['百搭', '百搭牌'].includes((s || '').trim());
    const jokers = Math.min(4, names.filter(isJoker).length);
    const real = names.map((s) => (s || '').trim()).find((s) => !isJoker(s));
    if (!real) continue;
    const tile = tileOf(real);
    if (!tile) continue;
    const kind = jokers > 0 ? 'AN_KE' : fixKind(rawKind, names.length);
    groups.push({ kind, tile, jokers });
  }

  const flowers = [];
  for (const f of json.flowers || []) {
    const c = flowerOf(f);
    if (c && !flowers.includes(c)) flowers.push(c);
  }
  return { groups, flowers };
}

async function recognizeFile(file) {
  const url = await fileToDataUrl(file);
  const img = await loadImage(url);
  const base = canvasOf(img, 1600);

  // 直接采用朝向判定的结果。之前加了一步「再确认一次、不对就补转 180°」，
  // 实测那次确认并不可靠（大部分牌旋转 180° 看不出差别），反而会把对的转成错的。
  const deg = await detectRotation(base);
  const upright = deg ? rotateCanvas(base, deg) : base;
  state.lastRot = deg;

  // 第一次：只问组型和张数（实测四手全对）
  const structTxt = await apiCall([
    { type: 'text', text: PROSE_PROMPT },
    imageContent(jpeg(upright)),
  ], 800);
  const r = parseProse(structTxt);

  // 第二次：按顺序问每组牌名，用来预填（个别会错，用户点一下即可）
  let merged = r.groups;
  try {
    const nameTxt = await apiCall([
      { type: 'text', text: NAMES_PROMPT },
      imageContent(jpeg(upright)),
    ], 1200);
    const names = parseOrderedNames(nameTxt);
    if (names.length) merged = mergeNames(r.groups, names);
  } catch (e) {
    // 预填失败不影响主流程，牌名留空等用户点
  }

  state.groups = merged;
  state.flowers = r.flowers;
  render();

  if (!r.groups.length) alert('模型没认出任何牌组。请确认牌是正面朝上、分组摆好的。');
}

/* ============ 事件绑定 ============ */

function bind() {
  $('btn-settings').onclick = () => {
    // 万一 localStorage 里存了空串，这里再兜一次底
    state.settings.base = state.settings.base || 'https://api.deepseek.com';
    state.settings.model = state.settings.model || 'deepseek-flash';
    $('s-base').value = state.settings.base;
    $('s-model').value = state.settings.model;
    $('s-key').value = state.settings.key;
    $('s-result').textContent = '';
    $('settings').hidden = false;
  };
  $('settings-close').onclick = () => { $('settings').hidden = true; };
  $('s-save').onclick = () => {
    state.settings = {
      base: $('s-base').value.trim() || 'https://api.deepseek.com',
      model: $('s-model').value.trim() || 'deepseek-flash',
      key: $('s-key').value.trim(),
    };
    saveSettings();
    $('settings').hidden = true;
    updateHint();
  };
  $('s-test').onclick = async () => {
    const save = state.settings;
    state.settings = {
      base: $('s-base').value.trim() || 'https://api.deepseek.com',
      model: $('s-model').value.trim() || 'deepseek-flash',
      key: $('s-key').value.trim(),
    };
    $('s-result').textContent = '测试中…';
    try {
      const c = await apiCall('只回复两个字：正常', 32);
      $('s-result').textContent = '连接正常，模型回复：' + c.trim();
    } catch (e) {
      $('s-result').textContent = '失败：' + e.message;
    }
    state.settings = save;
  };

  $('picker-close').onclick = () => { $('picker').hidden = true; };

  $('btn-cam').onclick = () => $('file-cam').click();
  $('btn-pick').onclick = () => $('file-pick').click();

  const onFile = async (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!f) return;
    if (!state.settings.key) {
      alert('还没填 API Key，点右上角「设置」');
      return;
    }
    setBusy(true);
    try {
      await recognizeFile(f);
    } catch (e) {
      alert('识别失败：' + (e.message || e));
    } finally {
      setBusy(false);
    }
  };
  $('file-cam').onchange = onFile;
  $('file-pick').onchange = onFile;

  $('btn-clear').onclick = () => {
    if (!confirm('清空本手牌？')) return;
    state.groups = [];
    state.flowers = [];
    state.seat = null;
    state.roundWind = null;
    render();
  };

  // 万一又卡在旧缓存，点这个：注销 Service Worker、清缓存、重载
  $('btn-update').onclick = async () => {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) {
      // 忽略，直接重载
    }
    location.reload();
  };
}

function setBusy(v) {
  state.busy = v;
  $('btn-cam').disabled = v;
  $('btn-pick').disabled = v;
  if (v) {
    $('rot-hint').hidden = false;
    $('rot-hint').textContent = '识别中…';
  } else {
    updateHint();
  }
}

function updateHint() {
  const el = $('rot-hint');
  if (state.lastRot == null) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = '上次识别：图片转正 ' + state.lastRot + '°';
}

bind();
render();
updateHint();

// 页面加载时就把设置框填好，万一弹层意外露出来也不会是空白的
$('s-base').value = state.settings.base || 'https://api.deepseek.com';
$('s-model').value = state.settings.model || 'deepseek-flash';
$('s-key').value = state.settings.key || '';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // 有新版本就立刻接管，避免继续跑旧代码
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (!sw) return;
        sw.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) {
            reg.waiting && reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch(() => {});
  });
}
