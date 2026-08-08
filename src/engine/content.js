// UGC 内容注册表：地图 / 技能 / 道具 / 流派 bot 四类用户内容的定义、校验、
// 序列化与三阶段生命周期（private 私有 → shared 分享 → official 官方收录）。
//
// 设计铁律：
// - 内容定义是**纯 JSON**（bot 的 decide 源码也是字符串），因此内容包可以整包
//   嵌进战报——阶段2 的「凭战报重现整场战斗」由此成立（同 seed + 同 pack ⇒ 逐字节一致）。
// - 技能/道具不允许任意代码，只能对既有**效果原语**参数化（数值有界），
//   保证确定性与平衡可审计；流派 bot 走与用户脚本同一沙箱（new Function），引擎本体零 eval。
import { mapFromAscii, isWalkable } from './map.js';

export const STAGES = ['private', 'shared', 'official'];

// 效果原语（引擎 castSkill/pickupItem 按 kind 分发）：新技能/新道具 = 原语 + 自定义参数
export const SKILL_EFFECTS = ['shield', 'freeze', 'stun', 'overload', 'cloak', 'poison', 'teleport', 'boost'];
export const ITEM_EFFECTS = ['heal', 'rapid', 'pierce', 'shield', 'freeze', 'boost'];

const ID_RE = /^[a-z][a-zA-Z0-9_-]{1,23}$/;
const MAP_CHARS = /^[#Dg*AB.=~]+$/;
const LIMITS = {
  cd: [10, 300], dur: [1, 60], dmg: [1, 15], heal: [5, 60],
  shots: [1, 6], bonus: [1, 30], codeMax: 4000, nameMax: 24, descMax: 60,
  mapMin: 5, mapMax: 25,
};

function num(v, [lo, hi]) {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
}

function validateMapDef(def, errs) {
  const rows = def.rows;
  if (!Array.isArray(rows) || rows.length < LIMITS.mapMin || rows.length > LIMITS.mapMax) {
    errs.push(`地图行数需在 ${LIMITS.mapMin}~${LIMITS.mapMax} 之间`);
    return;
  }
  const w = rows[0].length;
  if (w < LIMITS.mapMin || w > LIMITS.mapMax) { errs.push(`地图列数需在 ${LIMITS.mapMin}~${LIMITS.mapMax} 之间`); return; }
  for (const r of rows) {
    if (typeof r !== 'string' || r.length !== w) { errs.push('地图各行宽度必须一致'); return; }
    if (!MAP_CHARS.test(r)) { errs.push('地图含非法字符（合法：# D g * A B . = ~）'); return; }
  }
  const h = rows.length;
  for (let x = 0; x < w; x++) {
    if (rows[0][x] !== '#' || rows[h - 1][x] !== '#') { errs.push('地图四周必须封墙'); return; }
  }
  for (let y = 0; y < h; y++) {
    if (rows[y][0] !== '#' || rows[y][w - 1] !== '#') { errs.push('地图四周必须封墙'); return; }
  }
  const flat = rows.join('');
  const countA = (flat.match(/A/g) || []).length;
  const countB = (flat.match(/B/g) || []).length;
  if (countA !== 1 || countB !== 1) { errs.push('地图必须恰好各有一个 A/B 出生点'); return; }
  let map;
  try { map = mapFromAscii(rows); } catch (e) { errs.push(`地图解析失败：${e.message}`); return; }
  // BFS 连通性：A→B、A→每颗星必须可达
  const seen = new Set([`${map.spawns[0].x},${map.spawns[0].y}`]);
  const q = [map.spawns[0]];
  while (q.length) {
    const { x, y } = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + dx},${y + dy}`;
      if (!seen.has(k) && isWalkable(map, x + dx, y + dy)) { seen.add(k); q.push({ x: x + dx, y: y + dy }); }
    }
  }
  if (!seen.has(`${map.spawns[1].x},${map.spawns[1].y}`)) errs.push('A/B 出生点必须连通');
  for (const s of map.stars) {
    if (!seen.has(`${s.x},${s.y}`)) errs.push(`星星 (${s.x},${s.y}) 必须可达`);
  }
}

// 校验单条内容定义；返回 { ok, errors }（错误原因中文，供工坊 UI 直接展示）
export function validateContent(def) {
  const errs = [];
  if (!def || typeof def !== 'object') return { ok: false, errors: ['内容定义必须是对象'] };
  if (!['map', 'skill', 'item', 'bot'].includes(def.type)) errs.push('未知内容类型（只支持 map/skill/item/bot）');
  if (typeof def.id !== 'string' || !ID_RE.test(def.id)) errs.push('id 需为 2~24 位小写字母开头的英数串');
  if (typeof def.name !== 'string' || !def.name.length || def.name.length > LIMITS.nameMax) errs.push(`name 必填且不超过 ${LIMITS.nameMax} 字`);
  if (def.desc != null && (typeof def.desc !== 'string' || def.desc.length > LIMITS.descMax)) errs.push(`desc 不超过 ${LIMITS.descMax} 字`);
  if (def.stage != null && !STAGES.includes(def.stage)) errs.push('stage 只能是 private/shared/official');
  if (errs.length) return { ok: false, errors: errs };
  switch (def.type) {
    case 'map':
      validateMapDef(def, errs);
      break;
    case 'skill': {
      if (!num(def.cd, LIMITS.cd)) errs.push(`技能 cd 需在 ${LIMITS.cd[0]}~${LIMITS.cd[1]} tick 之间`);
      const e = def.effect;
      if (!e || !SKILL_EFFECTS.includes(e.kind)) errs.push(`技能效果原语只能是：${SKILL_EFFECTS.join('/')}`);
      else {
        if (['freeze', 'stun', 'poison', 'cloak', 'boost'].includes(e.kind) && !num(e.dur, LIMITS.dur)) errs.push(`该原语需要 dur（${LIMITS.dur[0]}~${LIMITS.dur[1]} tick）`);
        if (e.kind === 'poison' && !num(e.dmg, LIMITS.dmg)) errs.push(`poison 需要 dmg（${LIMITS.dmg[0]}~${LIMITS.dmg[1]}/tick）`);
      }
      break;
    }
    case 'item': {
      const e = def.effect;
      if (!e || !ITEM_EFFECTS.includes(e.kind)) errs.push(`道具效果原语只能是：${ITEM_EFFECTS.join('/')}`);
      else {
        if (e.kind === 'heal' && !num(e.heal, LIMITS.heal)) errs.push(`heal 需要 heal（${LIMITS.heal[0]}~${LIMITS.heal[1]} HP）`);
        if (['rapid', 'pierce'].includes(e.kind) && !num(e.shots, LIMITS.shots)) errs.push(`该原语需要 shots（${LIMITS.shots[0]}~${LIMITS.shots[1]} 发）`);
        if (e.kind === 'pierce' && !num(e.bonus, LIMITS.bonus)) errs.push(`pierce 需要 bonus（${LIMITS.bonus[0]}~${LIMITS.bonus[1]} 伤害）`);
        if (['freeze', 'boost'].includes(e.kind) && !num(e.dur, LIMITS.dur)) errs.push(`该原语需要 dur（${LIMITS.dur[0]}~${LIMITS.dur[1]} tick）`);
      }
      break;
    }
    case 'bot': {
      if (typeof def.code !== 'string' || !def.code.trim()) errs.push('bot 需要 decide 源码 code');
      else if (def.code.length > LIMITS.codeMax) errs.push(`bot 代码超长（上限 ${LIMITS.codeMax} 字符）`);
      else if (!/function\s+decide\s*\(|export\s+default\s+function/.test(def.code)) errs.push('bot 代码需定义 decide(api) 入口');
      if (def.skill != null && typeof def.skill !== 'string') errs.push('bot 默认技能 skill 需为字符串');
      break;
    }
    default:
      break;
  }
  return { ok: errs.length === 0, errors: errs };
}

// ===== 内容包（分享/嵌战报的最小单位） =====
export function makePack(entries, meta = {}) {
  const out = [];
  for (const def of entries) {
    const r = validateContent(def);
    if (!r.ok) throw new Error(`内容包校验失败（${def && def.id}）：${r.errors.join('；')}`);
    out.push({ stage: 'private', ...def });
  }
  const ids = new Set();
  for (const e of out) {
    const key = `${e.type}:${e.id}`;
    if (ids.has(key)) throw new Error(`内容包校验失败：${key} 重复`);
    ids.add(key);
  }
  return { formatVersion: 1, author: meta.author ?? null, entries: out };
}

// base64(UTF-8 JSON)：Node 与浏览器双端可用，串可贴聊天框/进 URL
function toB64(s) {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'utf8').toString('base64');
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function fromB64(s) {
  if (typeof Buffer !== 'undefined') return Buffer.from(s, 'base64').toString('utf8');
  return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}

export function serializePack(pack) {
  return `atpack1.${toB64(JSON.stringify(pack))}`;
}

export function parsePack(str) {
  if (typeof str !== 'string' || !str.startsWith('atpack1.')) throw new Error('内容包分享串格式不对（应以 atpack1. 开头）');
  let obj;
  try { obj = JSON.parse(fromB64(str.slice('atpack1.'.length))); } catch { throw new Error('内容包分享串解码失败'); }
  if (!obj || obj.formatVersion !== 1 || !Array.isArray(obj.entries)) throw new Error('内容包结构不对（formatVersion/entries）');
  for (const def of obj.entries) {
    const r = validateContent(def);
    if (!r.ok) throw new Error(`内容包校验失败（${def && def.id}）：${r.errors.join('；')}`);
  }
  return obj;
}

// ===== 三阶段生命周期 =====
export function promoteStage(entry) {
  const cur = entry.stage ?? 'private';
  const i = STAGES.indexOf(cur);
  if (i < 0) throw new Error(`未知阶段：${cur}`);
  if (cur === 'official') throw new Error('已是 official（官方收录），不可再晋升');
  return { ...entry, stage: STAGES[i + 1] };
}

// ===== 消费侧工具 =====
// 取内容包里的地图（转成引擎地图对象；每次全新对象，防模板污染）
export function resolvePackMap(pack, id) {
  const def = (pack?.entries || []).find((e) => e.type === 'map' && e.id === id);
  return def ? mapFromAscii(def.rows) : null;
}

// 编译流派 bot（与网页用户脚本同一沙箱口径：new Function，宿主 CSP 禁 eval 时由上层降级）
export function compileBot(def) {
  const r = validateContent(def);
  if (!r.ok || def.type !== 'bot') throw new Error(`bot 定义非法：${(r.errors || ['类型不对']).join('；')}`);
  const src = def.code.replace(/export\s+default\s+/, 'return ');
  let fn;
  try {
    const factory = new Function(`"use strict";\n${src}\n;return (typeof decide === 'function' ? decide : undefined);`);
    fn = factory();
  } catch (e) {
    throw new Error(`bot 代码编译失败：${e.message}`);
  }
  if (typeof fn !== 'function') throw new Error('bot 代码未提供 decide(api) 入口');
  const bot = (api) => fn(api);
  bot.skill = def.skill ?? 'shield';
  bot.contentId = def.id;
  return bot;
}

// ===== 阶段3：官方收录列表（与内置内容同权；收录 = 在此追加条目并随版本发布） =====
export const OFFICIAL_CONTENT = [
  {
    type: 'map',
    id: 'canyon',
    name: '峡谷对冲',
    desc: '社区收录：中央长墙对冲图',
    stage: 'official',
    rows: [
      '###########',
      '#A...g....#',
      '#..D...D..#',
      '#....#....#',
      '#.*..#..*.#',
      '#....#....#',
      '#..D...D..#',
      '#....g...B#',
      '###########',
    ],
  },
  {
    type: 'skill',
    id: 'blink',
    name: '短传闪现',
    desc: '社区收录：低冷却小传送',
    stage: 'official',
    cd: 60,
    effect: { kind: 'teleport' },
  },
  {
    type: 'item',
    id: 'adrenaline',
    name: '肾上腺素',
    desc: '社区收录：短疾跑针剂',
    stage: 'official',
    effect: { kind: 'boost', dur: 6 },
  },
  {
    type: 'bot',
    id: 'sentinel',
    name: '哨戒流',
    desc: '社区收录：原地架炮见人就打',
    stage: 'official',
    skill: 'shield',
    code: 'export default function decide(api) {\n  if (api.enemyVisible() && api.canFire()) return api.fireAt(api.enemy());\n  if (!api.enemyVisible() && api.ready()) return api.useSkill();\n  return null;\n}',
  },
];
