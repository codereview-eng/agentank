// AgenTank 网页端 UI：本地跑引擎对战 + canvas 逐 tick 回放 + 实时战报 + 天梯。
// 开发版经 <script type="module"> 加载；发布版由 scripts/build-web.mjs 去 import/export 内联进单文件。
import { runMatch, generateMap, mulberry32, renderText, RULES, TILE } from '../src/engine/index.js';
import { bots } from '../bots/index.js';

const $id = (s) => document.getElementById(s);
const editorEl = $id('editor');
const oppSelect = $id('opp');
const seedInput = $id('seed');
const errEl = $id('scriptErr');
const canvasEl = $id('arena');
const ctx = canvasEl.getContext('2d');
const verdictMain = $id('verdictMain');
const verdictSub = $id('verdictSub');
const verdictRef = $id('verdictRef');
const logEl = $id('log');
const ladderBody = $id('ladderBody');
const tickLabel = $id('tickLabel');
const trackEl = $id('track');
const trackFill = $id('trackFill');
const trackKnob = $id('trackKnob');
const playBtn = $id('playBtn');
const rankChip = $id('rankChip');
const footSeed = $id('footSeed');
const footLog = $id('footLog');
const editorTitle = $id('editorTitle');
const saveBtn = $id('saveBtn');

const COLOR = {
  p1: '#A3E635', p1d: '#4D7C0F',
  p2: '#F472B6', p2d: '#9D2463',
  star: '#FBBF24', accent: '#38BDF8',
};
const TSZ = 28;
const SPEEDS = [1, 2, 4];
const BASE_TPS = 20; // 1x = 每秒 20 tick，用时口径 = ticks/20 秒
const SKILL_CN = { cloak: '隐身', teleport: '传送', stun: '眩晕' };

// ---------- 默认脚本（效果稿同款） ----------
const DEFAULT_SCRIPT = `// 你的战术：优先吃星，残血传送跑路
export default function decide(api) {
  const me = api.me();
  const star = api.nearestStar();

  // 看得见敌人就开炮
  if (api.enemyVisible() && api.canFire())
    return api.fireAt(api.enemy());

  // 残血：传送去安全角落
  if (me.hp < 30 && api.ready('teleport'))
    return api.teleport(api.safestCorner());

  // 默认：抢最近的星
  return star ? api.moveTo(star)
              : api.patrol();
}
`;

// ---------- 内置天梯阵容 ----------
const ROSTER = [
  { key: 'stealth', tank: '幽灵-7', style: '隐身偷袭', fn: bots.stealth },
  { key: 'starGrabber', tank: '采星者', style: '抢星', fn: bots.starGrabber },
  { key: 'camper', tank: '草垛王', style: '蹲草', fn: bots.camper },
  { key: 'brawler', tank: '铁头娃', style: '贴脸', fn: bots.brawler },
];
const LADDER_SEEDS = [11, 22, 33, 44, 55];

// ---------- 工具 ----------
function seedFromString(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) s = '1';
  if (/^\d+$/.test(s) && s.length <= 10) return Number(s) >>> 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// 默认脚本的预编译等价实现（托管环境 CSP 禁 eval 时的降级路径，语义与 DEFAULT_SCRIPT 逐行一致）
function defaultDecide(api) {
  const me = api.me();
  const star = api.nearestStar();
  if (api.enemyVisible() && api.canFire()) return api.fireAt(api.enemy());
  if (me.hp < 30 && api.ready('teleport')) return api.teleport(api.safestCorner());
  return star ? api.moveTo(star) : api.patrol();
}

// 探测宿主是否允许 eval（run.ceo artifact 的 CSP 为 script-src 'unsafe-inline'，无 'unsafe-eval'）
const EVAL_OK = (() => { try { new Function(''); return true; } catch { return false; } })();

function compileScript(src) {
  if (!EVAL_OK) {
    if (String(src).replace(/\s+/g, '') === DEFAULT_SCRIPT.replace(/\s+/g, ''))
      return defaultDecide;
    throw new Error('线上托管版受 CSP 限制（禁 eval），暂不支持编译改动后的脚本；默认脚本可直接开战。要自定义脚本，请把本页另存为 .html 在本地打开。');
  }
  const m = src.match(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
  const entry = m ? m[1] : 'decide';
  const code = String(src).replace(/export\s+default\s+/g, '');
  const factory = new Function(
    '"use strict";\n' + code +
    '\n;if (typeof ' + entry + ' === "function") return ' + entry + ';' +
    '\nthrow new Error("未找到入口函数 ' + entry + '(api)，请定义 function decide(api) {...}");'
  );
  const fn = factory();
  if (typeof fn !== 'function') throw new Error('脚本未提供 decide(api) 函数');
  return fn;
}

function guardWrap(fn, box) {
  return (api) => {
    try { return fn(api); } catch (e) {
      box.count++; box.last = String((e && e.message) || e);
      return null; // 报错 = 本拍待机（与引擎口径一致）
    }
  };
}

function showErr(msg) { errEl.textContent = msg; errEl.classList.add('show'); }
function hideErr() { errEl.classList.remove('show'); }

// ---------- 版本存储 ----------
let curVersion = 1;
let versionCount = 1;
function loadStore() {
  try {
    const raw = localStorage.getItem('agentank.save');
    if (raw) {
      const s = JSON.parse(raw);
      if (s && typeof s.code === 'string' && s.code.trim()) {
        editorEl.value = s.code;
        curVersion = s.v || 1;
        versionCount = s.n || 1;
      }
    }
  } catch { /* file:// 或隐私模式下无 localStorage：忽略 */ }
}
function saveVersion() {
  versionCount++;
  curVersion = versionCount;
  try {
    localStorage.setItem('agentank.save', JSON.stringify({ code: editorEl.value, v: curVersion, n: versionCount }));
  } catch { /* 忽略 */ }
  updateVersionUi();
  scheduleLadder();
}
function updateVersionUi() {
  saveBtn.textContent = `保存为新版本（当前 v${curVersion} · 共 ${versionCount} 版）`;
  editorTitle.textContent = `策略脚本 · 我的坦克 v${curVersion}`;
}

// ---------- 回放时间线（由事件数组重建每 tick 快照） ----------
function buildTimeline(map, result) {
  const ticks = result.ticks;
  const byTick = Array.from({ length: ticks }, () => []);
  for (const e of result.events) if (e.t >= 0 && e.t < ticks) byTick[e.t].push(e);
  const pos = map.spawns.map((s) => ({ x: s.x, y: s.y }));
  const hp = [RULES.hp, RULES.hp];
  const held = [0, 0];
  const cloakLeft = [0, 0];
  const stunLeft = [0, 0];
  const facing = [0, Math.PI];
  const dead = [false, false];
  let field = map.stars.map((s) => ({ x: s.x, y: s.y }));
  const frames = [];
  const shots = [];
  const sparks = [];
  const pending = [null, null];
  for (let t = 0; t < ticks; t++) {
    for (const i of [0, 1]) {
      if (cloakLeft[i] > 0) cloakLeft[i]--;
      if (stunLeft[i] > 0) stunLeft[i]--;
    }
    for (const e of byTick[t]) {
      switch (e.type) {
        case 'move': {
          const dx = e.x - pos[e.who].x;
          const dy = e.y - pos[e.who].y;
          if (dx || dy) facing[e.who] = Math.atan2(dy, dx);
          pos[e.who] = { x: e.x, y: e.y };
          break;
        }
        case 'star':
          field = field.filter((s) => !(s.x === e.x && s.y === e.y));
          held[e.who] = e.total;
          break;
        case 'star_spawn':
          field = field.concat([{ x: e.x, y: e.y }]);
          break;
        case 'fire':
          facing[e.who] = Math.atan2(e.ty - e.y, e.tx - e.x);
          if (cloakLeft[e.who] > 0) cloakLeft[e.who] = 0; // 开火破隐
          pending[e.who] = { t, who: e.who, x0: e.x, y0: e.y };
          break;
        case 'bullet_end':
          if (pending[e.who]) {
            shots.push({ ...pending[e.who], x1: e.x, y1: e.y, hit: e.cause === 'hit' });
            pending[e.who] = null;
          }
          break;
        case 'hit':
          hp[e.target] = e.hp;
          sparks.push({ t, x: e.x, y: e.y, kind: 'hit' });
          break;
        case 'skill':
          if (e.name === 'teleport') {
            sparks.push({ t, x: pos[e.who].x, y: pos[e.who].y, kind: 'tp' });
            pos[e.who] = { x: e.x, y: e.y };
            sparks.push({ t, x: e.x, y: e.y, kind: 'tp' });
          } else if (e.name === 'cloak') {
            cloakLeft[e.who] = e.duration;
          }
          break;
        case 'stun_hit':
          stunLeft[e.target] = e.duration;
          break;
        case 'death':
          dead[e.who] = true;
          break;
        default:
          break;
      }
    }
    frames.push({
      pos: pos.map((p) => ({ ...p })),
      hp: [...hp], held: [...held],
      cloak: [...cloakLeft], stun: [...stunLeft],
      facing: [...facing], dead: [...dead],
      field, // filter/concat 均产生新数组，此引用即本 tick 快照
    });
  }
  return { frames, shots, sparks };
}

// ---------- 战报时间线（中文行 + 着色） ----------
function buildLog(result, names) {
  const held = [0, 0];
  const out = [];
  const nm = (i) => `<span class="${i === 0 ? 'p1' : 'p2'}">${names[i]}</span>`;
  for (const e of result.events) {
    let html = null;
    switch (e.type) {
      case 'start': html = `对战开始 · 地图 ${e.width}×${e.height}`; break;
      case 'goal':
        html = e.tag === 'star' ? `${nm(e.who)} 直奔星星 (${e.x},${e.y})`
          : e.tag === 'enemy' ? `${nm(e.who)} 扑向敌人 (${e.x},${e.y})`
            : `${nm(e.who)} 移动到 (${e.x},${e.y})`;
        break;
      case 'fire': html = `${nm(e.who)} 开火`; break;
      case 'hit': html = `${nm(e.who)} 命中 ${nm(e.target)} <span class="dmg">-${e.dmg}</span>（剩 ${e.hp}）`; break;
      case 'bullet_end':
        if (e.cause === 'wall') html = `${nm(e.who)} 的子弹被墙挡下`;
        else if (e.cause === 'dirt') html = `${nm(e.who)} 的子弹被土堆挡下`;
        break;
      case 'star':
        held[e.who] = e.total;
        html = `${nm(e.who)} <span class="st">吃星 ★ ${held[0]}:${held[1]}</span>`;
        break;
      case 'star_spawn': html = `<span class="st">新星星</span>出现在 (${e.x},${e.y})`; break;
      case 'skill': html = `${nm(e.who)} 施放<span class="sk">${SKILL_CN[e.name] ?? e.name}</span>`; break;
      case 'stun_hit': html = `${nm(e.target)} 被<span class="sk">眩晕</span> ${e.duration} 拍`; break;
      case 'death': html = `${nm(e.who)} <span class="dmg">被击毁</span>`; break;
      case 'end':
        html = e.winner == null
          ? `平局（星 ${e.stars[0]}:${e.stars[1]}）`
          : `${nm(e.winner)} <span class="win2">获胜</span>（${e.reason === 'kill' ? '击杀' : '星数'}，星 ${e.stars[0]}:${e.stars[1]}）`;
        break;
      default: break;
    }
    if (html) out.push({ t: e.t, html });
  }
  return out;
}

// ---------- canvas 绘制（画法参照效果稿） ----------
function setupCanvas(map) {
  canvasEl.width = map.width * TSZ;
  canvasEl.height = map.height * TSZ;
}

function drawStarShape(cx, cy, r, col) {
  ctx.fillStyle = col;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx[i ? 'lineTo' : 'moveTo'](cx + rr * Math.cos(a), cy + rr * Math.sin(a));
  }
  ctx.closePath();
  ctx.fill();
}

function drawTank(px, py, ang, col, dark, alpha) {
  const k = TSZ / 32;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(px, py);
  ctx.rotate(ang);
  ctx.fillStyle = dark;
  ctx.fillRect(-15 * k, -12 * k, 30 * k, 24 * k); // 履带
  ctx.fillStyle = col;
  ctx.fillRect(-11 * k, -9 * k, 22 * k, 18 * k); // 车身
  ctx.beginPath(); ctx.arc(0, 0, 7 * k, 0, 7); ctx.fill(); // 炮塔
  ctx.fillRect(0, -2.5 * k, 20 * k, 5 * k); // 炮管
  ctx.restore();
}

function drawHpBar(px, py, pct, col) {
  const k = TSZ / 32;
  ctx.fillStyle = '#0C1118';
  ctx.fillRect(px - 18 * k, py - 28 * k, 36 * k, 6 * k);
  ctx.strokeStyle = '#2A3442';
  ctx.strokeRect(px - 18 * k, py - 28 * k, 36 * k, 6 * k);
  ctx.fillStyle = col;
  ctx.fillRect(px - 17 * k, py - 27 * k, 34 * k * Math.max(0, pct), 4 * k);
}

function drawArena(map, f, names, shots, sparks, curT) {
  const W = map.width;
  const H = map.height;
  ctx.fillStyle = '#0C1118';
  ctx.fillRect(0, 0, W * TSZ, H * TSZ);
  ctx.strokeStyle = '#151C26';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x++) { ctx.beginPath(); ctx.moveTo(x * TSZ, 0); ctx.lineTo(x * TSZ, H * TSZ); ctx.stroke(); }
  for (let y = 0; y <= H; y++) { ctx.beginPath(); ctx.moveTo(0, y * TSZ); ctx.lineTo(W * TSZ, y * TSZ); ctx.stroke(); }
  // 地形
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const tile = map.tiles[y][x];
      if (tile === TILE.GRASS) {
        ctx.fillStyle = 'rgba(74,222,128,0.13)';
        ctx.fillRect(x * TSZ, y * TSZ, TSZ, TSZ);
        ctx.fillStyle = 'rgba(74,222,128,0.45)';
        for (let i = 0; i < 5; i++) {
          const gx = x * TSZ + 4 + (i * 11) % (TSZ - 7);
          const gy = y * TSZ + 5 + (i * 7) % (TSZ - 10);
          ctx.fillRect(gx, gy, 2, 6);
        }
      } else if (tile === TILE.WALL) {
        ctx.fillStyle = '#3B4757';
        ctx.fillRect(x * TSZ + 1, y * TSZ + 1, TSZ - 2, TSZ - 2);
        ctx.fillStyle = '#2A3442';
        ctx.fillRect(x * TSZ + 1, y * TSZ + 1, TSZ - 2, 4);
        ctx.fillRect(x * TSZ + 1, y * TSZ + TSZ / 2, TSZ - 2, 3);
      } else if (tile === TILE.DIRT) {
        ctx.fillStyle = '#7C5A34';
        ctx.beginPath(); ctx.arc(x * TSZ + TSZ / 2, y * TSZ + TSZ / 2, TSZ / 2 - 4, 0, 7); ctx.fill();
        ctx.fillStyle = '#96713F';
        ctx.beginPath(); ctx.arc(x * TSZ + TSZ / 2 - 3, y * TSZ + TSZ / 2 - 4, TSZ / 4, 0, 7); ctx.fill();
      }
    }
  }
  // 星星
  for (const s of f.field) drawStarShape(s.x * TSZ + TSZ / 2, s.y * TSZ + TSZ / 2, TSZ * 0.34, COLOR.star);
  // 弹道（当前 tick 起保留 3 拍并渐隐）
  if (shots) {
    for (const s of shots) {
      const age = curT - s.t;
      if (age < 0 || age > 3) continue;
      const a = 0.75 * (1 - age / 4);
      ctx.strokeStyle = s.who === 0 ? `rgba(163,230,53,${a})` : `rgba(244,114,182,${a})`;
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x0 * TSZ + TSZ / 2, s.y0 * TSZ + TSZ / 2);
      ctx.lineTo(s.x1 * TSZ + TSZ / 2, s.y1 * TSZ + TSZ / 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  // 坦克
  for (const i of [0, 1]) {
    const p = f.pos[i];
    const px = p.x * TSZ + TSZ / 2;
    const py = p.y * TSZ + TSZ / 2;
    const col = i === 0 ? COLOR.p1 : COLOR.p2;
    const dark = i === 0 ? COLOR.p1d : COLOR.p2d;
    if (f.dead[i]) {
      drawTank(px, py, f.facing[i], '#4B5563', '#293241', 0.35);
      ctx.strokeStyle = 'rgba(248,113,113,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px - 9, py - 9); ctx.lineTo(px + 9, py + 9);
      ctx.moveTo(px + 9, py - 9); ctx.lineTo(px - 9, py + 9);
      ctx.stroke();
      continue;
    }
    const cloaked = f.cloak[i] > 0;
    const inGrass = map.tiles[p.y][p.x] === TILE.GRASS;
    const alpha = cloaked ? 0.4 : inGrass ? 0.72 : 1;
    drawTank(px, py, f.facing[i], col, dark, alpha);
    if (cloaked) { // 隐身虚线圈
      ctx.strokeStyle = 'rgba(56,189,248,0.6)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(px, py, TSZ * 0.62, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    if (f.stun[i] > 0) { // 眩晕黄圈
      ctx.strokeStyle = 'rgba(251,191,36,0.85)';
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, TSZ * 0.68, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    drawHpBar(px, py, f.hp[i] / RULES.hp, f.hp[i] <= 30 ? '#F87171' : '#4ADE80');
    ctx.font = '10px Menlo';
    ctx.fillStyle = col;
    const tag = `P${i + 1} ${names[i]}${cloaked ? ' 隐身中…' : ''} ★${f.held[i]}`;
    ctx.fillText(tag, px - Math.min(ctx.measureText(tag).width / 2, px - 2), py + TSZ * 0.95);
  }
  // 火花（命中/传送）
  if (sparks) {
    for (const sp of sparks) {
      const age = curT - sp.t;
      if (age < 0 || age > 2) continue;
      const px = sp.x * TSZ + TSZ / 2;
      const py = sp.y * TSZ + TSZ / 2;
      const a = 0.9 * (1 - age / 3);
      if (sp.kind === 'hit') {
        ctx.fillStyle = `rgba(251,191,36,${a})`;
        ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.fill();
        ctx.strokeStyle = `rgba(251,191,36,${a * 0.7})`;
        ctx.lineWidth = 2;
        for (let i = 0; i < 6; i++) {
          const ang = (i * Math.PI) / 3;
          ctx.beginPath();
          ctx.moveTo(px + 7 * Math.cos(ang), py + 7 * Math.sin(ang));
          ctx.lineTo(px + 13 * Math.cos(ang), py + 13 * Math.sin(ang));
          ctx.stroke();
        }
      } else { // teleport 闪光
        ctx.strokeStyle = `rgba(56,189,248,${a})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(px, py, TSZ * 0.5 + age * 4, 0, 7); ctx.stroke();
      }
    }
  }
}

// ---------- 对局状态 & 回放 ----------
let match = null; // { seedStr, seed, map, result, names, frames, shots, sparks, entries }
let cur = 0;
let playing = false;
let speedIdx = 1; // 默认 2x
let logRows = [];
let litCount = -1;
let previewMap = null;

function setPlaying(p) {
  playing = p;
  playBtn.textContent = p ? '⏸' : '▶';
}

function renderLogList() {
  logEl.innerHTML = '';
  logRows = [];
  litCount = -1;
  for (const en of match.entries) {
    const d = document.createElement('div');
    d.className = 'ln';
    d.innerHTML = `<span class="t mono">t=${String(en.t).padStart(3, '0')}</span>${en.html}`;
    logEl.appendChild(d);
    logRows.push({ t: en.t, el: d });
  }
}

function lightLog() {
  if (!match) return;
  let n = 0;
  while (n < logRows.length && logRows[n].t <= cur) n++;
  if (n === litCount) return;
  for (let k = 0; k < logRows.length; k++) logRows[k].el.classList.toggle('on', k < n);
  litCount = n;
  if (n > 0) {
    const el = logRows[n - 1].el;
    logEl.scrollTop = Math.max(0, el.offsetTop - logEl.clientHeight + el.offsetHeight + 8 - logEl.offsetTop);
  }
}

function updateTrack() {
  const total = match ? match.result.ticks - 1 : 0;
  const pct = total > 0 ? cur / total : 0;
  trackFill.style.width = `${pct * 100}%`;
  trackKnob.style.left = `${pct * 100}%`;
  tickLabel.textContent = match ? `t=${cur} / ${total}` : 't=— / —';
}

function render() {
  if (match) {
    const f = match.frames[Math.min(cur, match.frames.length - 1)];
    drawArena(match.map, f, match.names, match.shots, match.sparks, cur);
    updateTrack();
    lightLog();
  } else if (previewMap) {
    drawArena(previewMap, {
      pos: previewMap.spawns.map((s) => ({ ...s })),
      hp: [RULES.hp, RULES.hp], held: [0, 0], cloak: [0, 0], stun: [0, 0],
      facing: [0, Math.PI], dead: [false, false], field: previewMap.stars,
    }, ['我的坦克 v' + curVersion, '对手'], null, null, 0);
  }
}

let lastTs = 0;
let acc = 0;
function loop(ts) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (ts - lastTs) / 1000 || 0);
  lastTs = ts;
  if (playing && match) {
    acc += dt * BASE_TPS * SPEEDS[speedIdx];
    const n = Math.floor(acc);
    if (n > 0) {
      acc -= n;
      cur = Math.min(cur + n, match.result.ticks - 1);
      if (cur >= match.result.ticks - 1) setPlaying(false);
    }
  }
  render();
}

function updateVerdict(box) {
  const r = match.result;
  const names = match.names;
  if (r.winner === null) {
    verdictMain.textContent = '◐ 平局';
    verdictMain.style.color = 'var(--muted)';
  } else {
    verdictMain.textContent = `● ${names[r.winner]} WIN`;
    verdictMain.style.color = r.winner === 0 ? 'var(--p1)' : 'var(--p2)';
  }
  const how = r.reason === 'kill' ? '击杀' : r.reason === 'stars' ? '星数' : '平局';
  verdictSub.textContent = `${how} @ t=${r.ticks - 1} · 星 ${r.stars[0]}:${r.stars[1]} · 用时 ${(r.ticks / BASE_TPS).toFixed(1)}s`;
  verdictRef.textContent = `回放 · 战报 #${10000 + (match.seed % 90000)}`;
  if (box && box.count > 0) showErr(`脚本运行时报错 ${box.count} 次（该拍已按待机处理）：${box.last}`);
}

function updateFooter() {
  footSeed.textContent = `deterministic · seed=${match.seedStr}`;
  const bytes = new TextEncoder().encode(renderText(match.result, match.names).join('\n')).length;
  footLog.textContent = `battle.log ${(bytes / 1024).toFixed(1)}KB`;
}

function startBattle() {
  hideErr();
  let fn;
  try {
    fn = compileScript(editorEl.value);
  } catch (e) {
    showErr(`脚本编译失败：${String((e && e.message) || e)}`);
    return;
  }
  const box = { count: 0, last: '' };
  const guarded = guardWrap(fn, box);
  const seedStr = seedInput.value.trim() || '1';
  const seed = seedFromString(seedStr);
  const oppKey = oppSelect.value;
  const opp = ROSTER.find((r) => r.key === oppKey) || ROSTER[0];
  // 地图与对局同源同 seed：先生成地图再喂给 runMatch，保证渲染的就是对局用图
  const map = generateMap(mulberry32(seed));
  const names = [`我的坦克 v${curVersion}`, `${opp.style}流`];
  const result = runMatch({ seed, botA: guarded, botB: opp.fn, map });
  const tl = buildTimeline(map, result);
  match = { seedStr, seed, map, result, names, frames: tl.frames, shots: tl.shots, sparks: tl.sparks, entries: buildLog(result, names) };
  setupCanvas(map);
  renderLogList();
  updateVerdict(box);
  updateFooter();
  cur = 0;
  acc = 0;
  setPlaying(true);
}

// ---------- 天梯（空闲时固定 seeds 循环赛实算 ELO/胜率） ----------
let ladderToken = 0;
function computeLadder() {
  const token = ++ladderToken;
  const parts = ROSTER.map((r) => ({ ...r, elo: 1200, w: 0, d: 0, g: 0 }));
  try {
    const fn = compileScript(editorEl.value);
    const box = { count: 0, last: '' };
    parts.push({ key: '__user__', tank: `我的坦克 v${curVersion}`, style: '自定义', fn: guardWrap(fn, box), me: true, elo: 1200, w: 0, d: 0, g: 0 });
  } catch { /* 用户脚本编译失败：天梯只算内置四家 */ }
  const jobs = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) jobs.push([i, j]);
  let k = 0;
  const step = () => {
    if (token !== ladderToken) return; // 有新一轮计算，废弃本轮
    if (k >= jobs.length) { renderLadder(parts); return; }
    const [i, j] = jobs[k++];
    for (const seed of LADDER_SEEDS) {
      for (const flip of [false, true]) {
        const A = flip ? parts[j] : parts[i];
        const B = flip ? parts[i] : parts[j];
        const r = runMatch({ seed, botA: A.fn, botB: B.fn });
        const sA = r.winner === null ? 0.5 : r.winner === 0 ? 1 : 0;
        const ea = 1 / (1 + 10 ** ((B.elo - A.elo) / 400));
        A.elo += 24 * (sA - ea);
        B.elo += 24 * ((1 - sA) - (1 - ea));
        A.g++; B.g++;
        if (sA === 1) A.w++;
        else if (sA === 0) B.w++;
        else { A.d++; B.d++; }
      }
    }
    setTimeout(step, 0); // 分片跑，不卡首屏
  };
  step();
}

function renderLadder(parts) {
  parts.sort((a, b) => b.elo - a.elo);
  ladderBody.innerHTML = '';
  parts.forEach((p, i) => {
    const tr = document.createElement('tr');
    if (p.me) tr.className = 'me';
    const wr = p.g ? Math.round(((p.w + 0.5 * p.d) / p.g) * 100) : 0;
    tr.innerHTML = `<td${i === 0 ? ' class="r1"' : ''}>${i + 1}</td><td>${p.tank}</td><td>${p.style}</td><td class="elo">${Math.round(p.elo)}</td><td>${wr}%</td>`;
    ladderBody.appendChild(tr);
  });
  for (const r of ROSTER) {
    const p = parts.find((x) => x.key === r.key);
    const opt = oppSelect.querySelector(`option[value="${r.key}"]`);
    if (p && opt) opt.textContent = `${r.style}流 (内置 · ELO ${Math.round(p.elo)})`;
  }
  const mine = parts.find((p) => p.me);
  rankChip.textContent = mine
    ? `★ 我的坦克 v${curVersion} · ELO ${Math.round(mine.elo)}（#${parts.indexOf(mine) + 1}/${parts.length}）`
    : '★ 天梯已更新';
  const hint = document.getElementById('ladderHint');
  if (hint) hint.textContent = `固定 seeds ${JSON.stringify(LADDER_SEEDS)} 双边循环赛 · 共 ${parts.length * (parts.length - 1) * LADDER_SEEDS.length} 局实算`;
}

function scheduleLadder() {
  const go = () => computeLadder();
  if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 1200 });
  else setTimeout(go, 600);
}

// ---------- 事件绑定 ----------
$id('battleBtn').addEventListener('click', startBattle);
saveBtn.addEventListener('click', saveVersion);
playBtn.addEventListener('click', () => { if (match) setPlaying(!playing); });
$id('firstBtn').addEventListener('click', () => { if (match) { cur = 0; acc = 0; } });
$id('lastBtn').addEventListener('click', () => { if (match) { cur = match.result.ticks - 1; setPlaying(false); } });
$id('speedBox').addEventListener('click', (e) => {
  const s = e.target && e.target.dataset ? e.target.dataset.s : null;
  if (s == null) return;
  speedIdx = Number(s);
  for (const el of e.currentTarget.children) el.classList.toggle('on', el.dataset.s === s);
});
let dragging = false;
function seekFromPointer(e) {
  if (!match) return;
  const r = trackEl.getBoundingClientRect();
  const pct = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  cur = Math.round(pct * (match.result.ticks - 1));
}
trackEl.addEventListener('pointerdown', (e) => { dragging = true; trackEl.setPointerCapture(e.pointerId); seekFromPointer(e); });
trackEl.addEventListener('pointermove', (e) => { if (dragging) seekFromPointer(e); });
trackEl.addEventListener('pointerup', () => { dragging = false; });

// ---------- 启动 ----------
loadStore();
if (!editorEl.value.trim()) editorEl.value = DEFAULT_SCRIPT;
if (!EVAL_OK) {
  const note = document.createElement('div');
  note.style.cssText = 'margin:6px 12px 0;padding:6px 8px;font-size:11px;line-height:1.5;color:#8b949e;border:1px solid #30363d;border-radius:6px;';
  note.textContent = '线上托管版：宿主 CSP 禁 eval，默认脚本以内置等价策略运行；编辑自定义脚本请把本页另存为 .html 在本地打开。';
  errEl.parentNode.insertBefore(note, errEl);
}
updateVersionUi();
const qp = new URLSearchParams(location.search);
if (qp.get('seed')) seedInput.value = qp.get('seed');
footSeed.textContent = `deterministic · seed=${seedInput.value.trim()}`;
previewMap = generateMap(mulberry32(seedFromString(seedInput.value)));
setupCanvas(previewMap);
requestAnimationFrame(loop);
scheduleLadder();
if (qp.get('autoplay') === '1') {
  startBattle();
  if (match) { // 跳到中局并停住，便于截图/演示（双方坦克在场、战报点亮过半）
    cur = Math.floor((match.result.ticks - 1) / 2);
    setPlaying(false);
  }
}
