// AgenTank 网页端 UI：本地跑引擎对战 + canvas 逐 tick 回放 + 实时战报 + 天梯。
// 开发版经 <script type="module"> 加载；发布版由 scripts/build-web.mjs 去 import/export 内联进单文件。
import { runMatch, generateMap, mulberry32, renderText, RULES, TILE, PRESET_MAPS, presetMap } from '../src/engine/index.js';
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
  p1: '#78A83F', p1d: '#3C5A1E',
  p2: '#E0679B', p2d: '#7E2A4E',
  star: '#FFC93C', accent: '#38BDF8',
};
const TSZ = 28;
const SPEEDS = [1, 2, 4];
const BASE_TPS = 20; // 1x = 每秒 20 tick，用时口径 = ticks/20 秒
const SKILL_CN = {
  shield: '护盾', freeze: '冰冻', stun: '眩晕', overload: '超载',
  cloak: '隐身', poison: '剧毒', teleport: '传送', boost: '疾驰',
};
const skillSel = $id('skillSel');
const userSkill = () => (skillSel ? skillSel.value : 'teleport');

// ---------- 地图选择（10 张预置图 + 默认随机图） ----------
const mapSel = $id('mapSel');
if (mapSel) {
  for (const m of PRESET_MAPS) {
    const o = document.createElement('option');
    o.value = m.id;
    o.textContent = `${m.name}（${m.desc}）`;
    mapSel.appendChild(o);
  }
}
const userMapKey = () => (mapSel ? mapSel.value : 'random');
// 取当前对局用图：预置图按 id 取（每次全新对象），默认走种子随机生成
function makeMap(seed) {
  const key = userMapKey();
  if (key !== 'random') {
    const m = presetMap(key);
    if (m) return m;
  }
  return generateMap(mulberry32(seed));
}

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
  const frozenLeft = [0, 0];
  const poisonLeft = [0, 0];
  const shieldOn = [false, false];
  const facing = [0, Math.PI];
  const dead = [false, false];
  // 单星规则：引擎只保留地图声明的第一颗星，渲染同口径截断
  let field = map.stars.slice(0, RULES.maxFieldStars ?? map.stars.length).map((s) => ({ x: s.x, y: s.y }));
  let bombs = [];              // 在场炸弹 [{x,y,t0}]
  let gone = new Set();        // 已摧毁土堆 "x,y"
  let cracked = new Set();     // 打裂土堆 "x,y"
  const frames = [];
  const shots = [];
  const sparks = [];
  const pending = [null, null];
  for (let t = 0; t < ticks; t++) {
    for (const i of [0, 1]) {
      if (cloakLeft[i] > 0) cloakLeft[i]--;
      if (stunLeft[i] > 0) stunLeft[i]--;
      if (frozenLeft[i] > 0) frozenLeft[i]--;
      if (poisonLeft[i] > 0) poisonLeft[i]--;
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
        case 'turn':
          facing[e.who] = Math.atan2(e.dy, e.dx);
          break;
        case 'fire':
          facing[e.who] = Math.atan2(e.dy, e.dx);
          if (cloakLeft[e.who] > 0) cloakLeft[e.who] = 0; // 开火破隐
          pending[e.who] = { who: e.who, t0: t, x0: e.x, y0: e.y };
          break;
        case 'bullet_end':
          if (pending[e.who]) {
            shots.push({ ...pending[e.who], t1: t, x1: e.x, y1: e.y, hit: e.reason === 'hit' });
            pending[e.who] = null;
          }
          break;
        case 'hit':
          hp[e.target] = e.hp;
          sparks.push({ t, x: e.x, y: e.y, kind: 'hit' });
          break;
        case 'mound_hit':
          cracked = new Set(cracked).add(`${e.x},${e.y}`);
          break;
        case 'mound_destroyed':
          gone = new Set(gone).add(`${e.x},${e.y}`);
          sparks.push({ t, x: e.x, y: e.y, kind: 'hit' });
          break;
        case 'bomb_place':
          bombs = bombs.concat([{ x: e.x, y: e.y, t0: t }]);
          break;
        case 'bomb_explode':
          bombs = bombs.filter((b) => !(b.x === e.x && b.y === e.y));
          for (const c of e.cells || []) sparks.push({ t, x: c.x, y: c.y, kind: 'boom' });
          for (const h of e.hits || []) hp[h.who] = Math.max(0, hp[h.who] - h.dmg);
          break;
        case 'skill':
          if (e.name === 'teleport') {
            sparks.push({ t, x: pos[e.who].x, y: pos[e.who].y, kind: 'tp' });
            pos[e.who] = { x: e.x, y: e.y };
            sparks.push({ t, x: e.x, y: e.y, kind: 'tp' });
          } else if (e.name === 'cloak') {
            cloakLeft[e.who] = e.duration;
          } else if (e.name === 'shield') {
            shieldOn[e.who] = true;
          }
          break;
        case 'shield_block':
          shieldOn[e.who] = false;
          sparks.push({ t, x: pos[e.who].x, y: pos[e.who].y, kind: 'shield' });
          break;
        case 'freeze_hit':
          frozenLeft[e.target] = e.duration;
          break;
        case 'stun_hit':
          stunLeft[e.target] = e.duration;
          break;
        case 'poison_hit':
          poisonLeft[e.target] = e.duration;
          break;
        case 'poison_tick':
          hp[e.target] = e.hp;
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
      frozen: [...frozenLeft], poison: [...poisonLeft], shield: [...shieldOn],
      facing: [...facing], dead: [...dead],
      field, bombs, gone, cracked, // 均为 copy-on-write 新引用，即本 tick 快照
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
      case 'start':
        html = `对战开始 · 地图 ${e.width}×${e.height}`;
        if (e.skills) html += ` · 技能 ${nm(0)}=<span class="sk">${SKILL_CN[e.skills[0]] ?? e.skills[0]}</span> ${nm(1)}=<span class="sk">${SKILL_CN[e.skills[1]] ?? e.skills[1]}</span>`;
        break;
      case 'goal':
        html = e.tag === 'star' ? `${nm(e.who)} 直奔星星 (${e.x},${e.y})`
          : e.tag === 'enemy' ? `${nm(e.who)} 扑向敌人 (${e.x},${e.y})`
            : `${nm(e.who)} 移动到 (${e.x},${e.y})`;
        break;
      case 'turn': html = `${nm(e.who)} 转炮口${{ '1,0': '→', '-1,0': '←', '0,1': '↓', '0,-1': '↑' }[e.dx + ',' + e.dy] ?? ''}`; break;
      case 'fire': html = `${nm(e.who)} 开火`; break;
      case 'hit': html = `${nm(e.who)} 命中 ${nm(e.target)} <span class="dmg">-${e.dmg}</span>（剩 ${e.hp}）`; break;
      case 'bullet_end':
        if (e.reason === 'wall') html = `${nm(e.who)} 的子弹被墙挡下`;
        else if (e.reason === 'mound') html = `${nm(e.who)} 的子弹打在土堆上`;
        else if (e.reason === 'out') html = `${nm(e.who)} 的子弹飞出场外`;
        break;
      case 'mound_hit':
        if (e.hp > 0) html = `(${e.x},${e.y}) 的土堆被打出裂缝`;
        break;
      case 'mound_destroyed': html = `(${e.x},${e.y}) 的土堆<span class="dmg">被摧毁</span>`; break;
      case 'bomb_place': html = `${nm(e.who)} 在 (${e.x},${e.y}) 放下<span class="sk">炸弹</span>`; break;
      case 'bomb_explode': {
        const hits = (e.hits || []).map((h) => `${nm(h.who)} <span class="dmg">-${h.dmg}</span>`).join('、');
        html = `(${e.x},${e.y}) <span class="dmg">炸弹爆炸</span>（波及 ${e.cells.length} 格${hits ? '，' + hits : ''}）`;
        break;
      }
      case 'shield_block': html = `${nm(e.who)} 的<span class="sk">护盾</span>挡下了${e.source === 'bomb' ? '炸弹' : '子弹'}`; break;
      case 'freeze_hit': html = `${nm(e.target)} 被<span class="sk">冰冻</span> ${e.duration} 拍`; break;
      case 'poison_hit': html = `${nm(e.target)} <span class="sk">中毒</span>，${e.duration} 拍内持续掉血`; break;
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

// 每格确定性伪随机（纹理抖动用，与引擎 RNG 无关）
function tileHash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 1274126177) >>> 0;
  h = ((h ^ (h >>> 13)) * 1103515245) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function rrect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function starPath(cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const k = i % 2 ? r * 0.48 : r;
    ctx[i ? 'lineTo' : 'moveTo'](cx + k * Math.cos(a), cy + k * Math.sin(a));
  }
  ctx.closePath();
}

function drawStarShape(cx, cy, r, col) {
  // 参照原作素材：描边金星 + 内部高光
  starPath(cx, cy, r);
  ctx.fillStyle = col || '#FFC93C';
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, r * 0.22);
  ctx.strokeStyle = '#7A4E12';
  ctx.stroke();
  starPath(cx, cy - r * 0.08, r * 0.52);
  ctx.fillStyle = '#FFE38F';
  ctx.fill();
}

function drawTank(px, py, ang, col, dark, alpha) {
  const k = TSZ / 32;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(px, py);
  ctx.rotate(ang);
  ctx.lineJoin = 'round';
  const ink = 'rgba(24,20,12,0.75)'; // 卡通描边
  // 履带（上下两条 + 纹路）
  ctx.fillStyle = dark;
  rrect(-14 * k, -13 * k, 28 * k, 8 * k, 3 * k); ctx.fill();
  rrect(-14 * k, 5 * k, 28 * k, 8 * k, 3 * k); ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.6 * k;
  rrect(-14 * k, -13 * k, 28 * k, 8 * k, 3 * k); ctx.stroke();
  rrect(-14 * k, 5 * k, 28 * k, 8 * k, 3 * k); ctx.stroke();
  ctx.lineWidth = 1.1 * k;
  ctx.strokeStyle = 'rgba(0,0,0,0.30)';
  for (let i = -10; i <= 10; i += 5) {
    ctx.beginPath(); ctx.moveTo(i * k, -12 * k); ctx.lineTo(i * k, -6 * k); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(i * k, 6 * k); ctx.lineTo(i * k, 12 * k); ctx.stroke();
  }
  // 车身
  ctx.fillStyle = col;
  rrect(-11 * k, -8 * k, 22 * k, 16 * k, 3 * k); ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.8 * k;
  rrect(-11 * k, -8 * k, 22 * k, 16 * k, 3 * k); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.18)'; // 车身高光
  rrect(-9 * k, -6.5 * k, 18 * k, 4 * k, 2 * k); ctx.fill();
  // 炮管 + 炮口
  ctx.fillStyle = dark;
  ctx.fillRect(4 * k, -2.2 * k, 15 * k, 4.4 * k);
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.4 * k;
  ctx.strokeRect(4 * k, -2.2 * k, 15 * k, 4.4 * k);
  ctx.fillRect(18 * k, -3.4 * k, 3.6 * k, 6.8 * k);
  ctx.strokeRect(18 * k, -3.4 * k, 3.6 * k, 6.8 * k);
  // 炮塔
  ctx.fillStyle = col;
  ctx.beginPath(); ctx.arc(0, 0, 6.4 * k, 0, 7); ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 1.8 * k;
  ctx.beginPath(); ctx.arc(0, 0, 6.4 * k, 0, 7); ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.beginPath(); ctx.arc(-1.8 * k, -1.8 * k, 2.4 * k, 0, 7); ctx.fill();
  ctx.restore();
}

function drawHpBar(px, py, pct, col) {
  const k = TSZ / 32;
  ctx.fillStyle = 'rgba(40,30,14,0.55)';
  ctx.fillRect(px - 18 * k, py - 28 * k, 36 * k, 6 * k);
  ctx.strokeStyle = 'rgba(24,20,12,0.75)';
  ctx.strokeRect(px - 18 * k, py - 28 * k, 36 * k, 6 * k);
  ctx.fillStyle = col;
  ctx.fillRect(px - 17 * k, py - 27 * k, 34 * k * Math.max(0, pct), 4 * k);
}

function drawWallTile(x, y) {
  // 鹅卵石砖（参照原作深蓝灰石墙）
  const px = x * TSZ;
  const py = y * TSZ;
  ctx.fillStyle = '#242C39'; // 石缝
  ctx.fillRect(px, py, TSZ, TSZ);
  for (let i = 0; i < 4; i++) {
    const sx = px + (i % 2) * (TSZ / 2);
    const sy = py + ((i / 2) | 0) * (TSZ / 2);
    const v = tileHash(x * 4 + i, y * 4 + i * 3, 7);
    const g = 58 + Math.floor(v * 20);
    const j = v * 2.2; // 石块大小抖动
    ctx.fillStyle = `rgb(${g},${g + 9},${g + 22})`;
    rrect(sx + 1.5 + j * 0.4, sy + 1.5 + j * 0.3, TSZ / 2 - 3 - j * 0.7, TSZ / 2 - 3 - j * 0.5, TSZ * 0.13);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; // 石面高光
    rrect(sx + 3.5, sy + 3, TSZ / 2 - 9, TSZ * 0.1, TSZ * 0.05);
    ctx.fill();
  }
  ctx.strokeStyle = '#161C25';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(px + 0.75, py + 0.75, TSZ - 1.5, TSZ - 1.5);
}

function drawDirtTile(x, y) {
  // 棕色土堆（圆润山包 + 深描边 + 受光面）
  const cx = x * TSZ + TSZ / 2;
  const cy = y * TSZ + TSZ / 2;
  const r = TSZ * 0.44;
  ctx.fillStyle = 'rgba(60,40,15,0.20)'; // 投影
  ctx.beginPath(); ctx.ellipse(cx, cy + r * 0.62, r * 0.95, r * 0.34, 0, 0, 7); ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - r * 0.98, cy + r * 0.62);
  ctx.quadraticCurveTo(cx - r * 0.92, cy - r * 0.32, cx - r * 0.34, cy - r * 0.72);
  ctx.quadraticCurveTo(cx + r * 0.02, cy - r * 1.02, cx + r * 0.42, cy - r * 0.66);
  ctx.quadraticCurveTo(cx + r * 0.96, cy - r * 0.26, cx + r * 0.98, cy + r * 0.62);
  ctx.closePath();
  ctx.fillStyle = '#9A6B33';
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, TSZ * 0.08);
  ctx.strokeStyle = '#432B12';
  ctx.stroke();
  ctx.beginPath(); // 受光亮面
  ctx.moveTo(cx - r * 0.52, cy + r * 0.4);
  ctx.quadraticCurveTo(cx - r * 0.5, cy - r * 0.34, cx - r * 0.08, cy - r * 0.6);
  ctx.quadraticCurveTo(cx + r * 0.12, cy - r * 0.24, cx - r * 0.04, cy + r * 0.4);
  ctx.closePath();
  ctx.fillStyle = '#B8894B';
  ctx.fill();
  ctx.fillStyle = 'rgba(67,43,18,0.55)'; // 碎石点
  for (let i = 0; i < 3; i++) {
    const v = tileHash(x * 8 + i, y * 8 + i, 11);
    ctx.beginPath();
    ctx.arc(cx - r * 0.4 + v * r * 0.9, cy + r * (0.05 + 0.3 * v), TSZ * 0.045, 0, 7);
    ctx.fill();
  }
}

function drawGrassTile(x, y) {
  // 卡通草丛（扇形叶片、双色，长在沙地上）
  const cx = x * TSZ + TSZ / 2;
  const base = y * TSZ + TSZ * 0.78;
  const r = TSZ * 0.42;
  ctx.fillStyle = 'rgba(74,110,45,0.22)'; // 根部阴影
  ctx.beginPath(); ctx.ellipse(cx, base, r * 0.82, r * 0.24, 0, 0, 7); ctx.fill();
  const blades = 9;
  for (let i = 0; i < blades; i++) {
    const v = tileHash(x * 16 + i, y * 16 + i, 13);
    const spread = i - (blades - 1) / 2;
    const a = -Math.PI / 2 + spread * 0.26 + (v - 0.5) * 0.18;
    const len = r * (0.95 + v * 0.6);
    const bx = cx + spread * TSZ * 0.065;
    const mx = bx + Math.cos(a) * len * 0.55;
    const my = base + Math.sin(a) * len * 0.62;
    ctx.beginPath();
    ctx.moveTo(bx - TSZ * 0.085, base);
    ctx.quadraticCurveTo(mx - TSZ * 0.04, my, bx + Math.cos(a) * len, base + Math.sin(a) * len);
    ctx.quadraticCurveTo(mx + TSZ * 0.04, my, bx + TSZ * 0.085, base);
    ctx.closePath();
    ctx.fillStyle = i % 2 ? '#3C9440' : '#74C868';
    ctx.fill();
  }
}

function drawArena(map, f, names, shots, sparks, curT) {
  const W = map.width;
  const H = map.height;
  // 沙地底（参照原作：土黄地面 + 淡纹理 + 木板横线）
  ctx.fillStyle = '#C9B274';
  ctx.fillRect(0, 0, W * TSZ, H * TSZ);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = tileHash(x, y, 1);
      if (v > 0.5) {
        ctx.fillStyle = `rgba(120,90,40,${(v - 0.5) * 0.14})`;
        ctx.fillRect(x * TSZ, y * TSZ, TSZ, TSZ);
      }
      if (v < 0.18) { // 沙面杂点
        ctx.fillStyle = 'rgba(100,75,30,0.18)';
        ctx.fillRect(x * TSZ + (v * 90) % TSZ, y * TSZ + (v * 53) % TSZ, 2, 2);
      }
    }
  }
  ctx.lineWidth = 1;
  for (let y = 0; y <= H; y++) {
    ctx.strokeStyle = y % 2 ? 'rgba(110,82,35,0.20)' : 'rgba(110,82,35,0.10)';
    ctx.beginPath(); ctx.moveTo(0, y * TSZ); ctx.lineTo(W * TSZ, y * TSZ); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(110,82,35,0.08)';
  for (let x = 0; x <= W; x++) { ctx.beginPath(); ctx.moveTo(x * TSZ, 0); ctx.lineTo(x * TSZ, H * TSZ); ctx.stroke(); }
  // 地形
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const tile = map.tiles[y][x];
      if (tile === TILE.GRASS) drawGrassTile(x, y);
      else if (tile === TILE.WALL) drawWallTile(x, y);
      else if (tile === TILE.DIRT) {
        if (f.gone && f.gone.has(`${x},${y}`)) continue; // 已被摧毁：露出地面
        drawDirtTile(x, y);
        if (f.cracked && f.cracked.has(`${x},${y}`)) { // 打裂：加裂缝
          const cx = x * TSZ + TSZ / 2;
          const cy = y * TSZ + TSZ / 2;
          ctx.strokeStyle = 'rgba(30,18,6,0.85)';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(cx - TSZ * 0.18, cy - TSZ * 0.24);
          ctx.lineTo(cx - TSZ * 0.02, cy - TSZ * 0.02);
          ctx.lineTo(cx - TSZ * 0.12, cy + TSZ * 0.2);
          ctx.moveTo(cx - TSZ * 0.02, cy - TSZ * 0.02);
          ctx.lineTo(cx + TSZ * 0.2, cy + TSZ * 0.06);
          ctx.stroke();
        }
      }
    }
  }
  // 炸弹（黑色圆雷 + 引信倒数，对双方可见）
  if (f.bombs) {
    for (const b of f.bombs) {
      const px = b.x * TSZ + TSZ / 2;
      const py = b.y * TSZ + TSZ / 2;
      ctx.fillStyle = '#1F2937';
      ctx.beginPath(); ctx.arc(px, py + 1.5, TSZ * 0.27, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(24,20,12,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py + 1.5, TSZ * 0.27, 0, 7); ctx.stroke();
      ctx.strokeStyle = '#8B5A2B';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px + 2, py - TSZ * 0.2); ctx.quadraticCurveTo(px + 6, py - TSZ * 0.42, px + 10, py - TSZ * 0.34); ctx.stroke();
      const left = Math.max(0, RULES.bombFuse - (curT - b.t0));
      ctx.fillStyle = '#FFE38F';
      ctx.font = `bold ${Math.round(TSZ * 0.34)}px Menlo, monospace`;
      ctx.fillText(String(left), px - TSZ * 0.1, py + TSZ * 0.14);
    }
  }
  // 星星
  for (const s of f.field) drawStarShape(s.x * TSZ + TSZ / 2, s.y * TSZ + TSZ / 2, TSZ * 0.34, COLOR.star);
  // 弹道（逐 tick 插值飞行：出膛→终点按 2 格/tick 推进，终结后拖尾渐隐 2 拍）
  if (shots) {
    for (const s of shots) {
      if (curT < s.t0 || curT > s.t1 + 2) continue;
      const dur = Math.max(1, s.t1 - s.t0);
      const prog = Math.min(1, (curT - s.t0) / dur);
      const bx = s.x0 + (s.x1 - s.x0) * prog;
      const by = s.y0 + (s.y1 - s.y0) * prog;
      const a = curT <= s.t1 ? 0.7 : 0.7 * (1 - (curT - s.t1) / 3);
      ctx.strokeStyle = s.who === 0 ? `rgba(63,98,30,${a})` : `rgba(140,42,85,${a})`;
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(s.x0 * TSZ + TSZ / 2, s.y0 * TSZ + TSZ / 2);
      ctx.lineTo(bx * TSZ + TSZ / 2, by * TSZ + TSZ / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (curT <= s.t1) { // 在飞弹丸本体
        ctx.fillStyle = 'rgba(40,30,14,0.95)';
        ctx.beginPath(); ctx.arc(bx * TSZ + TSZ / 2, by * TSZ + TSZ / 2, 3.2, 0, 7); ctx.fill();
      }
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
    if (f.frozen && f.frozen[i] > 0) { // 冰冻蓝圈
      ctx.strokeStyle = 'rgba(96,165,250,0.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(px, py, TSZ * 0.62, 0, 7); ctx.stroke();
    }
    if (f.shield && f.shield[i]) { // 护盾金圈
      ctx.strokeStyle = 'rgba(255,201,60,0.9)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(px, py, TSZ * 0.74, 0, 7); ctx.stroke();
    }
    if (f.poison && f.poison[i] > 0) { // 中毒绿泡
      ctx.fillStyle = 'rgba(74,222,128,0.9)';
      ctx.beginPath(); ctx.arc(px + TSZ * 0.34, py - TSZ * 0.42, 3.5, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(px + TSZ * 0.18, py - TSZ * 0.55, 2.2, 0, 7); ctx.fill();
    }
    drawHpBar(px, py, f.hp[i] / RULES.hp, f.hp[i] <= 30 ? '#E05252' : '#3FA34D');
    // 名牌药丸（参照原作红/蓝名牌徽章）
    ctx.font = 'bold 10px "PingFang SC", Menlo, sans-serif';
    const tag = `P${i + 1} ${names[i]}${cloaked ? ' 隐身中…' : ''} ★${f.held[i]}`;
    const tw = ctx.measureText(tag).width + 12;
    const bx = Math.min(Math.max(px - tw / 2, 2), map.width * TSZ - tw - 2);
    const by = py + TSZ * 0.68;
    ctx.fillStyle = i === 0 ? 'rgba(61,94,30,0.92)' : 'rgba(140,42,85,0.92)';
    rrect(bx, by, tw, 14, 7);
    ctx.fill();
    ctx.fillStyle = '#FFF8E7';
    ctx.fillText(tag, bx + 6, by + 10.5);
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
      } else if (sp.kind === 'boom') { // 炸弹爆炸格闪光
        ctx.fillStyle = `rgba(249,115,22,${a * 0.75})`;
        rrect(sp.x * TSZ + 2.5, sp.y * TSZ + 2.5, TSZ - 5, TSZ - 5, 6);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,201,60,${a})`;
        ctx.lineWidth = 2;
        rrect(sp.x * TSZ + 2.5, sp.y * TSZ + 2.5, TSZ - 5, TSZ - 5, 6);
        ctx.stroke();
      } else if (sp.kind === 'shield') { // 护盾格挡闪光
        ctx.strokeStyle = `rgba(255,201,60,${a})`;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(px, py, TSZ * 0.7 + age * 3, 0, 7); ctx.stroke();
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
      frozen: [0, 0], poison: [0, 0], shield: [false, false],
      facing: [0, Math.PI], dead: [false, false],
      field: previewMap.stars.slice(0, RULES.maxFieldStars ?? previewMap.stars.length),
      bombs: [], gone: new Set(), cracked: new Set(),
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
  guarded.skill = userSkill(); // 8 选 1：显式挂到脚本函数上（runMatch 按 .skill 取装备）
  const seedStr = seedInput.value.trim() || '1';
  const seed = seedFromString(seedStr);
  const oppKey = oppSelect.value;
  const opp = ROSTER.find((r) => r.key === oppKey) || ROSTER[0];
  // 地图与对局同源：预置图按选择取，随机图与 seed 同源；先取图再喂给 runMatch，保证渲染的就是对局用图
  const map = makeMap(seed);
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
    const gfn = guardWrap(fn, box);
    gfn.skill = userSkill();
    parts.push({ key: '__user__', tank: `我的坦克 v${curVersion}`, style: '自定义', fn: gfn, me: true, elo: 1200, w: 0, d: 0, g: 0 });
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
if (skillSel) skillSel.addEventListener('change', scheduleLadder);
if (mapSel) mapSel.addEventListener('change', () => {
  // 切图立即生效：回到预览态，下一局按新图开战
  match = null;
  setPlaying(false);
  cur = 0;
  acc = 0;
  previewMap = makeMap(seedFromString(seedInput.value.trim() || '1'));
  setupCanvas(previewMap);
});
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
if (qp.get('map') && mapSel && [...mapSel.options].some((o) => o.value === qp.get('map'))) {
  mapSel.value = qp.get('map'); // ?map=id 直达预置图（可分享/截图复现）
}
footSeed.textContent = `deterministic · seed=${seedInput.value.trim()}`;
previewMap = makeMap(seedFromString(seedInput.value));
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
