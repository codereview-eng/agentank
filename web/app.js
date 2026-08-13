// AgenTank 网页端 UI：本地跑引擎对战 + canvas 逐 tick 回放 + 实时战报 + 天梯。
// 开发版经 <script type="module"> 加载；发布版由 scripts/build-web.mjs 去 import/export 内联进单文件。
import { runMatch, generateMap, mulberry32, renderText, RULES, TILE, PRESET_MAPS, presetMap, validateContent, makePack, serializePack, parsePack, promoteStage, resolvePackMap, compileBot, OFFICIAL_CONTENT } from '../src/engine/index.js';
import { bots } from '../bots/index.js';
import { LOCALES, LANGS, fmt, resolveLang } from './i18n.js';
import { initPlay, skillCodeMismatch, buildTankPayload, migrateLocalSave, upsertLocalTank, reconcileLogin, nextTankName } from './play.js';

// ---------- i18n：?lang= > localStorage > 浏览器语言 > zh ----------
const storedLang = (() => { try { return localStorage.getItem('agentank-lang'); } catch { return null; } })();
const LANG = resolveLang(new URLSearchParams(location.search).get('lang'), storedLang, navigator.language);
const L = LOCALES[LANG];
const T = (path, vars) => fmt(path.split('.').reduce((o, k) => o[k], L), vars);
document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
document.title = L.ui.title;
// 静态节点按 data-i18n="ui.key" 批量替换（切语言 = 存偏好 + 带参刷新，战报按新语言重建）
for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = T(el.dataset.i18n);
for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = T(el.dataset.i18nTitle);
for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = T(el.dataset.i18nPh);
// 语言切换器：写偏好 → 以 ?lang= 刷新（种子/地图等参数保留，回放战报按新语言重建）
{
  const langSel = document.getElementById('langSel');
  if (langSel) {
    langSel.value = LANG;
    langSel.addEventListener('change', () => {
      try { localStorage.setItem('agentank-lang', langSel.value); } catch { /* 忽略 */ }
      const url = new URL(location.href);
      url.searchParams.set('lang', langSel.value);
      location.href = url.toString();
    });
  }
}

const $id = (s) => document.getElementById(s);
const editorEl = $id('editor');
const oppSelect = $id('opp');
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
// 技能/判定链/道具文案全部走当前语言字典（键位对齐由 tests/i18n.test.js 锁死）
const SKILL_CN = L.skill;
const REASON_CN = L.reason;
const ITEM_CN = L.item;
const skillSel = $id('skillSel');
const userSkill = () => (skillSel ? skillSel.value : 'teleport');
// 技能下拉按当前语言渲染（默认项标注「8 选 1」）
if (skillSel) {
  for (const o of skillSel.options) {
    o.textContent = o.value === 'teleport'
      ? T('ui.skillOption', { skill: SKILL_CN[o.value] ?? o.value })
      : (SKILL_CN[o.value] ?? o.value);
  }
}

// ---------- 地图选择（10 张预置图 + 默认随机图） ----------
const mapSel = $id('mapSel');
if (mapSel) {
  for (const m of PRESET_MAPS) {
    const o = document.createElement('option');
    o.value = m.id;
    const mm = L.maps[m.id] || m; // 词条缺失时回落引擎中文（键位对齐由测试锁死，正常不触发）
    o.textContent = T('ui.mapOption', { name: mm.name, desc: mm.desc });
    mapSel.appendChild(o);
  }
}
const userMapKey = () => (mapSel ? mapSel.value : 'random');
// 取当前对局用图：预置图按 id 取（每次全新对象），默认走种子随机生成
function makeMap(seed) {
  const key = userMapKey();
  if (key !== 'random') {
    if (key.startsWith('pack:')) { // 工坊/官方地图：从活动内容包取（每次全新对象）
      const pm = resolvePackMap(PACK, key.slice(5));
      if (pm) return pm;
    }
    const m = presetMap(key);
    if (m) return m;
  }
  return generateMap(mulberry32(seed));
}

// ---------- 默认脚本（效果稿同款） ----------
const DEFAULT_SCRIPT = L.script.default + '\n'; // 注释随语言切换，代码语义两语言逐行一致

// ---------- 内置天梯阵容 ----------
const ROSTER = [
  { key: 'stealth', tank: L.bots.stealth.tank, style: L.bots.stealth.style, fn: bots.stealth },
  { key: 'starGrabber', tank: L.bots.starGrabber.tank, style: L.bots.starGrabber.style, fn: bots.starGrabber },
  { key: 'camper', tank: L.bots.camper.tank, style: L.bots.camper.style, fn: bots.camper },
  { key: 'brawler', tank: L.bots.brawler.tank, style: L.bots.brawler.style, fn: bots.brawler },
];
const LADDER_SEEDS = [11, 22, 33, 44, 55];
// 对手下拉初始文案按当前语言渲染（天梯实算完成后由 renderLadder 再补 ELO）
for (const r of ROSTER) {
  const opt = oppSelect && oppSelect.querySelector(`option[value="${r.key}"]`);
  if (opt) opt.textContent = T('ladder.oppOptionBoot', { style: r.style, skill: SKILL_CN[r.fn.skill] ?? r.fn.skill });
}

// ---------- 创作工坊（UGC 三阶段：私有 → 分享 → 官方收录） ----------
// 阶段1：内容存服务器端账号名下（Workshop 实体，登录后 CRUD），仅自己可见可测；未登录只能内存暂存；
// 阶段2：生成分享串/链接（内容包整包嵌进战报参数），任何人打开即确定性重现整场战斗；
// 阶段3：官方收录进 OFFICIAL_CONTENT（引擎侧列表），与内置地图/技能/道具/流派同权使用。
const WS_KEY = 'agentank-workshop'; // 旧本机存档 key：只用于登录后一次性迁移上云，不再写入
const b64e = (s) => btoa(unescape(encodeURIComponent(s)));
const b64d = (s) => decodeURIComponent(escape(atob(s)));
// 工坊内容只存服务器端（Workshop 实体，登录后由 play.js 注入云端后端）；
// 未登录仅内存暂存（?pack= 导入照样能玩，刷新即丢），保存/删除的持久化只发生在云端。
let wsEntries = [];
let wsCloud = null; // { save(entry), remove(entry) }；null = 未登录
let wsCloudFail = null; // 云端写失败的 UI 提示（工坊块内赋值：showWs 在块里）
const wsPersist = (entry, removed) => { // 单条变更上云；未登录时为内存态，静默跳过
  if (!wsCloud || !entry) return;
  (removed ? wsCloud.remove(entry) : wsCloud.save(entry))
    .catch((e) => wsCloudFail?.(String((e && e.message) || e)));
};
// 活动内容包 = 官方收录 + 我的/导入（type:id 去重，官方优先不可被顶替；坏存量跳过不拖垮整包）
function buildPack() {
  const seen = new Set();
  const entries = [];
  for (const e of [...OFFICIAL_CONTENT, ...wsEntries]) {
    const k = `${e.type}:${e.id}`;
    if (seen.has(k) || !validateContent(e).ok) continue;
    seen.add(k);
    entries.push(e);
  }
  return makePack(entries);
}
let PACK = buildPack();
const packName = (type, id) => PACK.entries.find((e) => e.type === type && e.id === id)?.name ?? null;
const skillLabel = (id) => SKILL_CN[id] ?? packName('skill', id) ?? id;
const itemLabel = (id) => ITEM_CN[id] ?? packName('item', id) ?? id;
const stageTag = (e) => T(`ui.stage_${e.stage || 'private'}`);

// 三来源下拉合并：内置 + 官方收录 + 我的/导入（带阶段徽标；重建时先清旧注入项、保住当前选择）
function injectPackOptions() {
  const refill = (sel, type, mk) => {
    if (!sel) return;
    const cur = sel.value;
    for (const o of [...sel.options]) if (o.dataset.pack) o.remove();
    for (const d of PACK.entries.filter((e) => e.type === type)) {
      const o = document.createElement('option');
      Object.assign(o, mk(d));
      o.dataset.pack = '1';
      sel.appendChild(o);
    }
    if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
  };
  refill(mapSel, 'map', (d) => ({ value: `pack:${d.id}`, textContent: `${stageTag(d)} ${d.name}（${d.desc || d.id}）` }));
  refill(skillSel, 'skill', (d) => ({ value: d.id, textContent: `${stageTag(d)} ${d.name}` }));
  refill(oppSelect, 'bot', (d) => ({ value: `pack:${d.id}`, textContent: `${stageTag(d)} ${d.name}` }));
}

// 工坊 UI：模板/校验保存/列表/分享/导入/分享本局
const WS_TPL = {
  map: { type: 'map', id: 'mymap', name: LANG === 'zh' ? '我的地图' : 'My Map', desc: '', rows: ['#########', '#A..g...#', '#..DD...#', '#...*...#', '#..~~...#', '#...=...#', '#.......#', '#...g..B#', '#########'] },
  skill: { type: 'skill', id: 'myskill', name: LANG === 'zh' ? '我的技能' : 'My Skill', cd: 60, effect: { kind: 'freeze', dur: 6 } },
  item: { type: 'item', id: 'myitem', name: LANG === 'zh' ? '我的道具' : 'My Item', effect: { kind: 'heal', heal: 25 } },
  bot: { type: 'bot', id: 'mybot', name: LANG === 'zh' ? '我的流派' : 'My Style', skill: 'shield', code: 'export default function decide(api) {\n  if (api.enemyVisible() && api.canFire()) return api.fireAt(api.enemy());\n  return api.patrol();\n}' },
};
let wsImportPack = null; // ?pack= 深链复用（在下方工坊模块内赋值）
let wsConnectCloud = null; // 登录后由 play.js 调用：注入云端 CRUD、灌云端数据、迁移旧本机存量
{
  const wsEd = $id('wsEditor');
  const wsMsg = $id('wsErr');
  const wsListEl = $id('wsList');
  const wsOut = $id('wsShareOut');
  const showWs = (msg, bad) => { if (wsMsg) { wsMsg.textContent = msg; wsMsg.style.color = bad ? '#f85149' : '#7ee787'; } };
  const emitShare = (url) => {
    if (wsOut) wsOut.value = url;
    try { navigator.clipboard?.writeText(url); } catch { /* 忽略 */ }
    showWs(T('ui.wsShared'), false);
  };
  const refresh = () => { PACK = buildPack(); injectPackOptions(); renderWsList(); scheduleLadder(); };
  let wsFilter = 'all'; // 浏览筛选：全部 / map / skill / item / bot
  const equipEntry = (e) => { // 「装备」= 工坊页一键接回对战页下拉（订阅即用）
    if (e.type === 'map' && mapSel) mapSel.value = `pack:${e.id}`;
    else if (e.type === 'skill' && skillSel) { skillSel.value = e.id; refreshSkillHint(); }
    else if (e.type === 'bot' && oppSelect) oppSelect.value = `pack:${e.id}`;
    else { showWs(T('ui.wsEquipNa'), false); return; } // item：随对局物资刷新出现，无需装备
    scheduleLadder();
    showWs(T('ui.wsEquipped', { name: e.name }), false);
  };
  function renderWsFilter() {
    const row = $id('wsFilterRow');
    if (!row) return;
    row.innerHTML = '';
    for (const t of ['all', 'map', 'skill', 'item', 'bot']) {
      const b = document.createElement('button');
      b.className = 'btn ghost';
      b.style.cssText = 'padding:1px 10px;font-size:11px;min-width:0' + (wsFilter === t ? ';border-color:var(--p1);color:var(--p1)' : '');
      b.textContent = t === 'all' ? T('ui.wsFilterAll') : t;
      b.addEventListener('click', () => { wsFilter = t; renderWsList(); });
      row.appendChild(b);
    }
  }
  function renderWsList() {
    if (!wsListEl) return;
    wsListEl.innerHTML = '';
    renderWsFilter();
    const inFilter = (e) => wsFilter === 'all' || e.type === wsFilter;
    const addHdr = (key) => {
      const h = document.createElement('div');
      h.style.cssText = 'font-size:11px;color:var(--dim);margin:6px 0 2px';
      h.textContent = T(key);
      wsListEl.appendChild(h);
    };
    // 卡片 = 元数据即预览（名称/阶段/类型/描述/地图 ASCII），不用先装备就能看清是什么
    const addCard = (e, mine) => {
      const card = document.createElement('div');
      card.style.cssText = 'border:1px solid var(--line);border-radius:8px;padding:8px;margin:6px 0';
      const top = document.createElement('div');
      top.style.cssText = 'display:flex;gap:6px;align-items:center';
      const label = document.createElement('span');
      label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px';
      label.textContent = `${stageTag(e)} ${e.name}`;
      top.appendChild(label);
      const typeTag = document.createElement('span');
      typeTag.style.cssText = 'font-size:10px;color:var(--dim)';
      typeTag.textContent = `${e.type}/${e.id}`;
      top.appendChild(typeTag);
      card.appendChild(top);
      if (e.desc) {
        const d = document.createElement('div');
        d.style.cssText = 'font-size:11px;color:var(--muted);margin-top:2px';
        d.textContent = e.desc;
        card.appendChild(d);
      }
      if (e.type === 'map' && Array.isArray(e.rows)) {
        const pre = document.createElement('pre');
        pre.style.cssText = 'font-size:10px;line-height:1.25;color:var(--dim);margin:4px 0 0;overflow:auto';
        pre.textContent = e.rows.join('\n');
        card.appendChild(pre);
      }
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;margin-top:6px';
      const mkBtn = (text, fn) => {
        const b = document.createElement('button');
        b.className = 'btn ghost';
        b.style.cssText = 'padding:1px 8px;font-size:11px;min-width:0';
        b.textContent = text;
        b.addEventListener('click', fn);
        btns.appendChild(b);
      };
      mkBtn(T('ui.wsEquip'), () => equipEntry(e));
      if (mine) {
        mkBtn(T('ui.wsShare'), () => { // 分享 = 阶段1→2（私有先晋升），生成 ?pack= 链接
          const idx = wsEntries.indexOf(e);
          if ((e.stage ?? 'private') === 'private') { wsEntries[idx] = promoteStage(e); wsPersist(wsEntries[idx]); }
          const s = serializePack(makePack([wsEntries[idx]]));
          emitShare(`${location.origin}${location.pathname}?pack=${encodeURIComponent(s)}&lang=${LANG}`);
          refresh();
        });
        mkBtn(T('ui.wsDelete'), () => { wsEntries.splice(wsEntries.indexOf(e), 1); wsPersist(e, true); refresh(); });
      }
      card.appendChild(btns);
      wsListEl.appendChild(card);
    };
    addHdr('ui.wsMine');
    const mine = wsEntries.filter(inFilter);
    if (!mine.length) {
      const p = document.createElement('div');
      p.style.cssText = 'font-size:11px;color:var(--dim)';
      p.textContent = T('ui.wsEmpty');
      wsListEl.appendChild(p);
    } else for (const e of mine) addCard(e, true);
    addHdr('ui.wsOfficial');
    for (const e of OFFICIAL_CONTENT.filter(inFilter)) addCard(e, false);
  }
  function importPackStr(str, opts = {}) {
    const p = parsePack(String(str).trim()); // 校验失败会抛中文原因
    for (const e of p.entries) {
      const entry = { ...e, stage: 'shared' }; // 导入的内容一律记为阶段2（official 只能来自引擎收录列表）
      const i = wsEntries.findIndex((x) => x.type === e.type && x.id === e.id);
      if (i >= 0) wsEntries[i] = entry; else wsEntries.push(entry);
      wsPersist(entry); // 登录态：导入即入云端；未登录：内存暂存
    }
    refresh();
    if (!opts.silent) showWs(`${T('ui.wsImported')} ×${p.entries.length}`, false);
    return p.entries.length;
  }
  wsImportPack = importPackStr; // 供 ?pack= 深链复用
  wsCloudFail = (msg) => showWs(T('ui.wsCloudFail', { msg }), true);
  wsConnectCloud = async (cloud) => { // 登录成功：云端 Workshop 成为唯一事实源
    wsCloud = { save: cloud.save, remove: cloud.remove };
    wsEntries = (cloud.entries || []).slice();
    // 旧本机 localStorage 存量一次性搬上云；全部成功才清本机 key（失败留着下次登录重试）
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(WS_KEY) || '[]'); } catch { /* 忽略 */ }
    let moved = 0, failed = false;
    for (const e of Array.isArray(legacy) ? legacy : []) {
      if (!e || !e.type || !e.id) continue;
      if (wsEntries.some((x) => x.type === e.type && x.id === e.id)) continue; // 云端已有同名：云端优先
      try { await cloud.save(e); wsEntries.push(e); moved += 1; } catch { failed = true; }
    }
    if (!failed) { try { localStorage.removeItem(WS_KEY); } catch { /* 忽略 */ } }
    if (moved) showWs(T('ui.wsMigrated', { n: moved }), false);
    refresh();
  };
  $id('wsNewBtn')?.addEventListener('click', () => {
    if (wsEd) wsEd.value = JSON.stringify(WS_TPL[$id('wsTpl')?.value || 'map'], null, 2);
    showWs('', false);
  });
  $id('wsSaveBtn')?.addEventListener('click', () => {
    let def;
    try { def = JSON.parse(wsEd.value); } catch (e) { showWs(`JSON: ${e.message}`, true); return; }
    const r = validateContent(def);
    if (!r.ok) { showWs(r.errors.join('；'), true); return; }
    if (!wsCloud) { showWs(T('ui.wsLoginFirst'), true); return; } // 私有内容只存服务器端：未登录不落任何本机持久层
    const entry = { ...def, stage: 'private' }; // 保存/改动一律回私有：改完需重新分享（阶段1）
    const i = wsEntries.findIndex((e) => e.type === def.type && e.id === def.id);
    if (i >= 0) wsEntries[i] = entry; else wsEntries.push(entry);
    wsPersist(entry);
    showWs(T('ui.wsSaved'), false);
    refresh();
  });
  $id('wsImportBtn')?.addEventListener('click', () => {
    try { importPackStr($id('wsImport')?.value || ''); } catch (e) { showWs(String((e && e.message) || e), true); }
  });
  $id('wsShareBattleBtn')?.addEventListener('click', () => { // 阶段2：战报重现链接（种子+图+技能+对手+内容包+脚本 全嵌）
    if (!match) { showWs(T('ui.wsNoBattle'), true); return; }
    const u = new URL(location.origin + location.pathname);
    u.searchParams.set('pack', serializePack(match.result.content ?? PACK));
    u.searchParams.set('seed', match.seedStr);
    u.searchParams.set('map', userMapKey());
    u.searchParams.set('skill', userSkill());
    u.searchParams.set('opp', oppSelect.value);
    u.searchParams.set('script', b64e(editorEl.value));
    u.searchParams.set('lang', LANG);
    u.searchParams.set('autoplay', '1');
    emitShare(u.toString());
  });
  injectPackOptions();
  renderWsList();
}

// ---------- 工具 ----------
function seedFromString(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) s = '1';
  if (/^\d+$/.test(s) && s.length <= 10) return Number(s) >>> 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// 每局自动生成随机种子（玩家不可选）：记录进战报首行与页脚，?seed= 深链可复现回放。
// 熵源用 crypto.getRandomValues（引擎内仍全程种子 RNG，禁 Math.random）。
function genSeed() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return `${ymd}-${String(buf[0] % 100000).padStart(5, '0')}`;
}

// 默认脚本的预编译等价实现（托管环境 CSP 禁 eval 时的降级路径，语义与 DEFAULT_SCRIPT 逐行一致）
function defaultDecide(api) {
  const me = api.me();
  const star = api.nearestStar();
  if (api.enemyVisible() && api.canFire()) return api.fireAt(api.enemy());
  if (me.hp < 30 && api.ready()) return api.useSkill(api.safestCorner());
  return star ? api.moveTo(star) : api.patrol();
}

// 探测宿主是否允许 eval（run.ceo artifact 的 CSP 为 script-src 'unsafe-inline'，无 'unsafe-eval'）
const EVAL_OK = (() => { try { new Function(''); return true; } catch { return false; } })();

function compileScript(src) {
  if (!EVAL_OK) {
    if (String(src).replace(/\s+/g, '') === DEFAULT_SCRIPT.replace(/\s+/g, ''))
      return defaultDecide;
    throw new Error(T('err.cspEval'));
  }
  const m = src.match(/export\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
  const entry = m ? m[1] : 'decide';
  const code = String(src).replace(/export\s+default\s+/g, '');
  const factory = new Function(
    '"use strict";\n' + code +
    '\n;if (typeof ' + entry + ' === "function") return ' + entry + ';' +
    '\nthrow new Error(' + JSON.stringify(T('err.noEntry', { entry })) + ');'
  );
  const fn = factory();
  if (typeof fn !== 'function') throw new Error(T('err.noDecide'));
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

// ---------- 车库存储（多坦克，方案 v2） ----------
// 匿名期：坦克列表落本机 localStorage（agentank.save = {tanks:[{name,code,skill,v}],cur}，
// 旧单份 {code,v,n} 一次性迁移为「坦克1」）；登录后云端是坦克唯一的家（garage.mode='cloud'）。
const SAVE_KEY = 'agentank.save';
const DRAFT_KEY = 'agentank.draft'; // 草稿断电保护：未保存的编辑内容，≠ 坦克版本
const ARCHIVE_KEY = 'agentank.archive'; // 零丢失兜底：被覆盖/清理的代码进存档
const garage = { mode: 'local', tanks: [], cur: null, cloud: null };
const tankN = (n) => T('ui.tankN', { n });
const curTank = () => garage.tanks.find((t) => t.name === garage.cur) || null;
const myTankLabel = () => { const t = curTank(); return t ? `${t.name} v${t.v}` : `${L.ui.myTank} v1`; };

function readLocalStore() {
  try { return migrateLocalSave(localStorage.getItem(SAVE_KEY), tankN(1)); } catch { return { tanks: [], cur: null }; }
}
function writeLocalStore(s) {
  try {
    if (!s.tanks.length) localStorage.removeItem(SAVE_KEY);
    else localStorage.setItem(SAVE_KEY, JSON.stringify({ tanks: s.tanks, cur: s.cur }));
  } catch { /* file:// 或隐私模式下无 localStorage：忽略 */ }
}
function archiveCopy(t, from) {
  try {
    const arc = JSON.parse(localStorage.getItem(ARCHIVE_KEY) || '[]');
    arc.push({ name: t.name, code: t.code, skill: t.skill || '', v: t.v ?? 1, from, ts: Date.now() });
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(arc));
  } catch { /* 忽略 */ }
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* 忽略 */ } }
function applyTankToUi(t) { // 切台/入座：代码进编辑器、技能跟随（无该选项时保持现装备）
  editorEl.value = t ? t.code : DEFAULT_SCRIPT;
  if (t && t.skill && skillSel && [...skillSel.options].some((o) => o.value === t.skill)) skillSel.value = t.skill;
  refreshSkillHint();
}
function loadStore() {
  const s = readLocalStore();
  garage.tanks = s.tanks;
  garage.cur = s.cur;
  const t = curTank();
  if (t) applyTankToUi(t);
  try { // 草稿恢复：仅当仍是同一台坦克（含「尚无坦克」态）时才回填
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (d && typeof d.code === 'string' && d.code.trim() && (d.cur ?? null) === (garage.cur ?? null)) editorEl.value = d.code;
  } catch { /* 忽略 */ }
}
async function saveVersion() {
  const code = editorEl.value;
  const skill = userSkill();
  if (garage.mode === 'cloud') {
    try { compileScript(code); } catch (e) { garageMsg(T('play.compileFail', { msg: String((e && e.message) || e) }), true); return; }
    const t = curTank();
    try {
      if (t) {
        await garage.cloud.update(t.id, buildTankPayload({ name: t.name, code, skill, version: t.v + 1, is_active: t.active === true }));
      } else { // 云端第一台：命名即入库
        const name = askName(tankN(1));
        if (!name) return;
        await garage.cloud.create(buildTankPayload({ name, code, skill, version: 1, is_active: true }));
      }
      await reloadCloudGarage();
      garageMsg(T('play.saved', { v: curTank()?.v ?? 1 }));
    } catch (e) { garageMsg(T('play.saveFail', { msg: String((e && e.message) || e) }), true); return; }
  } else {
    const r = upsertLocalTank({ tanks: garage.tanks, cur: garage.cur }, { name: garage.cur || tankN(1), code, skill });
    garage.tanks = r.tanks;
    garage.cur = r.cur;
    writeLocalStore(garage);
  }
  clearDraft();
  updateVersionUi();
  renderGarage();
  scheduleLadder();
}
function updateVersionUi() {
  const t = curTank();
  saveBtn.textContent = t ? T('ui.save', { name: t.name, v: t.v + 1 }) : T('ui.saveFirst');
  editorTitle.textContent = T('ui.editorTitle', { name: myTankLabel() });
}

// ---------- 我的车库 UI（列表 / 切换出战 / 新建 / 重命名） ----------
const garageListEl = $id('garageList');
const garageMsgEl = $id('garageMsg');
const garageTitleEl = $id('garageTitle');
function garageMsg(msg, bad) { if (garageMsgEl) { garageMsgEl.textContent = msg || ''; garageMsgEl.style.color = bad ? 'var(--bad)' : 'var(--dim)'; } }
function askName(def, promptKey = 'ui.garageNewPrompt') { // 同一玩家内 name 唯一（前端校验）
  const name = (window.prompt(T(promptKey), def) || '').trim();
  if (!name) return null;
  if (garage.tanks.some((t) => t.name === name)) { garageMsg(T('ui.garageNameDup', { name }), true); return null; }
  return name;
}
async function reloadCloudGarage() {
  const g = await garage.cloud.list();
  garage.tanks = g.tanks;
  garage.cur = g.active ? g.active.name : null;
}
async function switchTank(name) {
  const t = garage.tanks.find((x) => x.name === name);
  if (!t || name === garage.cur) return;
  if (garage.mode === 'cloud') { // 出战切换：is_active 唯一标记
    try {
      const old = curTank();
      await garage.cloud.update(t.id, { is_active: true });
      if (old && old.id !== t.id) await garage.cloud.update(old.id, { is_active: false });
      await reloadCloudGarage();
    } catch (e) { garageMsg(T('play.saveFail', { msg: String((e && e.message) || e) }), true); return; }
  } else {
    garage.cur = name;
    writeLocalStore(garage);
  }
  applyTankToUi(curTank() || t);
  clearDraft();
  updateVersionUi();
  renderGarage();
  scheduleLadder();
}
async function newTank() {
  const def = nextTankName(garage.tanks.map((t) => t.name), tankN);
  const name = askName(def);
  if (!name) return;
  if (garage.mode === 'cloud') { // 登录态：新坦克直接建在云端（命名即入库，不再产生本地坦克）
    try {
      const old = curTank();
      await garage.cloud.create(buildTankPayload({ name, code: DEFAULT_SCRIPT, skill: userSkill(), version: 1, is_active: true }));
      if (old) await garage.cloud.update(old.id, { is_active: false });
      await reloadCloudGarage();
    } catch (e) { garageMsg(T('play.saveFail', { msg: String((e && e.message) || e) }), true); return; }
  } else {
    garage.tanks.push({ name, code: DEFAULT_SCRIPT, skill: userSkill(), v: 1 });
    garage.cur = name;
    writeLocalStore(garage);
  }
  applyTankToUi(curTank());
  clearDraft();
  updateVersionUi();
  renderGarage();
  scheduleLadder();
}
async function renameTank(name) {
  const t = garage.tanks.find((x) => x.name === name);
  if (!t) return;
  const name2 = askName(t.name, 'ui.garageRenamePrompt');
  if (!name2 || name2 === t.name) return;
  if (garage.mode === 'cloud') {
    try { await garage.cloud.update(t.id, { name: name2 }); await reloadCloudGarage(); }
    catch (e) { garageMsg(T('play.saveFail', { msg: String((e && e.message) || e) }), true); return; }
  } else {
    t.name = name2;
    if (garage.cur === name) garage.cur = name2;
    writeLocalStore(garage);
  }
  updateVersionUi();
  renderGarage();
}
function renderGarage() {
  if (garageTitleEl) garageTitleEl.textContent = garage.tanks.length ? T('ui.garageCount', { n: garage.tanks.length }) : T('ui.garage');
  if (!garageListEl) return;
  garageListEl.innerHTML = '';
  if (!garage.tanks.length) {
    const p = document.createElement('div');
    p.style.cssText = 'font-size:11px;color:var(--dim)';
    p.textContent = T('ui.garageEmpty');
    garageListEl.appendChild(p);
    return;
  }
  for (const t of garage.tanks) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:11px;margin:2px 0;color:var(--muted)';
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    const isCur = t.name === garage.cur;
    label.textContent = isCur ? `${t.name} v${t.v} · ${T('ui.garageActive')}` : `${t.name} v${t.v}`;
    if (isCur) label.style.color = 'var(--p1)';
    row.appendChild(label);
    const mkBtn = (text, fn) => {
      const b = document.createElement('button');
      b.className = 'btn ghost';
      b.style.cssText = 'padding:1px 8px;font-size:11px;min-width:0';
      b.textContent = text;
      b.addEventListener('click', fn);
      row.appendChild(b);
    };
    if (!isCur) mkBtn(T('ui.garageUse'), () => { switchTank(t.name); });
    mkBtn(T('ui.garageRename'), () => { renameTank(t.name); });
    garageListEl.appendChild(row);
  }
}

// ---------- 登录时刻衔接（方案 v2）：横幅流程 + 云端车库接管 ----------
const bridgeEl = $id('bridgeHint');
const bridgeText = $id('bridgeText');
const bridgeBtns = $id('bridgeBtns');
function bridgeShow(text, btns) {
  if (!bridgeEl) return;
  bridgeText.textContent = text;
  bridgeBtns.innerHTML = '';
  for (const b of btns) {
    const el = document.createElement('button');
    el.type = 'button';
    el.textContent = b.text;
    el.addEventListener('click', b.fn);
    bridgeBtns.appendChild(el);
  }
  bridgeEl.classList.add('show');
}
function bridgeHide() { if (bridgeEl) bridgeEl.classList.remove('show'); }
function dropLocal(names) { // 已衔接的本地匿名坦克出清（全部处理完 = 本地清零）
  if (!names.length) return;
  const s = readLocalStore();
  s.tanks = s.tanks.filter((t) => !names.includes(t.name));
  if (!s.tanks.some((t) => t.name === s.cur)) s.cur = s.tanks.length ? s.tanks[0].name : null;
  writeLocalStore(s);
}
function runBridge(r) { // 非阻断横幅队列：一键入库 → 冲突逐台二选一 → 完成语
  const steps = [];
  if (r.upload.length) steps.push({ kind: 'upload', tanks: r.upload });
  for (const c of r.conflicts) steps.push({ kind: 'conflict', local: c.local, cloud: c.cloud });
  const next = async () => {
    const s = steps.shift();
    if (!s) {
      if (!readLocalStore().tanks.length) bridgeShow(T('play.bridgeDone'), [{ text: T('play.bridgeCloseBtn'), fn: bridgeHide }]);
      else bridgeHide();
      return;
    }
    if (s.kind === 'upload') {
      const names = s.tanks.map((t) => t.name).join(LANG === 'zh' ? '、' : ', ');
      bridgeShow(T('play.bridgeFound', { n: s.tanks.length, names }), [{
        text: T('play.bridgeUploadBtn'),
        fn: async () => {
          const hasActive = garage.tanks.some((t) => t.active);
          try {
            for (let i = 0; i < s.tanks.length; i++) {
              const lt = s.tanks[i];
              await garage.cloud.create(buildTankPayload({
                name: lt.name, code: lt.code, skill: lt.skill,
                version: 1, is_active: !hasActive && i === 0, // 云端尚无出战坦克时，第一台顶上
              }));
            }
          } catch (e) { garageMsg(T('play.saveFail', { msg: String((e && e.message) || e) }), true); return; }
          dropLocal(s.tanks.map((t) => t.name));
          await reloadCloudGarage();
          updateVersionUi();
          renderGarage();
          garageMsg(T('play.bridgeUploaded', { n: s.tanks.length }));
          next();
        },
      }]);
      return;
    }
    // 冲突：同名不同码，二选一；另一份自动进本地存档，零丢失
    const finish = async (code) => {
      dropLocal([s.local.name]);
      await reloadCloudGarage();
      if (garage.cur === s.cloud.name) { editorEl.value = code; refreshSkillHint(); }
      updateVersionUi();
      renderGarage();
      garageMsg(T('play.bridgeArchived'));
      next();
    };
    bridgeShow(T('play.bridgeConflict', { name: s.local.name, v: s.cloud.v }), [
      {
        text: T('play.bridgeUseLocal', { v: s.cloud.v + 1 }),
        fn: async () => {
          archiveCopy(s.cloud, 'cloud');
          try {
            await garage.cloud.update(s.cloud.id, buildTankPayload({
              name: s.cloud.name, code: s.local.code, skill: s.local.skill || s.cloud.skill,
              version: s.cloud.v + 1, is_active: s.cloud.active === true,
            }));
          } catch (e) { garageMsg(T('play.saveFail', { msg: String((e && e.message) || e) }), true); return; }
          finish(s.local.code);
        },
      },
      { text: T('play.bridgeUseCloud', { v: s.cloud.v }), fn: () => { archiveCopy(s.local, 'local'); finish(s.cloud.code); } },
    ]);
  };
  next();
}
// 登录成功（play.js 调用）：车库切云端 + 登录时刻逐台按名字衔接
async function garageConnect(cloud) {
  const localTanks = readLocalStore().tanks;
  const g = await cloud.list(); // 失败则抛回 play.js 报状态，本地模式零回归
  garage.cloud = cloud;
  garage.mode = 'cloud';
  garage.tanks = g.tanks;
  garage.cur = g.active ? g.active.name : null;
  if (!localTanks.length) { // 场景 2：本地无匿名坦克 → 载入云端车库，恢复出战坦克
    const t = curTank();
    if (t) {
      applyTankToUi(t);
      clearDraft();
      garageMsg(T('play.garageLoaded', { n: garage.tanks.length, name: t.name, v: t.v }));
    } else {
      garageMsg(T('play.garageEmptyCloud'));
    }
  } else { // 场景 1/3：逐台按名字判定（编辑器不动，横幅引导，不阻塞开战）
    const r = reconcileLogin(localTanks, garage.tanks);
    dropLocal(r.synced); // 同名同码：视为已同步，静默出清
    runBridge(r);
  }
  updateVersionUi();
  renderGarage();
  scheduleLadder();
}
function resetForLogout() { // 场景 5：登出清空车库与编辑器（未入库的匿名坦克先进存档，零丢失）
  const s = readLocalStore();
  for (const t of s.tanks) archiveCopy(t, 'logout');
  writeLocalStore({ tanks: [], cur: null });
  clearDraft();
  editorEl.value = DEFAULT_SCRIPT;
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
  let items = [];              // 在场道具 [{x,y,kind}]
  let bombs = [];              // 在场炸弹 [{x,y,t0}]
  let zone = 0;                // 已收缩圈数（安全区 [1+zone, W-2-zone]）
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
        case 'move':
        case 'slide': { // 冰面滑行与移动同口径更新位置/朝向
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
        case 'star_gone':
          field = field.filter((s) => !(s.x === e.x && s.y === e.y));
          break;
        case 'item_spawn':
          items = items.concat([{ x: e.x, y: e.y, kind: e.kind }]);
          break;
        case 'item_pick':
          items = items.filter((s) => !(s.x === e.x && s.y === e.y));
          if (e.kind === 'medkit') hp[e.who] = e.hp; // 急救包回血
          sparks.push({ t, x: e.x, y: e.y, kind: 'tp' });
          break;
        case 'item_gone':
          items = items.filter((s) => !(s.x === e.x && s.y === e.y));
          break;
        case 'zone_shrink':
          zone = e.ring;
          break;
        case 'zone_hit':
          hp[e.target] = e.hp;
          sparks.push({ t, x: pos[e.target].x, y: pos[e.target].y, kind: 'hit' });
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
      facing: [...facing], dead: [...dead], zone,
      field, items, bombs, gone, cracked, // 均为 copy-on-write 新引用，即本 tick 快照
    });
  }
  return { frames, shots, sparks };
}

// ---------- 战报时间线（中文行 + 着色） ----------
// 坦克名是用户数据：凡进 innerHTML 一律先转义
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function buildLog(result, names, seedStr) {
  const held = [0, 0];
  const out = [];
  const nm = (i) => `<span class="${i === 0 ? 'p1' : 'p2'}">${esc(names[i])}</span>`;
  for (const e of result.events) {
    let html = null;
    switch (e.type) {
      case 'start':
        html = T('log.start', { w: e.width, h: e.height });
        if (seedStr) html += T('log.startSeed', { seed: seedStr });
        if (e.skills) html += T('log.startSkills', { n0: nm(0), n1: nm(1), s0: skillLabel(e.skills[0]), s1: skillLabel(e.skills[1]) });
        break;
      case 'goal':
        html = T(e.tag === 'star' ? 'log.moveStar' : e.tag === 'enemy' ? 'log.moveEnemy' : 'log.moveTo', { who: nm(e.who), x: e.x, y: e.y });
        break;
      case 'turn': html = T('log.turn', { who: nm(e.who), arrow: { '1,0': '→', '-1,0': '←', '0,1': '↓', '0,-1': '↑' }[e.dx + ',' + e.dy] ?? '' }); break;
      case 'fire': html = T('log.fire', { who: nm(e.who) }); break;
      case 'hit': html = T('log.hit', { who: nm(e.who), target: nm(e.target), dmg: e.dmg, hp: e.hp }); break;
      case 'bullet_end':
        if (e.reason === 'wall') html = T('log.bulletWall', { who: nm(e.who) });
        else if (e.reason === 'mound') html = T('log.bulletMound', { who: nm(e.who) });
        else if (e.reason === 'out') html = T('log.bulletOut', { who: nm(e.who) });
        break;
      case 'mound_hit':
        if (e.hp > 0) html = T('log.moundCrack', { x: e.x, y: e.y });
        break;
      case 'mound_destroyed': html = T('log.moundDestroyed', { x: e.x, y: e.y }); break;
      case 'bomb_place': html = T('log.bombPlace', { who: nm(e.who), x: e.x, y: e.y }); break;
      case 'bomb_explode': {
        const sep = LANG === 'zh' ? '、' : ', ';
        const lead = LANG === 'zh' ? '，' : ', ';
        const hits = (e.hits || []).map((h) => `${nm(h.who)} <span class="dmg">-${h.dmg}</span>`).join(sep);
        html = T('log.bombExplode', { x: e.x, y: e.y, cells: e.cells.length, hits: hits ? lead + hits : '' });
        break;
      }
      case 'shield_block': html = T(e.source === 'bomb' ? 'log.shieldBlockBomb' : 'log.shieldBlockBullet', { who: nm(e.who) }); break;
      case 'freeze_hit': html = T('log.freezeHit', { target: nm(e.target), dur: e.duration }); break;
      case 'poison_hit': html = T('log.poisonHit', { target: nm(e.target), dur: e.duration }); break;
      case 'star':
        held[e.who] = e.total;
        html = T('log.star', { who: nm(e.who), a: held[0], b: held[1] });
        break;
      case 'star_spawn': html = T('log.starSpawn', { x: e.x, y: e.y }); break;
      case 'star_gone': html = T('log.starGone', { x: e.x, y: e.y }); break;
      case 'item_spawn': html = T('log.itemSpawn', { item: itemLabel(e.kind), x: e.x, y: e.y }); break;
      case 'item_pick':
        html = T(
          e.kind === 'medkit' ? 'log.itemPickMedkit' : e.kind === 'clock' ? 'log.itemPickClock' : 'log.itemPick',
          { who: nm(e.who), item: itemLabel(e.kind), hp: e.hp },
        );
        break;
      case 'item_gone': html = T('log.itemGone', { item: itemLabel(e.kind), x: e.x, y: e.y }); break;
      case 'zone_shrink': html = T('log.zoneShrink', { ring: e.ring, x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 }); break;
      case 'zone_hit': html = T('log.zoneHit', { target: nm(e.target), dmg: e.dmg, hp: e.hp }); break;
      case 'slide': html = T('log.slide', { who: nm(e.who), x: e.x, y: e.y }); break;
      case 'skill': html = T('log.skillCast', { who: nm(e.who), skill: skillLabel(e.name) }); break;
      case 'stun_hit': html = T('log.stunHit', { target: nm(e.target), dur: e.duration }); break;
      case 'death': html = T('log.death', { who: nm(e.who) }); break;
      case 'end':
        html = e.winner == null
          ? T('log.endDraw', { a: e.stars[0], b: e.stars[1] })
          : T('log.endWin', { who: nm(e.winner), reason: REASON_CN[e.reason] ?? e.reason, a: e.stars[0], b: e.stars[1] });
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

// 场上道具徽章：白底圆牌 + 逐 kind 简笔图标（急救包/双发弹/穿甲弹/头盔/时钟/疾行靴）
function drawItemBadge(cx, cy, kind) {
  const r = TSZ * 0.36;
  ctx.fillStyle = 'rgba(255,252,240,0.95)';
  ctx.strokeStyle = 'rgba(60,50,30,0.8)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); ctx.stroke();
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  switch (kind) {
    case 'medkit': // 红十字
      ctx.strokeStyle = '#c0392b';
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.5, cy); ctx.lineTo(cx + r * 0.5, cy);
      ctx.moveTo(cx, cy - r * 0.5); ctx.lineTo(cx, cy + r * 0.5);
      ctx.stroke();
      break;
    case 'rapid': // 双弹头
      ctx.fillStyle = '#8c2a55';
      ctx.beginPath(); ctx.arc(cx - r * 0.3, cy, r * 0.24, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + r * 0.3, cy, r * 0.24, 0, 7); ctx.fill();
      break;
    case 'pierce': // 穿甲箭头
      ctx.strokeStyle = '#4a3a86';
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.45, cy + r * 0.35);
      ctx.lineTo(cx, cy - r * 0.45);
      ctx.lineTo(cx + r * 0.45, cy + r * 0.35);
      ctx.stroke();
      break;
    case 'helmet': // 头盔穹顶
      ctx.strokeStyle = '#7f8c8d';
      ctx.beginPath(); ctx.arc(cx, cy + r * 0.15, r * 0.45, Math.PI, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - r * 0.5, cy + r * 0.2); ctx.lineTo(cx + r * 0.5, cy + r * 0.2); ctx.stroke();
      break;
    case 'clock': // 表盘 + 指针
      ctx.strokeStyle = '#2c6e9e';
      ctx.beginPath(); ctx.arc(cx, cy, r * 0.5, 0, 7); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - r * 0.38);
      ctx.moveTo(cx, cy); ctx.lineTo(cx + r * 0.28, cy);
      ctx.stroke();
      break;
    case 'boots': // 疾行双箭羽
      ctx.strokeStyle = '#3f621e';
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.45, cy - r * 0.3); ctx.lineTo(cx + r * 0.05, cy); ctx.lineTo(cx - r * 0.45, cy + r * 0.3);
      ctx.moveTo(cx - r * 0.05, cy - r * 0.3); ctx.lineTo(cx + r * 0.45, cy); ctx.lineTo(cx - r * 0.05, cy + r * 0.3);
      ctx.stroke();
      break;
    default: // 工坊自定义道具：通用菱形图标
      ctx.strokeStyle = '#a06a1f';
      ctx.beginPath();
      ctx.moveTo(cx, cy - r * 0.45); ctx.lineTo(cx + r * 0.45, cy);
      ctx.lineTo(cx, cy + r * 0.45); ctx.lineTo(cx - r * 0.45, cy);
      ctx.closePath(); ctx.stroke();
      break;
  }
  ctx.lineCap = 'butt';
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

function drawIceTile(x, y) {
  // 冰面：淡蓝冰砖 + 斜向高光 + 随机细裂纹
  const px = x * TSZ;
  const py = y * TSZ;
  const v = tileHash(x, y, 21);
  ctx.fillStyle = '#BFE2EE';
  ctx.fillRect(px, py, TSZ, TSZ);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.beginPath();
  ctx.moveTo(px + TSZ * 0.12, py + TSZ * (0.72 + v * 0.12));
  ctx.lineTo(px + TSZ * (0.38 + v * 0.2), py + TSZ * 0.1);
  ctx.lineTo(px + TSZ * (0.56 + v * 0.2), py + TSZ * 0.1);
  ctx.lineTo(px + TSZ * 0.3, py + TSZ * (0.72 + v * 0.12));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(122,170,200,0.65)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 0.5, py + 0.5, TSZ - 1, TSZ - 1);
  if (v > 0.55) { // 细裂纹
    ctx.strokeStyle = 'rgba(90,140,175,0.6)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(px + TSZ * 0.2, py + TSZ * 0.55);
    ctx.lineTo(px + TSZ * 0.45, py + TSZ * 0.62);
    ctx.lineTo(px + TSZ * 0.62, py + TSZ * 0.4);
    ctx.stroke();
  }
}

function drawWaterTile(x, y) {
  // 水域：深蓝水面 + 底部暗层 + 错相波纹
  const px = x * TSZ;
  const py = y * TSZ;
  const v = tileHash(x, y, 33);
  ctx.fillStyle = '#3F7CB8';
  ctx.fillRect(px, py, TSZ, TSZ);
  ctx.fillStyle = 'rgba(28,74,120,0.35)';
  ctx.fillRect(px, py + TSZ * 0.55, TSZ, TSZ * 0.45);
  ctx.strokeStyle = 'rgba(220,240,255,0.7)';
  ctx.lineWidth = 1.4;
  for (const k of [0, 1]) {
    const wy = py + TSZ * (0.28 + k * 0.38 + v * 0.12);
    ctx.beginPath();
    ctx.moveTo(px + TSZ * 0.12, wy);
    ctx.quadraticCurveTo(px + TSZ * 0.3, wy - TSZ * 0.09, px + TSZ * 0.48, wy);
    ctx.quadraticCurveTo(px + TSZ * 0.66, wy + TSZ * 0.09, px + TSZ * 0.86, wy);
    ctx.stroke();
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
      else if (tile === TILE.ICE) drawIceTile(x, y);
      else if (tile === TILE.WATER) drawWaterTile(x, y);
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
  // 毒圈：安全区外整格暗紫遮罩 + 电离噪点，安全区描亮边（缩圈规则可视化）
  if (f.zone > 0) {
    const r = f.zone;
    const zx0 = 1 + r;
    const zy0 = 1 + r;
    const zx1 = W - 2 - r;
    const zy1 = H - 2 - r;
    ctx.fillStyle = 'rgba(88,28,135,0.42)';
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (x >= zx0 && x <= zx1 && y >= zy0 && y <= zy1) continue;
        ctx.fillRect(x * TSZ, y * TSZ, TSZ, TSZ);
        const v = tileHash(x, y, 7);
        if (v > 0.6) {
          ctx.fillStyle = 'rgba(216,180,254,0.5)';
          ctx.fillRect(x * TSZ + (v * 83) % (TSZ - 2), y * TSZ + (v * 47) % (TSZ - 2), 2, 2);
          ctx.fillStyle = 'rgba(88,28,135,0.42)';
        }
      }
    }
    ctx.strokeStyle = 'rgba(216,180,254,0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(zx0 * TSZ + 1, zy0 * TSZ + 1, (zx1 - zx0 + 1) * TSZ - 2, (zy1 - zy0 + 1) * TSZ - 2);
  }
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
  for (const it of f.items || []) drawItemBadge(it.x * TSZ + TSZ / 2, it.y * TSZ + TSZ / 2, it.kind); // 场上道具
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
    const tag = `P${i + 1} ${names[i]}${cloaked ? T('ladder.cloakTag') : ''} ★${f.held[i]}`;
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
let pendingSeed = null; // ?seed= 回放深链：仅下一局生效，用后即弃（此后恢复每局自动生成）
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
    }, [myTankLabel(), T('ui.opponent')], null, null, 0);
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
    verdictMain.textContent = T('verdict.draw');
    verdictMain.style.color = 'var(--muted)';
  } else {
    verdictMain.textContent = `● ${names[r.winner]} WIN`;
    verdictMain.style.color = r.winner === 0 ? 'var(--p1)' : 'var(--p2)';
  }
  const how = REASON_CN[r.reason] ?? T('verdict.drawWord');
  verdictSub.textContent = T('verdict.sub', { how, t: r.ticks - 1, a: r.stars[0], b: r.stars[1], sec: (r.ticks / BASE_TPS).toFixed(1) });
  verdictRef.textContent = T('verdict.ref', { id: 10000 + (match.seed % 90000) });
  if (box && box.count > 0) showErr(T('err.runtime', { n: box.count, msg: box.last }));
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
    showErr(T('err.compileFail', { msg: String((e && e.message) || e) }));
    return;
  }
  const box = { count: 0, last: '' };
  const guarded = guardWrap(fn, box);
  guarded.skill = userSkill(); // 8 选 1：显式挂到脚本函数上（runMatch 按 .skill 取装备）
  // 种子不由玩家选择：每局开战自动生成；?seed= 深链只顶替下一局（回放复现）
  const seedStr = pendingSeed || genSeed();
  pendingSeed = null;
  const seed = seedFromString(seedStr);
  const oppKey = oppSelect.value;
  let oppFn;
  let oppStyle;
  if (oppKey.startsWith('pack:')) { // 工坊/官方流派 bot：与用户脚本同一沙箱编译
    if (!EVAL_OK) { showErr(T('err.cspEval')); return; }
    const d = PACK.entries.find((e) => e.type === 'bot' && e.id === oppKey.slice(5));
    try { oppFn = compileBot(d); } catch (e) { showErr(String((e && e.message) || e)); return; }
    oppStyle = d.name;
  } else {
    const opp = ROSTER.find((r) => r.key === oppKey) || ROSTER[0];
    oppFn = opp.fn;
    oppStyle = T('ladder.styleTag', { style: opp.style });
  }
  // 地图与对局同源：预置图按选择取，随机图与 seed 同源；先取图再喂给 runMatch，保证渲染的就是对局用图
  const map = makeMap(seed);
  const names = [myTankLabel(), oppStyle];
  // 内容包全程随局（UGC 技能/道具/地图注册 + 战报嵌 pack：分享后任何人可确定性重现）
  const result = runMatch({ seed, botA: guarded, botB: oppFn, map, content: PACK });
  const tl = buildTimeline(map, result);
  match = { seedStr, seed, map, result, names, frames: tl.frames, shots: tl.shots, sparks: tl.sparks, entries: buildLog(result, names, seedStr) };
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
    parts.push({ key: '__user__', tank: myTankLabel(), style: T('ladder.userStyle'), fn: gfn, me: true, elo: 1200, w: 0, d: 0, g: 0 });
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
        const r = runMatch({ seed, botA: A.fn, botB: B.fn, content: PACK }); // 用户可能装备工坊技能
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
    tr.innerHTML = `<td${i === 0 ? ' class="r1"' : ''}>${i + 1}</td><td>${esc(p.tank)}</td><td>${esc(p.style)}</td><td class="elo">${Math.round(p.elo)}</td><td>${wr}%</td>`;
    ladderBody.appendChild(tr);
  });
  for (const r of ROSTER) {
    const p = parts.find((x) => x.key === r.key);
    const opt = oppSelect.querySelector(`option[value="${r.key}"]`);
    if (p && opt) opt.textContent = T('ladder.oppOption', { style: r.style, skill: SKILL_CN[r.fn.skill] ?? r.fn.skill, elo: Math.round(p.elo) });
  }
  const mine = parts.find((p) => p.me);
  rankChip.textContent = mine
    ? T('ladder.rankChip', { name: myTankLabel(), elo: Math.round(mine.elo), rank: parts.indexOf(mine) + 1, total: parts.length })
    : T('ladder.updated');
  const hint = document.getElementById('ladderHint');
  if (hint) hint.textContent = T('ladder.hint', { seeds: JSON.stringify(LADDER_SEEDS), n: parts.length * (parts.length - 1) * LADDER_SEEDS.length });
}

function scheduleLadder() {
  const go = () => computeLadder();
  if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 1200 });
  else setTimeout(go, 600);
}

// ---------- 事件绑定 ----------
$id('battleBtn').addEventListener('click', startBattle);
saveBtn.addEventListener('click', () => { saveVersion(); });
$id('garageNewBtn')?.addEventListener('click', () => { newTank(); });
editorEl.addEventListener('input', () => { // 草稿断电保护：未保存内容刷新不丢（≠ 坦克版本，不自动上传）
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ cur: garage.cur, code: editorEl.value })); } catch { /* 忽略 */ }
});
if (skillSel) skillSel.addEventListener('change', scheduleLadder);

// ---------- 创作工坊独立页：顶栏入口 + #workshop 深链（hash 切换，单文件内双页） ----------
const playMain = $id('playMain');
const wsMain = $id('wsMain');
function syncWsPage() {
  const on = location.hash === '#workshop';
  if (playMain) playMain.hidden = on;
  if (wsMain) wsMain.hidden = !on;
}
$id('wsPageBtn')?.addEventListener('click', () => { location.hash = '#workshop'; });
$id('wsBackBtn')?.addEventListener('click', () => { location.hash = ''; });
window.addEventListener('hashchange', syncWsPage);
syncWsPage();

// ---------- 装备/代码不符提醒（非阻断） ----------
// 装备由下拉框决定（guarded.skill），代码只决定何时施放；代码里点名的技能与装备不符时，
// 引擎按 no-op 处理（旧入口语义）——这里显式提醒，并给一键换通用模板（旧代码先落存档可找回）。
const skillHintEl = $id('skillHint');
const skillHintText = $id('skillHintText');
const skillHintBtn = $id('skillHintBtn');
function refreshSkillHint() {
  if (!skillHintEl) return;
  const bad = skillCodeMismatch(editorEl.value, userSkill());
  if (!bad.length) { skillHintEl.classList.remove('show'); return; }
  skillHintText.textContent = T('ui.skillMismatch', { skill: skillLabel(userSkill()), calls: bad.map(skillLabel).join('/') });
  skillHintBtn.style.display = '';
  skillHintEl.classList.add('show');
}
if (skillHintBtn) {
  skillHintBtn.textContent = T('ui.skillMismatchBtn');
  skillHintBtn.addEventListener('click', async () => {
    const prev = editorEl.value;
    const storedCode = curTank()?.code ?? null;
    const needSave = !!prev.trim() && prev !== storedCode && prev !== DEFAULT_SCRIPT;
    if (needSave) await saveVersion(); // 覆盖前旧代码先存一版：刷新页面/车库里即可找回
    editorEl.value = DEFAULT_SCRIPT;
    refreshSkillHint(); // 通用模板必然清除不符 → 隐藏后再补一条完成提示
    skillHintText.textContent = needSave ? T('ui.skillMismatchDoneSaved', { v: curTank()?.v ?? 1 }) : T('ui.skillMismatchDone');
    skillHintBtn.style.display = 'none';
    skillHintEl.classList.add('show');
  });
}
if (skillSel) skillSel.addEventListener('change', refreshSkillHint);
editorEl.addEventListener('input', refreshSkillHint);
if (mapSel) mapSel.addEventListener('change', () => {
  // 切图立即生效：回到预览态，下一局按新图开战
  match = null;
  setPlaying(false);
  cur = 0;
  acc = 0;
  previewMap = makeMap(seedFromString(pendingSeed || genSeed())); // 预览仅示意；对局用图以开战时自动种子为准
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
  note.textContent = T('err.cspNote');
  errEl.parentNode.insertBefore(note, errEl);
}
updateVersionUi();
renderGarage();
const qp = new URLSearchParams(location.search);
if (qp.get('seed')) pendingSeed = qp.get('seed').trim() || null; // ?seed= 回放深链：下一局按此种子复现
if (qp.get('pack') && wsImportPack) { // ?pack= 分享深链（阶段2）：先导入内容包，选项注入后再应用 map/skill/opp
  try { wsImportPack(qp.get('pack'), { silent: true }); } catch (e) { console.log('内容包导入失败：', e.message); }
}
if (qp.get('script')) { // 战报重现链接自带对局脚本（不嵌脚本无法逐字节重现）
  try { editorEl.value = b64d(qp.get('script')); } catch { /* 忽略 */ }
}
if (qp.get('map') && mapSel && [...mapSel.options].some((o) => o.value === qp.get('map'))) {
  mapSel.value = qp.get('map'); // ?map=id 直达预置图（可分享/截图复现）
}
if (qp.get('skill') && skillSel && [...skillSel.options].some((o) => o.value === qp.get('skill'))) {
  skillSel.value = qp.get('skill');
}
if (qp.get('opp') && oppSelect && [...oppSelect.options].some((o) => o.value === qp.get('opp'))) {
  oppSelect.value = qp.get('opp');
}
footSeed.textContent = pendingSeed ? T('ui.footSeedReplay', { seed: pendingSeed }) : T('ui.footSeedAuto');
previewMap = makeMap(seedFromString(pendingSeed || genSeed()));
setupCanvas(previewMap);
requestAnimationFrame(loop);
scheduleLadder();
refreshSkillHint(); // 启动即检（含 ?script=/?skill= 深链落定后的状态）
if (qp.get('autoplay') === '1') {
  startBattle();
  if (match) { // 跳到中局并停住，便于截图/演示（双方坦克在场、战报点亮过半）
    cur = Math.floor((match.result.ticks - 1) / 2);
    setPlaying(false);
  }
}

// ---------- Play 用户支持（仅 play 部署环境激活；file:/匿名/SDK 不可用时零回归） ----------
initPlay({
  T, L,
  editorGet: () => editorEl.value,
  editorSet: (code) => { editorEl.value = code; refreshSkillHint(); },
  compileScript, guardWrap,
  userSkill, userMapKey, makeMap,
  defaultScript: DEFAULT_SCRIPT,
  ROSTER, LADDER_SEEDS,
  runMatch,
  getPack: () => PACK,
  workshopConnect: (cloud) => (wsConnectCloud ? wsConnectCloud(cloud) : null),
  garageConnect, // 登录成功：车库切云端 + 登录时刻逐台衔接（方案 v2）
  resetForLogout, // 登出：清车库/草稿、编辑器回默认模板（未入库匿名坦克先进存档）
});
