// AgenTank 网页端 UI：本地跑引擎对战 + canvas 逐 tick 回放 + 实时战报 + 天梯。
// 开发版经 <script type="module"> 加载；发布版由 scripts/build-web.mjs 去 import/export 内联进单文件。
import { runMatch, generateMap, mulberry32, renderText, RULES, TILE, PRESET_MAPS, presetMap, validateContent, makePack, serializePack, parsePack, promoteStage, resolvePackMap, compileBot, OFFICIAL_CONTENT, buildBattleReport, summarizeGame, aggregateBatch, renderBatchText, battleReportFilename, batchReportFilename, BATCH_SEEDS } from '../src/engine/index.js';
import { bots } from '../bots/index.js';
import { LOCALES, LANGS, fmt, resolveLang } from './i18n.js';
import { initPlay, skillCodeMismatch, buildTankPayload, migrateLocalSave, upsertLocalTank, reconcileLogin, nextTankName, buildLlmPrompt, extractLlmCode, mapLlmError, scriptGate, buildGenLog, genLogFilename, resolveEditorState, draftIsClean, buildReviewPrompt, parseReviewReply, reviewPayloadFromBattle, reviewPayloadFromBatch, compareVerdict, pickBest, nextRoundBase, iterationCost, buildIterationLog } from './play.js';
import { extractEngineSource, buildWorkerSource } from './sandbox.js';

// 单文件产物里，本脚本自身的源码文本（引擎源从中切出，喂给无 eval 沙箱 Worker）。
// 开发版是 <script type="module">，currentScript 为 null → SELF_SRC 为空；但开发版允许 eval，用不到沙箱。
const SELF_SRC = (typeof document !== 'undefined' && document.currentScript && document.currentScript.textContent) || '';

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
const strategyEl = $id('strategyBox'); // 策略文本优先：默认视图是策略描述，脚本折叠在 codeBox 里
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
const DEFAULT_STRATEGY = L.ui.strategyDefault; // 默认战术文本：与 DEFAULT_SCRIPT 语义一致（语言切换会整页刷新，随页取新语言）
const isDefaultCode = (src) => String(src || '').replace(/\s+/g, '') === DEFAULT_SCRIPT.replace(/\s+/g, '');

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

// 探测宿主是否允许 eval（play-agentank.run.ceo 实测 CSP：script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'，无 'unsafe-eval'）
const EVAL_OK = (() => { try { new Function(''); return true; } catch { return false; } })();
// 同一宿主下 blob Worker 是否可用（受 worker-src 管辖，与 eval 无关）——线上实测可用，
// 是后续「无 eval 也能跑自定义脚本」的执行路径；此处先如实记进诊断日志，便于产品方判断修复面。
const WORKER_OK = (() => {
  try {
    const u = URL.createObjectURL(new Blob(['self.close();'], { type: 'text/javascript' }));
    const w = new Worker(u);
    w.terminate();
    URL.revokeObjectURL(u);
    return true;
  } catch { return false; }
})();
// 宿主 CSP 原文（只读一次，best-effort）：失败诊断里最关键的一行事实，避免只能靠"eval 挂了"反推
let CSP_HEADER = '';
if (!EVAL_OK && (location.protocol === 'http:' || location.protocol === 'https:')) {
  try {
    fetch(location.href, { method: 'HEAD', cache: 'no-store' })
      .then((r) => { CSP_HEADER = r.headers.get('content-security-policy') || '(header not readable)'; })
      .catch((e) => { CSP_HEADER = `(head probe failed: ${e && e.message})`; });
  } catch { CSP_HEADER = '(head probe threw)'; }
}

// 无 eval 沙箱可用性：禁 eval 的宿主上，只要 blob Worker 放行且能切出引擎源码，自定义脚本就照常能跑
const ENGINE_SRC = extractEngineSource(SELF_SRC);
const SANDBOX_OK = WORKER_OK && !!ENGINE_SRC;
// 自定义脚本能不能开战（两条路二选一：主线程直编 / 沙箱 Worker）——UI 文案与生成流程都按它分流
const CUSTOM_SCRIPT_OK = EVAL_OK || SANDBOX_OK;

let sandboxSeq = 0;
// 把一份作业丢进一次性 blob Worker 跑完即销毁（每局独立进程态，脚本互不残留）
function sandboxRun(job, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let url = null;
    let w = null;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (w) w.terminate();
      if (url) URL.revokeObjectURL(url);
    };
    try {
      const src = buildWorkerSource({ engineSrc: ENGINE_SRC, userCode: o.userCode, oppCode: o.oppCode });
      url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      w = new Worker(url);
    } catch (e) { cleanup(); reject(e); return; }
    timer = setTimeout(() => { cleanup(); reject(new Error(`sandbox timeout ${o.timeoutMs || 30000}ms`)); }, o.timeoutMs || 30000);
    w.onmessage = (ev) => {
      const d = ev.data || {};
      cleanup();
      if (d.ok) resolve(d);
      else reject(new Error(d.error || 'sandbox error'));
    };
    w.onerror = (ev) => { cleanup(); reject(new Error(`sandbox worker error: ${(ev && ev.message) || 'blocked'}`)); };
    w.postMessage({ id: ++sandboxSeq, ...job });
  });
}

function compileScript(src) {
  if (!EVAL_OK) {
    if (String(src).replace(/\s+/g, '') === DEFAULT_SCRIPT.replace(/\s+/g, ''))
      return defaultDecide;
    const e = new Error(T('err.cspEval'));
    e.code = 'CSP_NO_EVAL'; // 与「玩家代码写错」区分：这是宿主环境限制，绝不能当编译错误喂回模型
    throw e;
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
    arc.push({ name: t.name, code: t.code, strategy: t.strategy || '', skill: t.skill || '', v: t.v ?? 1, from, ts: Date.now() });
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(arc));
  } catch { /* 忽略 */ }
}
function clearDraft() { try { localStorage.removeItem(DRAFT_KEY); } catch { /* 忽略 */ } }
function readDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { return null; } }
// 草稿只有在「与坦克逐字一致 = 没有未保存改动」时才清；否则留着（清掉等于丢用户没存的战术/代码）
function clearDraftIfClean(t) { if (draftIsClean(readDraft(), t)) clearDraft(); }
function applyTankToUi(t) { // 切台/入座：代码进编辑器、策略文本跟随、技能跟随（无该选项时保持现装备）
  // 未保存的草稿优先于已保存内容 —— 云端接管（异步，登录后才完成）绝不能把玩家正在写的战术文字盖掉
  const st = resolveEditorState({
    tank: t, draft: readDraft(), cur: t ? t.name : garage.cur,
    defaultCode: DEFAULT_SCRIPT, defaultStrategy: DEFAULT_STRATEGY, isDefaultCode,
  });
  editorEl.value = st.code;
  if (strategyEl) strategyEl.value = st.strategy;
  if (t && t.skill && skillSel && [...skillSel.options].some((o) => o.value === t.skill)) skillSel.value = t.skill;
  refreshSkillHint();
}
function loadStore() {
  const s = readLocalStore();
  garage.tanks = s.tanks;
  garage.cur = s.cur;
  // 草稿回填已并入 applyTankToUi（含「尚无坦克」态）：登录态本地车库为空时，
  // 旧写法用 garage.cur(null) 去比草稿的坦克名，永远不相等 → 草稿（含战术文字）刷新后再也回不来
  applyTankToUi(curTank());
}
async function saveVersion() {
  const code = editorEl.value;
  const skill = userSkill();
  const strategy = strategyEl ? strategyEl.value : '';
  if (garage.mode === 'cloud') {
    // 保存 = 把代码写进云端，不需要在本机执行它 —— 禁 eval 的宿主上走结构校验，绝不因 CSP 挡住保存
    const gate = scriptGate(code, { evalOk: EVAL_OK, compile: compileScript });
    if (!gate.ok) { garageMsg(T('play.gateFail', { msg: gate.errors.join('; ') }), true); return; }
    const t = curTank();
    try {
      if (t) {
        await garage.cloud.update(t.id, buildTankPayload({ name: t.name, code, strategy, skill, version: t.v + 1, is_active: t.active === true }));
      } else { // 云端第一台：命名即入库
        const name = askName(tankN(1));
        if (!name) return;
        await garage.cloud.create(buildTankPayload({ name, code, strategy, skill, version: 1, is_active: true }));
      }
      await reloadCloudGarage();
      garageMsg(T('play.saved', { v: curTank()?.v ?? 1 }));
    } catch (e) { garageMsg(T('play.saveFail', { msg: String((e && e.message) || e) }), true); return; }
  } else {
    const r = upsertLocalTank({ tanks: garage.tanks, cur: garage.cur }, { name: garage.cur || tankN(1), code, strategy, skill });
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
  // 粘底 CTA 是半宽按钮：这里用短文案（长文案会换行把 CTA 撑高、压小滚动区），完整说明进 title
  saveBtn.textContent = t ? T('ui.saveShort', { v: t.v + 1 }) : T('ui.saveFirstShort');
  saveBtn.title = t ? T('ui.save', { name: t.name, v: t.v + 1 }) : T('ui.saveFirst');
  // 坦克身份挪到左栏顶部切换器（h2 固定为「战术指挥」）：一行显示名字 + 版本 + 云端状态
  const nameEl = $id('tankSwitchName');
  const verEl = $id('tankSwitchVer');
  const syncEl = $id('tankSwitchSync');
  if (nameEl) nameEl.textContent = t ? t.name : T('ui.myTank');
  if (verEl) verEl.textContent = t ? `v${t.v}` : '';
  if (syncEl) {
    const cloud = garage.mode === 'cloud';
    syncEl.textContent = T(cloud ? 'ui.tankSwitchCloud' : 'ui.tankSwitchLocal');
    syncEl.classList.toggle('on', cloud);
  }
  const drawerSub = $id('scriptDrawerSub');
  if (drawerSub) drawerSub.textContent = t ? `${t.name} v${t.v}` : myTankLabel();
  renderTankMenu();
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
  clearDraft(); // 切台是明确换车：先清掉上一台的草稿，再入座，避免旧草稿串到新台
  clearIterBase(); // 迭代前快照同属「上一台」，一起清，避免一键回退把 A 台代码盖到 B 台
  applyTankToUi(curTank() || t);
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
      await garage.cloud.create(buildTankPayload({ name, code: DEFAULT_SCRIPT, strategy: '', skill: userSkill(), version: 1, is_active: true }));
      if (old) await garage.cloud.update(old.id, { is_active: false });
      await reloadCloudGarage();
    } catch (e) { garageMsg(T('play.saveFail', { msg: String((e && e.message) || e) }), true); return; }
  } else {
    garage.tanks.push({ name, code: DEFAULT_SCRIPT, strategy: '', skill: userSkill(), v: 1 });
    garage.cur = name;
    writeLocalStore(garage);
  }
  applyTankToUi(curTank());
  clearDraft();
  clearIterBase(); // 新建=换车：上一台的迭代快照必须一起清（漏挂会让一键回退把 A 台代码盖到 B 台）
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
    renderTankMenu();
    return;
  }
  for (const t of garage.tanks) {
    const isCur = t.name === garage.cur;
    // 弹窗里空间够（720px）：每台坦克显示版本 / 技能 / 战术字数，而不是旧左栏那条挤成一行的窄条
    const row = document.createElement('div');
    row.className = isCur ? 'gcard cur' : 'gcard';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = t.name;
    if (isCur) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = T('ui.garageActive');
      n.appendChild(tag);
    }
    const d = document.createElement('div');
    d.className = 'd';
    const chars = String(t.strategy || '').trim().length;
    d.textContent = [
      `v${t.v}`,
      skillLabel(t.skill || 'teleport'),
      chars ? T('ui.garageStrategyChars', { n: chars }) : T('ui.garageNoStrategy'),
    ].join(' · ');
    meta.appendChild(n);
    meta.appendChild(d);
    row.appendChild(meta);
    const ops = document.createElement('div');
    ops.className = 'ops';
    const mkBtn = (text, fn) => {
      const b = document.createElement('button');
      b.className = 'btn ghost';
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('click', fn);
      ops.appendChild(b);
    };
    if (!isCur) mkBtn(T('ui.garageUse'), () => { switchTank(t.name); });
    mkBtn(T('ui.garageRename'), () => { renameTank(t.name); });
    row.appendChild(ops);
    garageListEl.appendChild(row);
  }
  renderTankMenu();
}

// ---------- 左栏作战台外壳（方案 A）：坦克切换器 / 覆盖层 / 通知队列 / 对局设置 chip ----------
// 设计约束：左栏只留每局都碰的东西；低频功能进覆盖层。任何状态下 #lpScroll 独立滚动、#lpCta 粘底，
// 不再出现旧版「内容溢出被 body{overflow:hidden} 裁掉且没有滚动条」的情况。
const scrimEl = $id('overlayScrim');
const tankMenuEl = $id('tankMenu');
const tankSwitchEl = $id('tankSwitch');
const setupPopEl = $id('setupPop');
let openedOverlay = null;

function openOverlay(el) {
  if (!el) return;
  if (openedOverlay && openedOverlay !== el) openedOverlay.hidden = true;
  openedOverlay = el;
  el.hidden = false;
  if (scrimEl) scrimEl.hidden = false;
  const first = el.querySelector('textarea, select, input, button');
  if (first) { try { first.focus(); } catch { /* 忽略 */ } }
}
function closeOverlay() {
  if (openedOverlay) openedOverlay.hidden = true;
  openedOverlay = null;
  if (scrimEl) scrimEl.hidden = true;
}
function tankMenuHide() {
  if (tankMenuEl) tankMenuEl.hidden = true;
  if (tankSwitchEl) tankSwitchEl.setAttribute('aria-expanded', 'false');
}
function setupPopHide() {
  if (setupPopEl) setupPopEl.hidden = true;
  for (const c of document.querySelectorAll('#setupRow .schip')) c.classList.remove('on');
}
function renderTankMenu() { // 切换器下拉：高频「换一台」一击直达，管理类沉到最后两行
  const list = $id('tankMenuList');
  if (!list) return;
  list.innerHTML = '';
  if (!garage.tanks.length) {
    const p = document.createElement('div');
    p.style.cssText = 'font-size:11px;color:var(--dim);padding:6px 9px';
    p.textContent = T('ui.garageEmpty');
    list.appendChild(p);
    return;
  }
  for (const t of garage.tanks) {
    const isCur = t.name === garage.cur;
    const it = document.createElement('button');
    it.type = 'button';
    it.className = isCur ? 'it on' : 'it';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = `${t.name} v${t.v}`;
    it.appendChild(nm);
    if (isCur) {
      const tag = document.createElement('span');
      tag.style.cssText = 'font-size:11px;color:var(--p1)';
      tag.textContent = T('ui.garageActive');
      it.appendChild(tag);
    }
    it.addEventListener('click', () => { tankMenuHide(); if (!isCur) switchTank(t.name); });
    list.appendChild(it);
  }
}

// 通知队列：脚本报错 / 技能不符 / 登录衔接三条横幅曾能同时出现（叠加约 120px 把设置项顶下去）；
// 现在默认只露最紧急一条，其余折进「还有 N 条」。各处仍按老办法 toggle .show，这里用观察器兜住所有入口。
const noticeBoxEl = $id('noticeBox');
const noticeMoreEl = $id('noticeMore');
let noticesOpen = false;
let noticeBusy = false;
function renderNotices() {
  if (!noticeBoxEl || !noticeMoreEl || noticeBusy) return;
  noticeBusy = true;
  try {
    const all = [...noticeBoxEl.querySelectorAll('.notice')];
    const shown = all.filter((el) => el.classList.contains('show'));
    for (const el of all) el.classList.remove('nt-hidden');
    if (!noticesOpen) for (const el of shown.slice(1)) el.classList.add('nt-hidden');
    noticeMoreEl.hidden = shown.length <= 1;
    noticeMoreEl.textContent = noticesOpen ? T('ui.noticeLess') : T('ui.noticeMore', { n: shown.length - 1 });
  } finally {
    setTimeout(() => { noticeBusy = false; }, 0); // 自身改 class 不再回环触发观察器
  }
}
function syncSetupChips() { // chip 只显示选项主名（括号里的说明在气泡里看）
  const short = (sel) => {
    if (!sel) return '';
    const txt = sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : '';
    return String(txt || sel.value).split(/[（(]/)[0].trim();
  };
  const set = (id, sel) => {
    const v = $id(id) && $id(id).querySelector('.v');
    if (v) v.textContent = short(sel);
  };
  set('chipOpp', oppSelect);
  set('chipSkill', skillSel);
  set('chipMap', mapSel);
}

if (scrimEl) scrimEl.addEventListener('click', closeOverlay);
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closeOverlay);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { // 覆盖层 > 下拉/气泡：逐层收起，键盘可达
    if (openedOverlay) closeOverlay();
    else { tankMenuHide(); setupPopHide(); }
  }
});
$id('garageOpenBtn')?.addEventListener('click', () => { tankMenuHide(); openOverlay($id('garageModal')); });
$id('tankNewBtn')?.addEventListener('click', () => { tankMenuHide(); newTank(); });
$id('scriptOpenBtn')?.addEventListener('click', () => openOverlay($id('scriptDrawer')));
{
  const userChip = $id('playUserChip');
  if (userChip) {
    userChip.style.cursor = 'pointer';
    userChip.addEventListener('click', () => openOverlay($id('accountModal')));
  }
}
if (tankSwitchEl && tankMenuEl) {
  tankSwitchEl.addEventListener('click', (e) => {
    e.stopPropagation();
    const willShow = tankMenuEl.hidden;
    setupPopHide();
    if (willShow) renderTankMenu();
    tankMenuEl.hidden = !willShow;
    tankSwitchEl.setAttribute('aria-expanded', String(willShow));
  });
}
document.addEventListener('click', (e) => { // 点空白收起下拉/气泡
  if (tankMenuEl && !tankMenuEl.hidden && !tankMenuEl.contains(e.target) && !(tankSwitchEl && tankSwitchEl.contains(e.target))) tankMenuHide();
  if (setupPopEl && !setupPopEl.hidden && !setupPopEl.contains(e.target) && !(e.target.closest && e.target.closest('#setupRow .schip'))) setupPopHide();
});
for (const chip of document.querySelectorAll('#setupRow .schip')) {
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOn = chip.classList.contains('on');
    setupPopHide();
    tankMenuHide();
    if (wasOn || !setupPopEl) return;
    chip.classList.add('on');
    for (const r of setupPopEl.querySelectorAll('.prow')) r.classList.toggle('on', r.dataset.row === chip.dataset.pop);
    setupPopEl.hidden = false;
  });
}
for (const sel of [oppSelect, skillSel, mapSel]) {
  if (sel) sel.addEventListener('change', () => { syncSetupChips(); setupPopHide(); });
}
if (noticeMoreEl) noticeMoreEl.addEventListener('click', () => { noticesOpen = !noticesOpen; renderNotices(); });
if (noticeBoxEl && typeof MutationObserver === 'function') {
  new MutationObserver(renderNotices).observe(noticeBoxEl, { attributes: true, attributeFilter: ['class'], subtree: true });
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
      applyTankToUi(t); // 草稿优先：不把玩家正在写的战术文字覆盖成云端的旧值/空值
      clearDraftIfClean(t); // 有未保存改动就留着草稿（旧写法无条件清，正是战术文字丢失的最后一环）
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
  clearIterBase(); // 登出必须一并清：否则下一个人能一键取回上一个人的战术与代码
  editorEl.value = DEFAULT_SCRIPT;
  if (strategyEl) strategyEl.value = DEFAULT_STRATEGY; // 上一人的策略文本一并清掉，回到默认战术文本
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

// 没开战就藏起「复盘这一局 / ⬇ JSON」——这两个入口在没有战报时点了也没意义
function syncLogActs() {
  const el = $id('logActs');
  if (el) el.hidden = !match;
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

async function startBattle() {
  hideErr();
  const userCode = editorEl.value;
  const skill = userSkill(); // 8 选 1：显式挂到脚本函数上（runMatch 按 .skill 取装备）
  // 种子不由玩家选择：每局开战自动生成；?seed= 深链只顶替下一局（回放复现）
  const seedStr = pendingSeed || genSeed();
  pendingSeed = null;
  const seed = seedFromString(seedStr);
  const oppKey = oppSelect.value;
  let oppFn = null;   // 主线程路径用
  let oppCode = null; // 沙箱路径用（工坊 bot 以源码随行，Worker 内同样零 eval）
  let oppSpec;
  let oppStyle;
  if (oppKey.startsWith('pack:')) { // 工坊/官方流派 bot：与用户脚本同一沙箱口径
    const d = PACK.entries.find((e) => e.type === 'bot' && e.id === oppKey.slice(5));
    if (!d) { showErr(T('err.noDecide')); return; }
    oppStyle = d.name;
    oppCode = d.code;
    oppSpec = { kind: 'code', skill: d.skill ?? 'shield' };
    if (EVAL_OK) { try { oppFn = compileBot(d); } catch (e) { showErr(String((e && e.message) || e)); return; } }
    else if (!SANDBOX_OK) { showErr(T('err.cspEval')); return; }
  } else {
    const opp = ROSTER.find((r) => r.key === oppKey) || ROSTER[0];
    oppFn = opp.fn;
    oppSpec = { kind: 'builtin', key: opp.key };
    oppStyle = T('ladder.styleTag', { style: opp.style });
  }
  // 地图与对局同源：预置图按选择取，随机图与 seed 同源；先取图再喂给 runMatch，保证渲染的就是对局用图
  const map = makeMap(seed);
  const names = [myTankLabel(), oppStyle];
  const box = { count: 0, last: '' };
  let result;
  // 内容包全程随局（UGC 技能/道具/地图注册 + 战报嵌 pack：分享后任何人可确定性重现）
  if (EVAL_OK) { // 宿主允许 eval：主线程直编直跑（开发版/本地打开的单文件）
    let fn;
    try {
      fn = compileScript(userCode);
    } catch (e) {
      showErr(T('err.compileFail', { msg: String((e && e.message) || e) }));
      return;
    }
    const guarded = guardWrap(fn, box);
    guarded.skill = skill;
    result = runMatch({ seed, botA: guarded, botB: oppFn, map, content: PACK });
  } else if (SANDBOX_OK) { // 宿主禁 eval（线上）：整局丢进 blob Worker 跑，脚本作为 Worker 源码执行
    const btn = $id('battleBtn');
    if (btn) btn.disabled = true;
    try {
      const r = await sandboxRun(
        { type: 'match', seed, map, content: PACK, a: { kind: 'user', skill }, b: oppSpec },
        { userCode, oppCode },
      );
      result = r.result;
      box.count = r.errCount || 0;
      box.last = r.errLast || '';
    } catch (e) {
      // 沙箱失败一律显式报错 + 留诊断日志：绝不静默退回默认脚本假装打了一局
      showErr(T('err.sandboxFail', { msg: String((e && e.message) || e) }));
      setGenLog(buildGenLog({
        outcome: 'sandbox-failed', reason: String((e && e.message) || e), env: genEnv(),
        strategy: strategyEl ? strategyEl.value : '', skill, attempts: [],
      }));
      return;
    } finally { if (btn) btn.disabled = false; }
  } else { // 既不能 eval 也起不了沙箱：默认脚本仍可用内置等价实现，自定义脚本如实报错
    let fn;
    try {
      fn = compileScript(userCode);
    } catch (e) {
      showErr(T('err.compileFail', { msg: String((e && e.message) || e) }));
      return;
    }
    const guarded = guardWrap(fn, box);
    guarded.skill = skill;
    result = runMatch({ seed, botA: guarded, botB: oppFn, map, content: PACK });
  }
  const tl = buildTimeline(map, result);
  match = { seedStr, seed, map, result, names, frames: tl.frames, shots: tl.shots, sparks: tl.sparks, entries: buildLog(result, names, seedStr) };
  setupCanvas(map);
  renderLogList();
  syncLogActs();
  updateVerdict(box);
  updateFooter();
  cur = 0;
  acc = 0;
  setPlaying(true);
}

// ---------- 天梯（空闲时固定 seeds 循环赛实算 ELO/胜率） ----------
let ladderToken = 0;
// 沙箱天梯：宿主禁 eval 时，整轮循环赛（含「我的坦克」）一次性丢进 Worker 跑，主线程只算 ELO。
// 与主线程路径同引擎同种子，胜负一致；沙箱起不来就退回「只算内置四家」（如实少一行，不伪造战绩）。
async function computeLadderSandboxed(token, parts) {
  const me = { key: '__user__', tank: myTankLabel(), style: T('ladder.userStyle'), me: true, elo: 1200, w: 0, d: 0, g: 0, spec: { kind: 'user', skill: userSkill() } };
  for (const p of parts) p.spec = { kind: 'builtin', key: p.key };
  parts.push(me);
  const jobs = [];
  const pairIdx = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      for (const seed of LADDER_SEEDS) {
        for (const flip of [false, true]) {
          const ai = flip ? j : i;
          const bi = flip ? i : j;
          jobs.push({ seed, a: parts[ai].spec, b: parts[bi].spec });
          pairIdx.push([ai, bi]);
        }
      }
    }
  }
  let out;
  try {
    const r = await sandboxRun({ type: 'ladder', jobs, content: PACK }, { userCode: editorEl.value, timeoutMs: 60000 });
    out = r.results;
  } catch { // 沙箱天梯失败：退回内置四家，不把「我的坦克」画成 1200 分假名次
    if (token !== ladderToken) return;
    renderLadder(parts.filter((p) => !p.me));
    return;
  }
  if (token !== ladderToken) return; // 有新一轮计算，废弃本轮
  for (let k = 0; k < out.length; k++) {
    const A = parts[pairIdx[k][0]];
    const B = parts[pairIdx[k][1]];
    const sA = out[k].winner === null ? 0.5 : out[k].winner === 0 ? 1 : 0;
    const ea = 1 / (1 + 10 ** ((B.elo - A.elo) / 400));
    A.elo += 24 * (sA - ea);
    B.elo += 24 * ((1 - sA) - (1 - ea));
    A.g++; B.g++;
    if (sA === 1) A.w++;
    else if (sA === 0) B.w++;
    else { A.d++; B.d++; }
  }
  renderLadder(parts);
}

function computeLadder() {
  const token = ++ladderToken;
  const parts = ROSTER.map((r) => ({ ...r, elo: 1200, w: 0, d: 0, g: 0 }));
  if (!EVAL_OK && SANDBOX_OK) { computeLadderSandboxed(token, parts); return; }
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
const saveDraft = () => { // 草稿断电保护：未保存内容刷新不丢（≠ 坦克版本，不自动上传）；代码 + 策略文本双字段
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ cur: garage.cur, code: editorEl.value, strategy: strategyEl ? strategyEl.value : '' })); } catch { /* 忽略 */ }
};
editorEl.addEventListener('input', saveDraft);
if (strategyEl) strategyEl.addEventListener('input', saveDraft);

// ---------- 策略文本优先：AI 生成脚本（SDK play.llm，登录票 + 平台配额） ----------
const genBtn = $id('genBtn');
const genMsgEl = $id('genMsg');
const codeBox = $id('codeBox');
let llmCtl = null; // null=SDK 不可用；{needLogin,login}=未登录；{chat}=可生成
const genMsg = (msg, bad) => { if (genMsgEl) { genMsgEl.textContent = msg || ''; genMsgEl.style.color = bad ? 'var(--bad)' : 'var(--dim)'; } };
function llmConnect(ctl) { // play.js bootPlay 回调：按登录态切换生成按钮语义
  // 调试假 AI 一旦启用就硬短路真 SDK 注入：否则登录态下 bootPlay 会把假 AI 顶掉，
  // 页面却还留着「假 AI」横幅 —— 变成「标着假、烧真配额」的误导（评审 B5）。
  if (FAKE_LLM && llmCtl) return;
  llmCtl = ctl;
  if (genBtn && ctl && ctl.needLogin) genBtn.textContent = T('play.genLoginBtn');
}
// ---------- 生成诊断日志：任何一次生成结束都留档，失败时按钮显形，一键下载给产品方 ----------
const genLogBtn = $id('genLogBtn');
let lastGenLog = null;
function setGenLog(log) {
  lastGenLog = log || null;
  if (genLogBtn) genLogBtn.hidden = !lastGenLog;
}
function sdkState() {
  if (!llmCtl) return 'absent';
  if (llmCtl.needLogin) return 'need-login';
  return typeof llmCtl.chat === 'function' ? 'ready' : 'absent';
}
function genEnv() {
  return {
    url: location.href,
    appVersion: (document.querySelector('meta[name="agentank-build"]') || {}).content || '',
    lang: LANG,
    ua: navigator.userAgent,
    evalAllowed: EVAL_OK,   // false = 宿主 CSP 无 'unsafe-eval'（线上托管版即为此）
    workerAllowed: WORKER_OK,
    sandboxReady: SANDBOX_OK, // 禁 eval 时能否走 blob Worker 沙箱（false = 自定义脚本真跑不了）
    engineSrcChars: ENGINE_SRC.length,
    sdk: sdkState(),
    csp: CSP_HEADER,
  };
}
function downloadGenLog() {
  if (!lastGenLog) return;
  const name = genLogFilename(new Date());
  const blob = new Blob([JSON.stringify(lastGenLog, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  genMsg(T('play.genLogSaved', { name }));
}
if (genLogBtn) genLogBtn.addEventListener('click', downloadGenLog);

// 生成闸门：宿主允许 eval 时用真编译（最强）；宿主禁 eval 时用不执行代码的结构校验。
// 关键：CSP 限制绝不能冒充「你的代码编译失败」——那会把 100% 环境性失败伪装成模型输出问题，
// 还会把这条 CSP 文案当错误喂回模型再烧一次配额（本次线上 RCA 的直接成因）。
function generationGate(code) {
  return scriptGate(code, { evalOk: EVAL_OK, compile: compileScript });
}

async function generateScript(genOpts) {
  const gOpt = genOpts || {};
  if (!genBtn) return { ok: false, outcome: 'no-button', reason: 'gen button missing' };
  if (llmCtl && llmCtl.needLogin) { llmCtl.login(); return { ok: false, outcome: 'need-login', reason: 'not logged in' }; } // 未登录：按钮即登录入口
  const strategy = (strategyEl ? strategyEl.value : '').trim();
  const skill = userSkill();
  const t0 = Date.now();
  const attempts = [];
  const mkLog = (outcome, reason) => buildGenLog({
    outcome, reason, at: t0, durationMs: Date.now() - t0, env: genEnv(), strategy, skill, attempts,
  });
  if (!llmCtl || typeof llmCtl.chat !== 'function') {
    genMsg(T('play.genUnavailable'), true);
    setGenLog(mkLog('no-sdk', 'play SDK llm.chat unavailable'));
    return { ok: false, outcome: 'no-sdk', reason: 'play SDK llm.chat unavailable' };
  }
  if (!strategy) { genMsg(T('play.genEmpty'), true); return; }
  genBtn.disabled = true;
  setGenLog(null);
  genMsg(T('play.genRunning'));
  try {
    let feedback = '';
    for (let attempt = 1; attempt <= 2; attempt++) { // 不合格自动带错误重试一次，再失败如实报错
      const prompt = buildLlmPrompt({ strategy, skill, feedback });
      const rec = { n: attempt, promptChars: prompt.length };
      attempts.push(rec);
      const { text } = await llmCtl.chat(prompt, { model: gOpt.model || undefined, signal: gOpt.signal });
      rec.replyChars = String(text || '').length;
      rec.replyHead = String(text || '').slice(0, 500);
      const code = extractLlmCode(text);
      rec.extracted = !!code;
      if (!code) {
        rec.errorKind = 'no-code';
        rec.error = 'no code block found in output';
        feedback = rec.error;
        genMsg(T('play.genRetry'));
        continue;
      }
      rec.codeChars = code.length;
      rec.code = code;
      const gate = generationGate(code);
      if (!gate.ok) {
        rec.errorKind = EVAL_OK ? 'compile-failed' : 'check-failed';
        rec.error = gate.errors.join('; ');
        feedback = rec.error;
        genMsg(T('play.genRetry'));
        continue;
      }
      editorEl.value = code; // 只写编辑器，不自动保存/开战：玩家确认后自行「保存」「开战」
      refreshSkillHint();
      if (!gOpt.noDraft) saveDraft(); // 迭代期间不写草稿：中间版本会盖掉玩家原版（评审 B1）
      if (CUSTOM_SCRIPT_OK) {
        genMsg(T('play.genDone'));
        setGenLog(null);
      } else {
        // 代码生成成功，但本宿主还跑不了自定义脚本（CSP 禁 eval）：如实说明 + 留日志给产品方
        genMsg(T('play.genDoneNoRun'), true);
        setGenLog(mkLog('ok-cannot-run', 'host forbids dynamic compilation (CSP without unsafe-eval)'));
      }
      return { ok: true, outcome: CUSTOM_SCRIPT_OK ? 'ok' : 'ok-cannot-run', reason: '' };
    }
    genMsg(T('play.genFail', { msg: feedback }), true);
    setGenLog(mkLog('invalid-output', feedback));
    return { ok: false, outcome: 'invalid-output', reason: feedback };
  } catch (e) {
    const m = mapLlmError(e);
    genMsg(T(m.key, m.vars), true);
    const last = attempts[attempts.length - 1];
    if (last && !last.errorKind) {
      last.errorKind = 'sdk-error';
      last.error = `${(e && e.code) || ''} ${String((e && (e.hint || e.message)) || e)}`.trim();
    }
    const reason = `${(e && e.name) || 'Error'}: ${(e && e.code) || ''} ${String((e && (e.hint || e.message)) || e)}`.trim();
    setGenLog(mkLog('sdk-error', reason));
    return { ok: false, outcome: 'sdk-error', reason };
  } finally { genBtn.disabled = false; }
}
if (genBtn) genBtn.addEventListener('click', () => { generateScript(); });
// 「?」帮助弹窗：介绍战术文字怎么写（点 ? 开/关，「知道了」关闭）
const strategyHelpPop = $id('strategyHelpPop');
$id('strategyHelpBtn')?.addEventListener('click', () => { if (strategyHelpPop) strategyHelpPop.hidden = !strategyHelpPop.hidden; });
$id('strategyHelpClose')?.addEventListener('click', () => { if (strategyHelpPop) strategyHelpPop.hidden = true; });
// 掀开引擎盖手改代码后，提示代码与策略描述可能不同步（不阻断）
editorEl.addEventListener('input', () => {
  if (codeBox && codeBox.open && strategyEl && strategyEl.value.trim()) genMsg(T('play.codeEdited'));
});
if (skillSel) skillSel.addEventListener('change', scheduleLadder);

// ---------- 创作工坊独立页：顶栏入口 + #workshop 深链（hash 切换，单文件内双页） ----------
const playMain = $id('playMain');
const wsMain = $id('wsMain');
const wsPageBtn = $id('wsPageBtn');
function syncWsPage() {
  const on = location.hash === '#workshop';
  if (playMain) playMain.hidden = on;
  if (wsMain) wsMain.hidden = !on;
  if (wsPageBtn) { // 顶栏 chip 是开关：工坊页内变「← 返回对战」并高亮，再点一次即切回
    wsPageBtn.dataset.i18n = on ? 'ui.wsBack' : 'ui.wsPageBtn';
    wsPageBtn.textContent = T(on ? 'ui.wsBack' : 'ui.wsPageBtn');
    wsPageBtn.style.borderColor = on ? 'var(--p1)' : 'var(--line)';
    wsPageBtn.style.color = on ? 'var(--p1)' : 'var(--muted)';
  }
}
// 切页设完 hash 直接同步，不依赖 hashchange 事件（部分内嵌 WebView 不派发）
function gotoWsPage(on) {
  location.hash = on ? '#workshop' : '';
  syncWsPage();
}
wsPageBtn?.addEventListener('click', () => gotoWsPage(location.hash !== '#workshop'));
$id('wsBackBtn')?.addEventListener('click', () => gotoWsPage(false));
window.addEventListener('hashchange', syncWsPage); // 浏览器前进/后退、手改 hash 仍走事件
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
// 首访/清空后：代码仍是默认脚本时，战术框预填配套默认战术文本（不再空白；用户一改即draft跟随）
if (strategyEl && !strategyEl.value.trim() && isDefaultCode(editorEl.value)) strategyEl.value = DEFAULT_STRATEGY;
if (!CUSTOM_SCRIPT_OK) { // 只有连沙箱都起不来时才提示「只能用默认脚本」；沙箱可用时线上自定义脚本照常
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
syncSetupChips(); // chip 初值：必须在深链 ?opp=/?skill=/?map= 与内容包选项注入之后取，否则 chip 是空的
renderNotices(); // 通知队列初始化（启动即可能有脚本报错/技能不符）
if (qp.get('autoplay') === '1') {
  startBattle();
  if (match) { // 跳到中局并停住，便于截图/演示（双方坦克在场、战报点亮过半）
    cur = Math.floor((match.result.ticks - 1) / 2);
    setPlaying(false);
  }
}

// ---------- 战报下载 + AI 复盘 ----------
// 两种复盘，分工明确：
//   单局复盘 = 你刚看完这局回放 → 引擎把「不合理时刻」标出来 → AI 解释并改写战术（快而具体）；
//   多局复盘 = 同关卡同对手同技能只换种子跑 12 局 → 出胜率与败因 → AI 找系统性毛病（慢而可信）。
// 验收只认「留出组」（AI 没见过的另 12 个种子），防止把战术调成只赢训练那几个种子。
const BATCH_N = BATCH_SEEDS.train.length;
const batchRuns = { train: null, holdout: null };
let batchBusy = false;
let batchFailMsg = '';
let reviewMode = 'single';
let reviewProposal = null;
let reviewBusy = false;
let reviewMsgText = '';
let reviewMsgBad = false;
let reviewHistory = [];
let lastCompare = null;

const pctText = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const codeHashOf = (s) => seedFromString(String(s || '')).toString(16);
const setupKey = () => `${oppSelect.value}|${userSkill()}|${userMapKey()}|${myTankLabel()}`;

function downloadText(name, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// 对手解析（与开战同口径）：内置流派直接给函数，工坊 bot 以源码随行
function resolveOpp() {
  const key = oppSelect.value;
  if (key.startsWith('pack:')) {
    const d = PACK.entries.find((e) => e.type === 'bot' && e.id === key.slice(5));
    if (!d) throw new Error(T('err.noDecide'));
    return { fn: EVAL_OK ? compileBot(d) : null, code: d.code, spec: { kind: 'code', skill: d.skill ?? 'shield' }, style: d.name };
  }
  const opp = ROSTER.find((r) => r.key === key) || ROSTER[0];
  return { fn: opp.fn, code: null, spec: { kind: 'builtin', key: opp.key }, style: T('ladder.styleTag', { style: opp.style }) };
}

function mapLabel() {
  const opt = mapSel && mapSel.options[mapSel.selectedIndex];
  const txt = opt ? String(opt.textContent || '').split('（')[0].split(' (')[0].trim() : '';
  return txt || userMapKey();
}

function batchSetup(seedSet, style) {
  return { opponent: style, skill: userSkill(), mapKey: mapLabel(), tank: myTankLabel(), seedSet, seeds: BATCH_SEEDS[seedSet].slice() };
}

// 降级可观测纪律：批量失败一律记下异常名与内容（不是一句「出错了」），并进诊断日志
function batchFail(seedSet, e) {
  const name = (e && e.name) || 'Error';
  const msg = String((e && e.message) || e);
  batchFailMsg = `${name}: ${msg}`;
  batchRuns[seedSet] = null;
  setGenLog(buildGenLog({
    outcome: 'batch-failed', reason: batchFailMsg, env: genEnv(),
    strategy: strategyEl ? strategyEl.value : '', skill: userSkill(), attempts: [],
  }));
  renderGauge();
}

function gaugeProgress(i, seedSet) {
  const sub = $id('wrSub');
  if (!sub) return;
  sub.textContent = seedSet
    ? T('ui.rvRunningSet', { set: T(seedSet === 'holdout' ? 'ui.rvHoldout' : 'ui.rvTrain'), i, n: BATCH_N })
    : T('ui.rvRunning', { i, n: BATCH_N });
}

async function runBatch(seedSet) {
  if (batchBusy) return null;
  batchBusy = true;
  batchFailMsg = '';
  renderGauge();
  const strategy = strategyEl ? strategyEl.value : '';
  const t0 = Date.now();
  try {
    const opp = resolveOpp();
    const mine = { kind: 'user', skill: userSkill() };
    const jobs = BATCH_SEEDS[seedSet].map((s, i) => {
      const seed = seedFromString(s);
      const who = i % 2; // 先后手各 6 局，避免出生位偏袒
      return { seed, seedStr: s, map: makeMap(seed), who, a: who === 0 ? mine : opp.spec, b: who === 0 ? opp.spec : mine };
    });
    let games;
    let errCount = 0;
    let errLast = '';
    if (EVAL_OK) { // 本地/开发版：主线程直跑
      const fn = compileScript(editorEl.value);
      const box = { count: 0, last: '' };
      const guarded = guardWrap(fn, box);
      guarded.skill = userSkill();
      games = [];
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i];
        const r = runMatch({
          seed: j.seed, map: j.map, content: PACK,
          botA: j.who === 0 ? guarded : opp.fn,
          botB: j.who === 0 ? opp.fn : guarded,
        });
        games.push(summarizeGame({ map: j.map, result: r, who: j.who, seed: j.seedStr, strategy }));
        if (i % 3 === 2) { gaugeProgress(i + 1, seedSet); await new Promise((res) => setTimeout(res, 0)); } // 分片，不卡界面
      }
      errCount = box.count;
      errLast = box.last;
    } else if (SANDBOX_OK) { // 线上（禁 eval）：整批丢进 blob Worker，回「一局一行摘要」
      gaugeProgress(0, seedSet);
      const r = await sandboxRun({ type: 'batch', jobs, content: PACK, strategy }, { userCode: editorEl.value, oppCode: opp.code, timeoutMs: 120000 });
      games = r.games || [];
      errCount = r.errCount || 0;
      errLast = r.errLast || '';
    } else {
      throw new Error(T('err.cspEval'));
    }
    // 脚本每拍抛异常时 guardWrap 会返回 null，12 局全负 → 界面会显示一个「看起来正常的 0%」。
    // 那是本机纪律点名的静默降级形态（无异常、无红字、功能消失），必须显式报错并丢弃这批数字。
    if (errCount > 0) {
      const err = new Error(T('ui.rvScriptErr', { n: errCount, msg: errLast || '(no message)' }));
      err.name = 'ScriptRuntimeError';
      throw err;
    }
    batchRuns[seedSet] = {
      games, agg: aggregateBatch(games), setup: batchSetup(seedSet, opp.style),
      at: new Date().toISOString(), key: setupKey(), ms: Date.now() - t0,
    };
    renderGauge();
    return batchRuns[seedSet];
  } catch (e) {
    batchFail(seedSet, e);
    return null;
  } finally {
    batchBusy = false;
    renderGauge();
  }
}

// 基线 = 训练组 + 留出组各跑一遍。只跑训练组的话，采纳后的「留出组改前」永远是空，
// 对比卡片就会不管涨没涨都印「本轮没有提升」——那是凭空成立的否定结论（评审 B1）。
async function runBaseline() {
  const a = await runBatch('train');
  if (!a) return null; // 失败已在 gauge 明示，不继续跑第二组
  return runBatch('holdout');
}

function renderGauge() {
  const num = $id('wrNum');
  const sub = $id('wrSub');
  const meta = $id('wrMeta');
  const bars = $id('wrBars');
  const fail = $id('wrFail');
  const runBtn = $id('wrRunBtn');
  const hint = $id('wrHint');
  const flag = $id('wrFlagChip');
  if (!num || !sub) return;
  const run = batchRuns.train;
  const stale = run && run.key !== setupKey();
  if (runBtn) {
    runBtn.textContent = run ? T('ui.rvRerunBoth', { n: BATCH_N }) : T('ui.rvRunBoth', { n: BATCH_N });
    runBtn.disabled = batchBusy;
  }
  // 还没跑基线时「复盘」点开也只是空面板：禁用而不隐藏（旁边就是「跑基线」，隐藏会让这行布局跳动）
  const rvBtn = $id('wrReviewBtn');
  if (rvBtn) rvBtn.disabled = batchBusy || !(run && run.agg.games);
  if (fail) {
    fail.hidden = !batchFailMsg;
    if (batchFailMsg) fail.innerHTML = `${esc(T('ui.rvFail', { msg: '' }))}<div class="d">${esc(batchFailMsg)}</div><div class="d">${esc(T('ui.rvFailNote'))}</div>`;
  }
  if (!run || !run.agg.games) {
    num.textContent = '—%';
    num.classList.add('na');
    if (!batchBusy) sub.textContent = T('ui.rvNever');
    if (meta) meta.textContent = '';
    if (bars) bars.innerHTML = '';
    if (hint) hint.textContent = T('ui.rvLocalHint', { n: BATCH_N });
    if (flag) flag.hidden = true;
    return;
  }
  num.textContent = pctText(run.agg.winRate);
  num.classList.remove('na');
  if (!batchBusy) sub.textContent = T('ui.rvWins', { w: run.agg.wins, n: run.agg.games });
  if (meta) {
    const ho = batchRuns.holdout;
    const hoText = ho && ho.agg.games ? T('ui.rvHoldoutLine', { p: pctText(ho.agg.winRate) }) : T('ui.rvHoldoutNone');
    meta.innerHTML = [run.setup.opponent, run.setup.skill, run.setup.mapKey, run.setup.tank, hoText]
      .map((x) => `<span>${esc(String(x))}</span>`).join('');
  }
  if (bars) {
    const entries = Object.entries(run.agg.lossBuckets).sort((a, b) => b[1] - a[1]);
    const top = entries.length ? entries[0][1] : 1;
    bars.innerHTML = entries.map(([reason, n], i) => {
      const label = REASON_CN[reason] || reason;
      return `<div class="bar"><span>${esc(label)}</span><i class="${i ? 'w' : ''}" style="width:${Math.round((n / top) * 100)}%"></i><em>${n}</em></div>`;
    }).join('');
  }
  if (hint) hint.textContent = stale ? T('ui.rvStale') : T('ui.rvLocalHint', { n: BATCH_N });
  if (flag) {
    const total = run.games.reduce((s, g) => s + (g.moments || []).length, 0);
    flag.hidden = !total;
    flag.textContent = T('ui.rvFlagBatch', { n: total, g: run.agg.games });
  }
}

// 单局报告（喂 AI 的那份；懒算一次挂在 match 上）
function currentBattleReport() {
  if (!match) return null;
  if (match.report) return match.report;
  match.report = buildBattleReport({
    map: match.map,
    result: match.result,
    who: 0,
    setup: {
      seed: match.seedStr, mapKey: userMapKey(), opponent: match.names[1], tank: match.names[0],
      strategy: strategyEl ? strategyEl.value : '', codeHash: codeHashOf(editorEl.value),
    },
  });
  return match.report;
}

function currentBatch() {
  const run = batchRuns.train;
  return run ? { setup: run.setup, at: run.at, games: run.games } : null;
}

const reviewMsg = (text, bad) => { reviewMsgText = text || ''; reviewMsgBad = !!bad; };

function renderReviewMain() {
  const main = $id('reviewMain');
  if (!main) return;
  if (reviewMode === 'single') {
    const rep = currentBattleReport();
    if (!rep) { main.innerHTML = `<div class="rpt">${esc(T('ui.rvNoBattle'))}</div>`; return; }
    const ctx = new Map((match.entries || []).map((e) => [e.t, e.html]));
    const rows = [];
    for (const mo of rep.moments) {
      const near = ctx.get(mo.t);
      if (near) rows.push(`<div class="ln dimd"><span class="t">t=${String(mo.t).padStart(3, '0')}</span>${near}</div>`);
      rows.push(
        `<div class="ln flag"><span class="t">t=${String(mo.t).padStart(3, '0')}</span>`
        + `<span class="w">⚠ ${esc(mo.label)}</span><span class="why">${esc(mo.why)}</span></div>`,
      );
    }
    if (!rows.length) rows.push(`<div class="ln dimd">${esc(T('ui.rvNoFlag'))}</div>`);
    const last = (match.entries || [])[(match.entries || []).length - 1];
    if (last) rows.push(`<div class="ln dimd"><span class="t">t=${String(last.t).padStart(3, '0')}</span>${last.html}</div>`);
    main.innerHTML = `<div class="tl">${rows.join('')}</div><div class="wrhint" style="margin-top:8px">${esc(T('ui.rvRuleNote'))}</div>`;
    return;
  }
  const batch = currentBatch();
  const cmp = lastCompare ? renderCompare() : '';
  if (!batch) {
    const why = batchFailMsg ? T('ui.rvFail', { msg: batchFailMsg }) : T('ui.rvNever');
    main.innerHTML = `${cmp}<div class="rpt">${esc(why)}</div>`;
    return;
  }
  main.innerHTML = `${cmp}<pre class="rpt">${esc(renderBatchText(batch).join('\n'))}</pre>${renderIterTable()}${renderHistory()}`;
}

function renderCompare() {
  const c = lastCompare;
  if (!c) return '';
  const warn = (msg) => `<div class="wrfail" style="border-color:var(--warn);background:#2A2314;color:var(--warn);margin-bottom:12px">${esc(msg)}</div>`;
  const card = (label, before, after) => { // 任一侧为空时只显示有的那侧，不假装有对比
    const up = before != null && after != null && after > before;
    const flat = before != null && after != null && after <= before;
    return `<div class="bacard ${up ? 'up' : flat ? 'flat' : ''}"><b>${pctText(before)} → ${pctText(after)}</b>`
      + `<span>${esc(label)} · ${esc(T('ui.rvBefore'))}→${esc(T('ui.rvAfter'))}</span></div>`;
  };
  const cards = `<div class="ba">${card(T('ui.rvTrain'), c.before.train, c.after.train)}${card(T('ui.rvHoldout'), c.before.holdout, c.after.holdout)}</div>`;
  const v = compareVerdict({ before: c.before, after: c.after, keys: c.keys, curKey: setupKey() });
  if (v.state === 'setup-changed') return `${cards}${warn(T('ui.rvSetupChanged'))}`;
  if (v.state === 'no-before') return `${cards}${warn(T('ui.rvNoBaseline'))}`;
  if (v.state === 'no-after') return `${cards}${warn(T('ui.rvNoAfter'))}`;
  const note = v.gained
    ? T('ui.rvGain', { before: pctText(c.before.holdout), after: pctText(c.after.holdout) })
    : T('ui.rvNoGain', {
      a: `${pctText(c.before.train)}→${pctText(c.after.train)}`,
      b: `${pctText(c.before.holdout)}→${pctText(c.after.holdout)}`,
    });
  return `${cards}<div class="wrhint" style="margin-bottom:12px;color:${v.gained ? 'var(--ok)' : 'var(--warn)'}">${esc(note)}</div>`;
}

function renderHistory() {
  if (!reviewHistory.length) return '';
  const rows = reviewHistory.map((h, i) => `<tr><td>${esc(i === reviewHistory.length - 1 ? T('ui.rvCurrent') : T('ui.rvRound', { n: h.round }))}</td>`
    + `<td>${pctText(h.after.train)}</td><td>${pctText(h.after.holdout)}</td></tr>`).join('');
  return `<h4 style="font-size:12px;color:var(--dim);letter-spacing:1px;margin:16px 0 6px">${esc(T('ui.rvHist'))}</h4>`
    + `<table><thead><tr><th>#</th><th>${esc(T('ui.rvTrain'))}</th><th>${esc(T('ui.rvHoldout'))}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderReviewSide() {
  const side = $id('reviewSide');
  if (!side) return;
  const st = sdkState();
  const aiLabel = st === 'need-login' ? T('ui.rvNeedLogin') : T('ui.rvAi');
  const parts = [];
  parts.push(`<h4>${esc(T('ui.rvDiagTitle'))}</h4>`);
  if (reviewProposal && reviewProposal.diagnoses.length) {
    for (const d of reviewProposal.diagnoses) {
      parts.push(`<div class="diag"><div class="n">${esc(d.title)}${d.detail ? `：${esc(d.detail)}` : ''}</div>`
        + `${d.evidence ? `<div class="ev">${esc(d.evidence)}</div>` : ''}</div>`);
    }
  } else {
    parts.push(`<div class="wrhint">${esc(T('ui.rvDiagEmpty'))}</div>`);
  }
  parts.push(`<button class="btn ghost" id="rvAiBtn" style="padding:5px 12px;font-size:11px"${reviewBusy || st === 'absent' ? ' disabled' : ''}>${esc(reviewBusy ? T('ui.rvAiRunning') : aiLabel)}</button>`);
  if (st === 'absent') parts.push(`<div class="wrhint">${esc(T('ui.rvNoSdk'))}</div>`);
  if (reviewMsgText) parts.push(`<div class="wrhint" style="color:${reviewMsgBad ? 'var(--bad)' : 'var(--dim)'}">${esc(reviewMsgText)}</div>`);
  if (reviewProposal) {
    parts.push(`<div class="cmp" style="grid-template-columns:1fr">
      <div class="cmpcol"><h5>${esc(T('ui.rvOld'))}</h5>${esc(strategyEl ? strategyEl.value : '')}</div>
      <div class="cmpcol new"><h5>${esc(T('ui.rvNew'))}</h5>${esc(reviewProposal.strategy)}</div>
    </div>`);
    parts.push(`<div style="display:flex;gap:6px;margin-top:8px">
      <button class="btn ghost" id="rvAdoptBtn"${batchBusy ? ' disabled' : ''} style="padding:5px 12px;font-size:11px;border-color:#4C6B22;color:var(--p1)">${esc(T('ui.rvAdopt'))}</button>
      <button class="btn ghost" id="rvDropBtn" style="padding:5px 12px;font-size:11px">${esc(T('ui.rvDiscard'))}</button>
    </div>`);
  }
  if (reviewMode === 'batch') parts.push(`<div style="border-top:1px dashed var(--line);margin-top:10px;padding-top:10px">${renderIterPanel()}</div>`);
  side.innerHTML = parts.join('');
  if (reviewMode === 'batch') {
    loadIterModels(); // 模型表懒加载一次；失败会在面板里明示
    $id('itRunBtn')?.addEventListener('click', runIteration);
    $id('itHoldoutBtn')?.addEventListener('click', verifyIterHoldout);
    $id('itLogBtn')?.addEventListener('click', downloadIterLog);
    $id('itRestoreBtn')?.addEventListener('click', restoreIterBase);
    $id('itRounds')?.addEventListener('change', (ev) => { // 先落模块级状态再重渲染，否则选择会被打回默认
      iterRoundsChoice = Number(ev.target.value) || ITER_ROUND_CHOICES[0];
      renderReviewSide();
    });
  }
  const ai = $id('rvAiBtn');
  if (ai) ai.addEventListener('click', runAiReview);
  const adopt = $id('rvAdoptBtn');
  if (adopt) adopt.addEventListener('click', adoptProposal);
  const drop = $id('rvDropBtn');
  if (drop) drop.addEventListener('click', () => { reviewProposal = null; reviewMsg(''); renderReview(); });
}

function renderReview() {
  const title = $id('reviewTitle');
  const sub = $id('reviewSub');
  const flag = $id('reviewFlag');
  if (title) title.textContent = T(reviewMode === 'single' ? 'ui.rvTitleSingle' : 'ui.rvTitleBatch');
  if (sub) {
    if (reviewMode === 'single' && match) {
      const rep = currentBattleReport();
      sub.textContent = `seed ${match.seedStr} · ${match.names[0]} · ${match.names[1]} · ${T(rep.result.win ? 'ui.rvWin' : 'ui.rvLoss')}（${rep.result.reason}，t=${rep.result.ticks - 1}）`;
    } else if (reviewMode === 'batch' && batchRuns.train) {
      const s = batchRuns.train.setup;
      sub.textContent = `${s.tank} · ${s.opponent} · ${s.skill} · ${s.mapKey}`;
    } else sub.textContent = '';
  }
  if (flag) {
    const rep = reviewMode === 'single' ? currentBattleReport() : null;
    const n = rep ? rep.moments.length : 0;
    flag.hidden = !n;
    flag.textContent = T('ui.rvFlag', { n });
  }
  const dlText = $id('reviewDlTextBtn');
  if (dlText) dlText.hidden = reviewMode !== 'batch'; // 单局按老板口径只给 JSON
  renderReviewMain();
  renderReviewSide();
}

function openReview(mode) {
  if (mode === 'single' && !match) { showErr(T('ui.rvNoBattle')); return; }
  reviewMode = mode;
  reviewProposal = null;
  reviewMsg('');
  renderReview();
  openOverlay($id('reviewDrawer'));
}

async function runAiReview() {
  const st = sdkState();
  if (st === 'need-login') { if (llmCtl && llmCtl.login) llmCtl.login(); return; }
  if (st !== 'ready') { reviewMsg(T('ui.rvNoSdk'), true); renderReview(); return; }
  const strategy = strategyEl ? strategyEl.value : '';
  let prompt;
  try {
    if (reviewMode === 'single') {
      const rep = currentBattleReport();
      if (!rep) { reviewMsg(T('ui.rvNoBattle'), true); renderReview(); return; }
      prompt = buildReviewPrompt({ mode: 'single', payload: reviewPayloadFromBattle(rep), strategy });
    } else {
      const batch = currentBatch();
      if (!batch) { reviewMsg(T('ui.rvNever'), true); renderReview(); return; }
      prompt = buildReviewPrompt({ mode: 'batch', payload: reviewPayloadFromBatch(batch), strategy });
    }
  } catch (e) { reviewMsg(T('ui.rvAiFail', { msg: String((e && e.message) || e) }), true); renderReview(); return; }
  reviewBusy = true;
  reviewMsg(T('ui.rvAiRunning'));
  renderReview();
  const t0 = Date.now();
  try {
    const { text } = await llmCtl.chat(prompt, { model: iterModel() || undefined });
    const parsed = parseReviewReply(text);
    if (!parsed) {
      reviewMsg(T('ui.rvBadReply'), true);
      setGenLog(buildGenLog({
        outcome: 'review-unparsable', reason: 'parseReviewReply returned null', at: t0, durationMs: Date.now() - t0,
        env: genEnv(), strategy, skill: userSkill(),
        attempts: [{ n: 1, promptChars: prompt.length, replyChars: String(text || '').length, replyHead: String(text || '').slice(0, 500), extracted: false }],
      }));
    } else {
      reviewProposal = parsed;
      reviewMsg(T('ui.rvCost', { kb: (prompt.length / 1024).toFixed(1) }));
    }
  } catch (e) {
    const m = mapLlmError(e);
    reviewMsg(T(m.key, m.vars), true);
    setGenLog(buildGenLog({
      outcome: 'review-sdk-error',
      reason: `${(e && e.name) || 'Error'}: ${String((e && (e.hint || e.message)) || e)}`,
      at: t0, durationMs: Date.now() - t0, env: genEnv(), strategy, skill: userSkill(), attempts: [],
    }));
  } finally {
    reviewBusy = false;
    renderReview();
  }
}

// 采纳：写回战术框 → 用现有「AI 由战术文字生成代码」把它变成脚本 → 重跑两组种子出对比。
// 只改战术文字而不重生成代码，胜率不会有任何变化——那样的「对比」是自欺，所以这里必须联动生成。
async function adoptProposal() {
  if (!reviewProposal || !strategyEl) return;
  if (batchBusy) { reviewMsg(T('ui.rvBusy'), true); renderReview(); return; } // 跑批期间采纳会读到上一轮旧数字
  const curKey = setupKey();
  // 基线必须是「当前这套对局设置」下跑的：否则「A 对手的改前」和「B 对手的改后」并列出来是假对比
  const baseKeys = [batchRuns.train && batchRuns.train.key, batchRuns.holdout && batchRuns.holdout.key].filter(Boolean);
  if (baseKeys.length && baseKeys.some((k) => k !== curKey)) {
    reviewMsg(T('ui.rvBaselineStale'), true);
    renderReview();
    return;
  }
  const before = {
    train: batchRuns.train ? batchRuns.train.agg.winRate : null,
    holdout: batchRuns.holdout ? batchRuns.holdout.agg.winRate : null,
  };
  strategyEl.value = reviewProposal.strategy;
  saveDraft();
  reviewProposal = null;
  reviewMsg(T('ui.rvAdopted'));
  renderReview();
  const codeBefore = editorEl.value;
  if (sdkState() !== 'ready') { // 态①：没有 AI 通道 —— 战术已写入，但代码还是旧版，胜率不可能变
    reviewMsg(T('ui.rvAdoptNoSdk'), true);
    setGenLog(buildGenLog({
      outcome: 'adopt-no-sdk', reason: `sdk=${sdkState()}; strategy written, code unchanged`,
      env: genEnv(), strategy: strategyEl.value, skill: userSkill(), attempts: [],
    }));
    renderReview();
    return;
  }
  // generateScript 自己吞掉所有失败并把真因（哪次尝试、模型回了什么、gate 报什么错、401 还是没代码块）
  // 写进诊断日志，所以这里靠它的返回值分流，且**不再覆盖**那份日志——否则用户下载到的只剩一句「代码没变」。
  const gen = await generateScript();
  if (gen && !gen.ok) { // 态②：生成失败 —— 归因用真实 outcome，诊断日志保留 generateScript 写的载荷
    reviewMsg(T('ui.rvAdoptGenFail', { msg: `${gen.outcome}: ${gen.reason || ''}`.trim() }), true);
    renderReview();
    return;
  }
  if (editorEl.value === codeBefore) { // 态③：生成成功但代码没变 —— 不做一个必然无差异的对比
    reviewMsg(T('ui.rvAdoptNoChange', { msg: (gen && gen.outcome) || 'unknown' }), true);
    if (lastGenLog) setGenLog({ ...lastGenLog, adopt: { outcome: 'adopt-code-unchanged', genOutcome: (gen && gen.outcome) || null } });
    else setGenLog(buildGenLog({ outcome: 'adopt-code-unchanged', reason: 'editor content identical after generateScript', env: genEnv(), strategy: strategyEl.value, skill: userSkill(), attempts: [] }));
    renderReview();
    return;
  }
  await runBatch('train');
  await runBatch('holdout');
  const after = {
    train: batchRuns.train ? batchRuns.train.agg.winRate : null,
    holdout: batchRuns.holdout ? batchRuns.holdout.agg.winRate : null,
  };
  lastCompare = {
    before,
    after,
    // 对比是否成立，看的是被比较数据自身的 setup key（不是「采纳开始/结束」两个时刻的 key）
    keys: [curKey, batchRuns.train && batchRuns.train.key, batchRuns.holdout && batchRuns.holdout.key].filter(Boolean),
  };
  reviewHistory = reviewHistory.concat([{ round: reviewHistory.length + 1, before, after }]);
  reviewMode = 'batch';
  reviewMsg('');
  renderReview();
}



// ---------- 调试用假 AI（仅 ?fakellm=1 生效）----------
// 为什么需要它：迭代闭环（复盘→生成→评分→择优）在没有登录票的环境里根本跑不到，
// 只靠纯函数单测就宣称「闭环可用」属于假绿。带这个参数时用固定回复驱动整条链路做端到端验证；
// 不带参数时这段代码零参与（线上行为不变），且启用时界面会明示「假 AI（调试）」。
const FAKE_LLM = (() => { try { return new URLSearchParams(location.search).get('fakellm') === '1'; } catch { return false; } })();
// 假 AI 的单次延时（毫秒，仅调试用）：真实模型一次要十几秒，假 AI 30ms 会让 10 轮在 2~3 秒内跑完，
// 中断/改设置这类「跑到一半」的断言根本来不及命中。用 ?fakedelay= 把节奏调到接近真实。
const FAKE_DELAY = (() => {
  try { return Math.min(3000, Math.max(0, Number(new URLSearchParams(location.search).get('fakedelay')) || 30)); } catch { return 30; }
})();
function makeFakeLlm() {
  let genCall = 0;
  const VARIANTS = [
    // 变体 1：只在对齐时开火（稳）
    'export default function decide(api) {\n  const me = api.me(); const e = api.enemy();\n  if (me.hp < 40) { const k = api.nearestItem("medkit"); if (k) return api.moveTo(k); }\n  const s = api.nearestStar(); if (s && api.distTo(s) <= 4) return api.moveTo(s);\n  if (api.canFire() && api.enemyVisible() && (me.x === e.x || me.y === e.y)) return api.fireAt(e);\n  return api.moveTo(s || e);\n}',
    // 变体 2：一味追击（弱）
    'export default function decide(api) {\n  const e = api.enemy();\n  if (api.canFire() && api.enemyVisible()) return api.fireAt(e);\n  return api.moveTo(e);\n}',
    // 变体 3：躲弹道 + 对齐开火 + 回血（强）
    'export default function decide(api) {\n  const me = api.me(); const e = api.enemy();\n  if (me.hp < 40) { const k = api.nearestItem("medkit"); if (k) return api.moveTo(k); }\n  const b = api.enemyBullet();\n  if (b && (b.x === me.x || b.y === me.y)) {\n    const alt = (b.x === me.x) ? { x: me.x + 1, y: me.y } : { x: me.x, y: me.y + 1 };\n    if (api.walkable(alt)) return api.moveTo(alt);\n  }\n  const s = api.nearestStar(); if (s && api.distTo(s) <= 4) return api.moveTo(s);\n  if (api.canFire() && api.enemyVisible() && (me.x === e.x || me.y === e.y)) return api.fireAt(e);\n  return api.moveTo(s || e);\n}',
  ];
  return {
    models: async () => ({ models: [{ id: 'fake-model-a' }, { id: 'fake-model-b' }], default_model: 'fake-model-a' }),
    chat: async (prompt, o) => {
      await new Promise((r) => setTimeout(r, FAKE_DELAY));
      if (o && o.signal && o.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      if (String(prompt).includes('脚本生成器')) { // 生成代码
        const code = VARIANTS[genCall++ % VARIANTS.length];
        return { text: '```js\n' + code + '\n```' };
      }
      return { // 复盘
        text: '```json\n' + JSON.stringify({
          diagnoses: [{ title: '假 AI 诊断', detail: '仅用于端到端验证', evidence: 't=1' }],
          strategy: `假 AI 改写第 ${genCall + 1} 版：躲弹道、对齐才开火、血低回血。`,
          changes: [`第 ${genCall + 1} 版改动`],
        }) + '\n```',
      };
    },
  };
}

// ---------- 循环迭代：跑多版、每版真打 12 局评分、择优应用 ----------
// 用户拍板（2026-08-20）：迭代结束**总是应用训练组最强那版**（不设留出组门槛）；
// 留出组验证做成事后可选按钮，不占迭代时间。
// 单轮复盘之所以会让胜率变低，是因为流程里没有任何一步检验 AI 的建议——迭代补的正是择优压力。
const ITER_ROUND_CHOICES = [3, 5, 10];
const ITERBASE_KEY = 'agentank.iterbase'; // 迭代前的原版快照（崩溃/关页也能回退，草稿会被中间版覆盖）
let iterRoundsChoice = ITER_ROUND_CHOICES[0]; // 轮数选择必须有模块级状态：只靠 DOM 会在重渲染时被打回默认
let iterBaseErr = ''; // 原版快照写失败的原因（非空 = B1 的保护这次不生效，必须明示）
let iterState = null;
let iterModels = null;   // {models:[{id}], default_model} | {error:'...'}
let iterMsgText = '';
let iterMsgBad = false;
const iterMsg = (t, bad) => { iterMsgText = t || ''; iterMsgBad = !!bad; };
const iterModel = () => (($id('itModel') || {}).value || '');
const iterRounds = () => iterRoundsChoice;

// 迭代前留一份原版，独立于草稿（草稿会被每轮中间版覆盖）。
// 快照必须绑定「哪台车 + 哪种登录态」：否则切台或换账号后点回退，会把别台/别人的代码盖过来。
// 写入不是必然成功（隐私模式/配额满/file:）——静默失败等于 B1 的保护在最需要时不存在，所以要 read-back 并回传原因。
function writeIterBase() {
  // B11：已有**属于本台**的快照就不覆盖 —— 连跑两次迭代时，第二次的「原版」其实已是 AI 那版，
  // 覆盖等于把玩家手写的原版从草稿与快照两处同时抹掉（存档没有读取入口，等于丢）。
  const prev = readIterBase();
  if (prev && iterBaseOwns(prev)) return { ok: true, err: '', kept: true };
  const t = curTank();
  const snap = {
    strategy: strategyEl ? strategyEl.value : '', code: editorEl.value,
    tank: myTankLabel(), tankId: (t && t.id) || null, mode: garage.mode, ts: Date.now(),
  };
  try {
    localStorage.setItem(ITERBASE_KEY, JSON.stringify(snap));
    const back = readIterBase();
    if (!back || back.code !== snap.code || back.tank !== snap.tank) {
      return { ok: false, err: 'read-back mismatch after write' };
    }
    return { ok: true, err: '' };
  } catch (e) {
    return { ok: false, err: `${(e && e.name) || 'Error'}: ${String((e && e.message) || e)}` };
  }
}
function readIterBase() { try { return JSON.parse(localStorage.getItem(ITERBASE_KEY) || 'null'); } catch { return null; } }
// 这份快照是不是「当前这台车」的：云端坦克 id 全账号唯一，优先按 id 判；
// 只比显示名挡不住「同为云端、换账号但没点登出」——两个账号的第一台车默认同名概率极高（评审 B12）。
function iterBaseOwns(b) {
  if (!b) return false;
  const t = curTank();
  const curId = (t && t.id) || null;
  if (b.tankId) return curId === b.tankId;
  if (curId) return false; // 快照没 id 而当前有 id：来源不同，按不属于处理
  return b.tank === myTankLabel() && (!b.mode || !garage.mode || b.mode === garage.mode);
}
function clearIterBase() { try { localStorage.removeItem(ITERBASE_KEY); } catch { /* 忽略 */ } }
function restoreIterBase() {
  const b = readIterBase();
  if (!b) return;
  if (!iterBaseOwns(b)) { // 不是本台/本账号的快照：拒绝，避免把别台别人的代码盖过来
    iterMsg(T('ui.itRestoreOtherTank', { tank: b.tank || '—' }), true);
    renderReview();
    return;
  }
  // B10：快照恢复的是「战术文字 + 代码」两样，差异判定也必须看两样 ——
  // 代码相同、只有战术文字不同是这个功能里的常态（同码轮被判无效、玩家只改策略文本），
  // 若只比代码，战术文字会被静默覆盖且无处可寻（仓库既有教训：战术文字刷新即丢）。
  const cur = editorEl.value;
  const curStrategy = strategyEl ? strategyEl.value : '';
  const dirty = cur !== String(b.code || '') || curStrategy !== String(b.strategy || '');
  if (dirty) {
    archiveCopy({ name: myTankLabel(), code: cur, strategy: curStrategy, skill: userSkill(), v: 0 }, 'iter-restore');
    if (typeof confirm === 'function' && !confirm(T('ui.itRestoreConfirm'))) return; // eslint-disable-line no-alert
  }
  if (strategyEl) strategyEl.value = String(b.strategy || '');
  editorEl.value = String(b.code || '');
  saveDraft();
  refreshSkillHint();
  clearIterBase();
  iterMsg(T('ui.itRestored'));
  renderReview();
}

async function loadIterModels() {
  if (iterModels || !llmCtl || typeof llmCtl.models !== 'function') return;
  try {
    const r = await llmCtl.models();
    iterModels = r && Array.isArray(r.models) ? r : { models: [], default_model: (r && r.default_model) || '' };
  } catch (e) { // 降级可观测：取不到模型表就明示原因，仍可用平台默认跑
    iterModels = { models: [], default_model: '', error: `${(e && e.name) || 'Error'}: ${String((e && (e.hint || e.message)) || e)}` };
  }
  renderReview();
}

function renderIterPanel() {
  const st = sdkState();
  const running = !!(iterState && iterState.running);
  const parts = [`<h4>${esc(T('ui.itTitle'))}${FAKE_LLM ? ` <span class="fl">${esc(T('ui.itFakeChip'))}</span>` : ''}</h4>`];
  const snap = readIterBase();
  if (snap) { // 崩溃/关页后也能回退到迭代前那版；标明属于哪台车，避免串台
    parts.push(`<div class="wrhint">${esc(T('ui.itRestoreHint'))}${snap.tank ? esc(T('ui.itRestoreOf', { tank: snap.tank })) : ''}</div>`);
    parts.push(`<button class="btn ghost" id="itRestoreBtn" style="padding:5px 12px;font-size:11px">${esc(T('ui.itRestore'))}</button>`);
  }
  if (iterBaseErr) { // 反向告警：保护没生效必须让玩家在开跑前就知道
    parts.push(`<div class="wrhint" style="color:var(--warn)">${esc(T('ui.itSnapshotFail', { msg: iterBaseErr }))}</div>`);
  }
  if (st === 'absent') { parts.push(`<div class="wrhint">${esc(T('ui.rvNoSdk'))}</div>`); return parts.join(''); }
  if (st === 'need-login') { parts.push(`<div class="wrhint">${esc(T('ui.rvNeedLogin'))}</div>`); return parts.join(''); }

  const models = (iterModels && iterModels.models) || [];
  const def = (iterModels && iterModels.default_model) || '';
  const opts = [`<option value="">${esc(T('ui.itModelDefault'))}${def ? ` · ${esc(def)}` : ''}</option>`]
    .concat(models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`)).join('');
  parts.push(`<label style="width:auto;display:flex;gap:6px;align-items:center;font-size:11px">${esc(T('ui.itModel'))}
    <select id="itModel" style="flex:1;font-size:11px;padding:3px 6px"${running ? ' disabled' : ''}>${opts}</select></label>`);
  if (iterModels && iterModels.error) parts.push(`<div class="wrhint" style="color:var(--warn)">${esc(T('ui.itModelsFail', { msg: iterModels.error }))}</div>`);
  const rounds = iterState && iterState.running ? iterState.rounds : iterRoundsChoice;
  parts.push(`<label style="width:auto;display:flex;gap:6px;align-items:center;font-size:11px">${esc(T('ui.itRounds'))}
    <select id="itRounds" style="flex:1;font-size:11px;padding:3px 6px"${running ? ' disabled' : ''}>${
    ITER_ROUND_CHOICES.map((n) => `<option value="${n}"${n === rounds ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`);
  const cost = iterationCost(rounds, BATCH_N);
  parts.push(`<div class="wrhint">${esc(T('ui.itCost', { min: Math.max(1, Math.round(cost.estMs / 60000)), ai: cost.aiCalls, m: cost.matches }))}</div>`);
  parts.push(`<button class="btn ghost" id="itRunBtn" style="padding:5px 12px;font-size:11px;${running ? '' : 'border-color:var(--accent);color:var(--accent)'}">${
    esc(running ? T('ui.itStop') : T('ui.itStart'))}</button>`);
  parts.push(`<div class="wrhint" id="itProgress" style="color:var(--accent)">${
    running ? esc(T('ui.itRunning', { r: iterState.round, n: iterState.rounds, step: iterState.step || '' })) : ''}</div>`);
  if (iterMsgText) parts.push(`<div class="wrhint" style="color:${iterMsgBad ? 'var(--warn)' : 'var(--ok)'}">${esc(iterMsgText)}</div>`);
  if (iterState && iterState.candidates.length > 1 && !running) {
    parts.push(`<button class="btn ghost" id="itHoldoutBtn" style="padding:5px 12px;font-size:11px">${esc(T('ui.itVerifyHoldout'))}</button>`);
    parts.push(`<button class="btn ghost" id="itLogBtn" style="padding:5px 12px;font-size:11px">${esc(T('ui.itDlLog'))}</button>`);
  }
  return parts.join('');
}

function renderIterTable() {
  if (!iterState || iterState.candidates.length <= 1) return '';
  const best = iterState.applied || pickBest(iterState.candidates);
  const rows = iterState.candidates.map((c) => {
    const isBest = best && c === best;
    const name = c.isBaseline ? T('ui.itBaselineRow') : String(c.round);
    const score = c.valid ? pctText(c.trainWinRate) : `<span style="color:var(--bad)">${esc(T('ui.itInvalid'))}</span>`;
    const note = c.valid
      ? esc((c.changes || []).slice(0, 2).join('；') || (c.isBaseline ? '—' : ''))
      : `<span style="color:var(--dim)">${esc(c.invalidReason || '')}</span>`;
    return `<tr${isBest ? ' class="me"' : ''}><td>${esc(name)}${isBest ? ` <span class="chipg" style="padding:0 6px">${esc(T('ui.itBest'))}</span>` : ''}</td>`
      + `<td>${score}</td><td style="font-size:11px">${note}</td></tr>`;
  }).join('');
  return `<h4 style="font-size:12px;color:var(--dim);letter-spacing:1px;margin:16px 0 6px">${esc(T('ui.itTitle'))}</h4>`
    + `<table><thead><tr><th>${esc(T('ui.itTblRound'))}</th><th>${esc(T('ui.itTblTrain'))}</th><th>${esc(T('ui.itTblNote'))}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// 运行中不整块重建侧栏：否则「停止」按钮的 DOM 每步被替换，用户（和自动化）经常点不中。
function iterTick() {
  const prog = $id('itProgress');
  if (!prog || !iterState) { renderReview(); return; }
  prog.textContent = T('ui.itRunning', { r: iterState.round, n: iterState.rounds, step: iterState.step || '' });
  const btn = $id('itRunBtn');
  if (btn) btn.textContent = T('ui.itStop');
  renderReviewMain(); // 候选表随轮次更新（main 重建不影响侧栏按钮）
}

async function runIteration() {
  if (iterState && iterState.running) { // 按钮兼作停止
    iterState.abort = true;
    if (iterState.ctl) { try { iterState.ctl.abort(); } catch { /* 忽略 */ } }
    iterState.step = T('ui.itStopping');
    iterTick(); // 立刻给反馈，否则用户以为没点上又点一次
    return;
  }
  const st = sdkState();
  if (st === 'need-login') { if (llmCtl && llmCtl.login) llmCtl.login(); return; }
  if (st !== 'ready') { iterMsg(T('ui.rvNoSdk'), true); renderReview(); return; }
  if (batchBusy) { iterMsg(T('ui.rvBusy'), true); renderReview(); return; }
  if (!batchRuns.train || !batchRuns.train.agg.games) { iterMsg(T('ui.itNeedBaseline'), true); renderReview(); return; }

  const rounds = iterRounds();
  const model = iterModel();
  const lockKey = setupKey(); // 迭代要跑几分钟，期间对手/技能/地图可点：跨设置的胜率不能放进同一个候选池比较
  const snapRes = writeIterBase();
  iterBaseErr = snapRes.ok ? '' : snapRes.err;
  const baseline = {
    round: 0, isBaseline: true, valid: true,
    strategy: strategyEl.value, code: editorEl.value, codeHash: codeHashOf(editorEl.value),
    trainWinRate: batchRuns.train.agg.winRate,
    holdoutWinRate: batchRuns.holdout ? batchRuns.holdout.agg.winRate : null,
    batch: currentBatch(),
    batchKey: batchRuns.train.key,
  };
  iterState = {
    running: true, rounds, model, round: 0, step: '', candidates: [baseline], baseline,
    abort: false, stopped: 'done', applied: null, at: new Date().toISOString(), lockKey, fake: FAKE_LLM,
    ctl: (typeof AbortController === 'function' ? new AbortController() : null),
  };
  iterMsg('');
  renderReview();
  try {
    for (let r = 1; r <= rounds; r++) {
      if (iterState.abort) { iterState.stopped = 'aborted'; break; }
      if (setupKey() !== lockKey) { iterState.stopped = 'setup-changed'; break; } // 中途改了设置：立刻停，别拿两套设置比
      iterState.round = r;
      const base = nextRoundBase(iterState.candidates) || baseline; // 爬山：从当前最优起跳
      strategyEl.value = base.strategy;
      editorEl.value = base.code;
      const cand = { round: r, model: model || 'default', valid: false };
      iterState.step = T('ui.itStepReview');
      iterTick();
      let parsed = null;
      try {
        const prompt = buildReviewPrompt({
          mode: 'batch', strategy: base.strategy,
          payload: reviewPayloadFromBatch(base.batch || currentBatch()),
        });
        const { text } = await llmCtl.chat(prompt, { model: model || undefined, signal: iterState.ctl ? iterState.ctl.signal : undefined });
        parsed = parseReviewReply(text);
        // 「解析不出」必须带载荷，否则日志里判不出是被截断、给了散文、还是缺字段（评审 B6）
        if (!parsed) cand.invalidReason = `review unparsable: chars=${String(text || '').length} head=${String(text || '').slice(0, 200)}`;
      } catch (e) {
        cand.invalidReason = `review ${(e && e.name) || 'Error'}: ${String((e && (e.hint || e.message)) || e)}`;
      }
      if (!parsed) { iterState.candidates.push(cand); continue; } // 无效轮不打断迭代
      cand.strategy = parsed.strategy;
      cand.changes = parsed.changes;
      iterState.step = T('ui.itStepGen');
      iterTick();
      strategyEl.value = parsed.strategy;
      // noDraft：迭代期间不许把中间版本写进草稿，否则崩溃/关页后玩家原版不可恢复（评审 B1）
      const gen = await generateScript({ model: model || undefined, signal: iterState.ctl ? iterState.ctl.signal : undefined, noDraft: !iterBaseErr });
      if (!gen || !gen.ok) {
        cand.invalidReason = `gen ${(gen && gen.outcome) || 'failed'}: ${(gen && gen.reason) || ''}`.trim();
        iterState.candidates.push(cand);
        continue;
      }
      if (editorEl.value === base.code) { cand.invalidReason = 'gen produced identical code'; iterState.candidates.push(cand); continue; }
      cand.code = editorEl.value;
      cand.codeHash = codeHashOf(cand.code);
      iterState.step = T('ui.itStepEval', { n: BATCH_N });
      iterTick();
      const run = await runBatch('train');
      if (!run) { cand.invalidReason = `eval failed: ${batchFailMsg}`; iterState.candidates.push(cand); continue; }
      if (run.key !== lockKey) { // 这一轮是在别的设置下打的：不入池，立刻停
        cand.invalidReason = 'setup changed during eval';
        iterState.candidates.push(cand);
        iterState.stopped = 'setup-changed';
        break;
      }
      cand.trainWinRate = run.agg.winRate;
      cand.valid = true;
      cand.batch = { setup: run.setup, at: run.at, games: run.games };
      cand.batchKey = run.key;
      iterState.candidates.push(cand);
    }
  } catch (e) {
    iterState.stopped = 'error';
    iterMsg(`${(e && e.name) || 'Error'}: ${String((e && e.message) || e)}`, true);
  }
  // 收尾：总是应用训练组最强那版（含基线——迭代没赢过原版时就保留原版）
  const best = pickBest(iterState.candidates) || baseline;
  strategyEl.value = best.strategy;
  editorEl.value = best.code;
  saveDraft();
  refreshSkillHint();
  if (best.batch) { // 胜率区回到「被应用那版」的成绩，key 用那批数据自己的（不能盖成当前时刻，会骗过 rvStale）
    batchRuns.train = {
      games: best.batch.games, agg: aggregateBatch(best.batch.games),
      setup: best.batch.setup, at: best.batch.at, key: best.batchKey || lockKey, ms: 0,
    };
  }
  // 留出组那份是**原版代码**的成绩：换了版就必须清掉，否则界面把它当成当前这版的留出组并列展示
  if (!best.isBaseline) batchRuns.holdout = null;
  iterState.applied = best;
  iterState.running = false;
  iterState.step = '';
  const tried = iterState.candidates.filter((c) => !c.isBaseline);
  const validTried = tried.filter((c) => c.valid).length;
  if (best.isBaseline) iterMsg(validTried ? T('ui.itDoneBaseline', { n: tried.length }) : T('ui.itNoValid', { n: tried.length }), true);
  else if (iterState.stopped === 'setup-changed') iterMsg(T('ui.itSetupChanged'), true);
  else if (iterState.stopped === 'aborted') iterMsg(T('ui.itAborted', { msg: `#${best.round} ${pctText(best.trainWinRate)}` }));
  else iterMsg(T('ui.itDone', { r: best.round, p: pctText(best.trainWinRate) }));
  lastCompare = null; // 迭代有自己的候选清单，不复用单次采纳的对比卡
  renderGauge();
  renderReview();
}

async function verifyIterHoldout() {
  if (batchBusy) { iterMsg(T('ui.rvBusy'), true); renderReview(); return; }
  const run = await runBatch('holdout');
  if (!run) { iterMsg(T('ui.rvFail', { msg: batchFailMsg }), true); renderReview(); return; }
  const b = iterState && iterState.baseline ? iterState.baseline.holdoutWinRate : null;
  iterMsg(T('ui.itHoldoutRes', { p: pctText(run.agg.winRate), b: pctText(b) }), b != null && run.agg.winRate <= b);
  renderReview();
}

function downloadIterLog() {
  if (!iterState) return;
  const log = buildIterationLog({
    at: iterState.at,
    baseSnapshotErr: iterBaseErr,
    setup: { ...(batchRuns.train ? batchRuns.train.setup : {}), model: iterState.model || 'default', rounds: iterState.rounds },
    baseline: iterState.baseline,
    candidates: iterState.candidates.filter((c) => !c.isBaseline),
    applied: iterState.applied,
    stopped: iterState.stopped,
    fakeLlm: !!iterState.fake,
  });
  downloadText(`agentank-iteration-${Date.now()}.json`, JSON.stringify(log, null, 2), 'application/json');
}

$id('battleJsonBtn')?.addEventListener('click', () => {
  const rep = currentBattleReport();
  if (!rep) { showErr(T('ui.rvNoBattle')); return; }
  downloadText(battleReportFilename(new Date(), match.seedStr), JSON.stringify(rep, null, 2), 'application/json');
});
$id('battleReviewBtn')?.addEventListener('click', () => openReview('single'));
$id('wrRunBtn')?.addEventListener('click', () => { runBaseline(); });
$id('wrReviewBtn')?.addEventListener('click', () => openReview('batch'));
$id('reviewCloseBtn')?.addEventListener('click', closeOverlay);
$id('reviewDlTextBtn')?.addEventListener('click', () => {
  const batch = currentBatch();
  if (!batch) return;
  downloadText(batchReportFilename(new Date(), 'txt'), renderBatchText(batch).join('\n'), 'text/plain;charset=utf-8');
});
$id('reviewDlJsonBtn')?.addEventListener('click', () => {
  if (reviewMode === 'single') {
    const rep = currentBattleReport();
    if (!rep) return;
    downloadText(battleReportFilename(new Date(), match.seedStr), JSON.stringify(rep, null, 2), 'application/json');
    return;
  }
  const batch = currentBatch();
  if (!batch) return;
  downloadText(batchReportFilename(new Date(), 'json'), JSON.stringify({ kind: 'agentank-batch', schema: 1, ...batch, agg: aggregateBatch(batch.games) }, null, 2), 'application/json');
});
renderGauge();

if (FAKE_LLM) { // 调试：用假 AI 驱动完整迭代闭环（界面明示，避免被当成真实结果）
  llmConnect(makeFakeLlm());
  genMsg('假 AI（调试）：?fakellm=1 已启用，结果不代表真实模型');
}

// ---------- Play 用户支持（仅 play 部署环境激活；file:/匿名/SDK 不可用时零回归） ----------
initPlay({
  T, L,
  editorGet: () => editorEl.value,
  editorSet: (code) => { editorEl.value = code; refreshSkillHint(); },
  compileScript, guardWrap,
  evalOk: EVAL_OK, // 线上（CSP 禁 eval）为 false：闸门走结构校验、跑局走沙箱
  // 禁 eval 时挑战赛逐局丢进 blob Worker 跑；沙箱起不来则为 null（上层如实报错，不伪造战绩）
  sandboxMatch: SANDBOX_OK
    ? async (job, userCode) => {
      const r = await sandboxRun({ type: 'match', content: PACK, ...job }, { userCode });
      return r.result;
    }
    : null,
  userSkill, userMapKey, makeMap,
  defaultScript: DEFAULT_SCRIPT,
  ROSTER, LADDER_SEEDS,
  runMatch,
  getPack: () => PACK,
  workshopConnect: (cloud) => (wsConnectCloud ? wsConnectCloud(cloud) : null),
  garageConnect, // 登录成功：车库切云端 + 登录时刻逐台衔接（方案 v2）
  resetForLogout, // 登出：清车库/草稿、编辑器回默认模板（未入库匿名坦克先进存档）
  llmConnect, // 策略文本优先：AI 生成脚本按钮的 SDK LLM 接线（未登录=登录入口，无 SDK=降级提示）
});
