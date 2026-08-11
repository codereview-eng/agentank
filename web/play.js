// ---------- Play 用户支持（gamesrvd Play SDK v1） ----------
// 纯函数部分（可测）：注入 gating / Tank payload / BattleResult payload / 挑战赛聚合。
// 运行时部分 initPlay(ctx)：仅在 play 部署环境动态注入 SDK 脚本节点（src 指向 __sdk/v1.js），
// dist 静态产物零外链；SDK 不可用/未登录时所有现有功能零回归（匿名照旧）。

// 注入决策：file: 一律不注入；?play=1 显式开启直接注入；http(s) 无 flag 先探测 __sdk/v1.js 可用性
export function sdkInjectDecision(loc) {
  const protocol = (loc && loc.protocol) || '';
  const search = (loc && loc.search) || '';
  if (protocol !== 'http:' && protocol !== 'https:') return 'no';
  let flag = null;
  try { flag = new URLSearchParams(search).get('play'); } catch { /* 忽略 */ }
  if (flag === '1') return 'yes';
  return 'probe';
}

// Tank 实体 payload（与 spike schema 对齐：name/code/skill/version/is_active）
export function buildTankPayload(opts) {
  const o = opts || {};
  return {
    name: String(o.name || 'my-tank'),
    code: String(o.code || ''),
    skill: String(o.skill || ''),
    version: Number(o.version) > 0 ? Number(o.version) : 1,
    is_active: o.is_active === false ? false : true,
  };
}

// 版本递增：基于现有实体 version+1，缺省从 0 起
export function nextTankVersion(tank) {
  const v = Number(tank && tank.version);
  return (Number.isFinite(v) && v > 0 ? v : 0) + 1;
}

// BattleResult 实体 payload（与 spike schema 对齐：seed/map/opponent/winner/reason/ticks/stars_a/stars_b/elo/player）
export function buildBattleResultPayload(opts) {
  const o = opts || {};
  const r = o.result || {};
  const stars = Array.isArray(r.stars) ? r.stars : [0, 0];
  return {
    seed: String(o.seed), // spike schema：seed 为 string
    map: o.map,
    opponent: o.opponent,
    winner: r.winner === null || r.winner === undefined ? null : r.winner,
    reason: r.reason,
    ticks: r.ticks,
    stars_a: stars[0] ?? 0,
    stars_b: stars[1] ?? 0,
    elo: o.elo,
    player: o.player,
  };
}

// 挑战赛聚合：只统计本人记录；胜=winner===0，平=winner===null；胜率=(胜+0.5*平)/总（四舍五入%）
// baseline：对照 ELO 基线（如内置四家各 1200），rank = 终局 ELO 在 [baseline..., 我] 中的名次
export function summarizeChallenge(rows, player, baseline) {
  const mine = (rows || []).filter((r) => r && r.player === player);
  let wins = 0, draws = 0, losses = 0;
  const byOppMap = new Map();
  for (const r of mine) {
    let o = byOppMap.get(r.opponent);
    if (!o) { o = { opponent: r.opponent, w: 0, d: 0, l: 0 }; byOppMap.set(r.opponent, o); }
    if (r.winner === 0) { wins++; o.w++; }
    else if (r.winner === null || r.winner === undefined) { draws++; o.d++; }
    else { losses++; o.l++; }
  }
  const total = mine.length;
  const winRate = total ? Math.round(((wins + 0.5 * draws) / total) * 100) : 0;
  const elo = total ? (mine[mine.length - 1].elo ?? null) : null;
  const base = Array.isArray(baseline) ? baseline : [];
  let rank = null, rankTotal = null;
  if (elo !== null && elo !== undefined) {
    rank = 1 + base.filter((b) => Number(b) > Number(elo)).length;
    rankTotal = base.length + 1;
  }
  return { total, wins, draws, losses, winRate, elo, byOpp: [...byOppMap.values()], rank, rankTotal };
}

// 实体行取字段（兼容 {id,...fields} / {id,fields:{...}} / {id,data:{...}} 三种形态）
export function entityFields(row) {
  if (row && typeof row === 'object') {
    if (row.fields && typeof row.fields === 'object') return { id: row.id, ...row.fields };
    if (row.data && typeof row.data === 'object') return { id: row.id, ...row.data };
    return row;
  }
  return {};
}

// ---------- Agent Key（纯函数可测）：gated 判定 / 列表行 / 限额 / PlayError 映射 ----------
export const AGENT_KEY_MAX = 3; // 每 slug 限 3 把有效 key（与平台 #8355 对齐）

export function agentKeysGate(opts) {
  const o = opts || {};
  const api = o.api;
  return Boolean(o.user && api
    && typeof api.create === 'function'
    && typeof api.list === 'function'
    && typeof api.revoke === 'function');
}

function fmtTs(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().replace('T', ' ').slice(0, 16);
}

export function agentKeyRows(keys) {
  if (!Array.isArray(keys)) return [];
  return keys.map((k) => ({
    id: String((k && k.id) || ''),
    statusKey: (k && k.status) === 'active' ? 'play.akStActive' : 'play.akStRevoked',
    revocable: (k && k.status) === 'active',
    created: fmtTs(k && k.created_at),
    lastUsed: fmtTs(k && k.last_used_at),
  }));
}

export function agentKeyLimitReached(keys, max = AGENT_KEY_MAX) {
  if (!Array.isArray(keys)) return false;
  return keys.filter((k) => k && k.status === 'active').length >= max;
}

// PlayError {code,message,hint}（+429 携 resetsAtMs）→ {key: i18n 词条, vars}
export function mapAgentKeyError(e, nowMs = Date.now()) {
  const code = (e && e.code) || 'UNKNOWN';
  if (code === 'AUTH_REQUIRED') return { key: 'play.akErrAuth', vars: {} };
  if (code === 'AGENT_KEY_REVOKED') return { key: 'play.akErrRevoked', vars: {} };
  if (code === 'QUOTA_EXCEEDED') return { key: 'play.akErrQuota', vars: {} };
  if (code === 'RATE_LIMITED') {
    const at = Number(e && (e.resetsAtMs ?? (e.quota && e.quota.resetsAtMs))) || 0;
    return { key: 'play.akErrRate', vars: { secs: Math.max(0, Math.ceil((at - nowMs) / 1000)) } };
  }
  let msg = String((e && e.message) || e || '');
  if (e && e.hint) msg += ` (${e.hint})`;
  return { key: 'play.akErrGeneric', vars: { code, msg } };
}

// ---------- 运行时接线（浏览器专用；node --test 下不触发） ----------
export function initPlay(ctx) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const dec = sdkInjectDecision(window.location);
  if (dec === 'no') return;
  const base = window.location.pathname.replace(/[^/]*$/, '');
  const sdkUrl = base + '__sdk/v1.js';
  const inject = () => {
    const s = document.createElement('script');
    s.src = sdkUrl;
    s.onload = () => { bootPlay(ctx).catch((e) => console.log('play boot failed:', e && e.message)); };
    s.onerror = () => { /* SDK 不可用：匿名照旧，零回归 */ };
    document.head.appendChild(s);
  };
  if (dec === 'yes') { inject(); return; }
  // probe：仅当 __sdk/v1.js 真实可用才注入（file:/静态托管下 fetch 失败即放弃）
  try {
    fetch(sdkUrl, { method: 'GET' }).then((r) => { if (r && r.ok) inject(); }).catch(() => {});
  } catch { /* 忽略 */ }
}

async function bootPlay(ctx) {
  const Play = window.Play;
  if (!Play || typeof Play.init !== 'function') return;
  const T = ctx.T;
  const $ = (id) => document.getElementById(id);
  const chip = $('playUserChip'), loginBtn = $('playLoginBtn');
  const panel = $('playPanel'), statusEl = $('playStatus');
  const saveBtn = $('playSaveBtn'), fillBtn = $('playFillBtn'), challengeBtn = $('playChallengeBtn');
  const chBox = $('playChallenge'), chBody = $('playChallengeBody'), chSum = $('playChallengeSummary');
  let play;
  try { play = await Play.init(); } catch (e) { console.log('Play.init failed:', e && e.message); return; }

  // 未登录：只露登录按钮，云端区隐藏
  if (!play.user) {
    if (loginBtn) {
      loginBtn.style.display = '';
      loginBtn.textContent = T('play.login');
      loginBtn.addEventListener('click', () => play.login());
    }
    return;
  }

  // 登录态：header 显示用户名，云端区 + 挑战赛区亮起
  const me = play.user.id;
  if (chip) {
    chip.style.display = '';
    chip.textContent = T('play.user', { name: play.user.name || String(me).slice(0, 8) });
  }
  if (panel) panel.style.display = '';
  if (chBox) chBox.style.display = '';
  const status = (msg) => { if (statusEl) statusEl.textContent = msg; };
  bootAgentKeys(play, T); // Agent Key 管理：登录态 + agentKeys API 面齐备才亮，独立于 Tank/BR 实体
  const Tank = play.db && play.db.Tank;
  const BR = play.db && play.db.BattleResult;
  if (!Tank || !BR) { status(T('play.noEntity')); return; }

  // 我的坦克：登录后拉取云端最新，灌进编辑器（自测=复用现有开战链路）
  let myTank = null;
  const refreshTank = async () => {
    const rows = ((await Tank.list()) || []).map(entityFields).filter((r) => r.is_active !== false);
    myTank = rows.length ? rows[rows.length - 1] : null;
  };
  try { await refreshTank(); } catch (e) { status(T('play.loadFail', { msg: String(e && e.message || e) })); }
  const syncUi = () => {
    if (saveBtn) saveBtn.textContent = myTank ? T('play.saveTank', { v: nextTankVersion(myTank) }) : T('play.createTank');
    if (myTank) status(T('play.loaded', { v: myTank.version }));
    else status(T('play.none'));
  };
  if (myTank && myTank.code) ctx.editorSet(String(myTank.code));
  syncUi();

  // 生成/保存我的坦克（保存前走现有 compileScript 校验；version 递增 update）
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const code = ctx.editorGet();
    try { ctx.compileScript(code); } catch (e) { status(T('play.compileFail', { msg: String(e && e.message || e) })); return; }
    const payload = buildTankPayload({
      name: T('play.tankName'), code, skill: ctx.userSkill(),
      version: myTank ? nextTankVersion(myTank) : 1,
    });
    try {
      if (myTank) await Tank.update(myTank.id, payload);
      else await Tank.create(payload);
      await refreshTank();
      status(T('play.saved', { v: payload.version }));
      if (saveBtn) saveBtn.textContent = T('play.saveTank', { v: nextTankVersion(myTank) });
    } catch (e) { status(T('play.saveFail', { msg: String(e && e.message || e) })); }
  });

  // 一键回填默认流派代码（只改编辑器，不写云端）
  if (fillBtn) fillBtn.addEventListener('click', () => { ctx.editorSet(ctx.defaultScript); status(T('play.filled')); });

  // 挑战赛：我的坦克（编辑器脚本）× ROSTER 各 bot × LADDER_SEEDS 固定局，逐局写 BattleResult
  const tickAsync = () => new Promise((res) => setTimeout(res, 0));
  let running = false;
  if (challengeBtn) challengeBtn.addEventListener('click', async () => {
    if (running) return;
    running = true;
    try {
      let fn;
      try { fn = ctx.compileScript(ctx.editorGet()); } catch (e) { chSum.textContent = T('play.compileFail', { msg: String(e && e.message || e) }); return; }
      const gfn = ctx.guardWrap(fn, { count: 0, last: '' });
      gfn.skill = ctx.userSkill();
      const jobs = [];
      for (const r of ctx.ROSTER) for (const seed of ctx.LADDER_SEEDS) jobs.push({ r, seed });
      let myElo = 1200;
      for (let k = 0; k < jobs.length; k++) {
        const { r, seed } = jobs[k];
        chSum.textContent = T('play.challengeRunning', { done: k, total: jobs.length });
        await tickAsync();
        const result = ctx.runMatch({ seed, botA: gfn, botB: r.fn, map: ctx.makeMap(seed), content: ctx.getPack() });
        const sA = result.winner === null ? 0.5 : result.winner === 0 ? 1 : 0;
        const ea = 1 / (1 + 10 ** ((1200 - myElo) / 400));
        myElo = Math.round((myElo + 24 * (sA - ea)) * 100) / 100;
        const payload = buildBattleResultPayload({
          seed, map: ctx.userMapKey(), opponent: r.key, result, elo: myElo, player: me,
        });
        try { await BR.create(payload); } catch (e) { chSum.textContent = T('play.writeFail', { msg: String(e && e.message || e) }); return; }
      }
      // 聚合展示：list（owner scope）→ 胜率/排名（基线=内置四家各 1200）
      const rows = ((await BR.list()) || []).map(entityFields);
      const s = summarizeChallenge(rows, me, ctx.ROSTER.map(() => 1200));
      renderChallenge(ctx, s, chBody, chSum);
    } finally { running = false; }
  });
}

// Agent Key 管理：生成（明文一次展示+复制）/ 列表 / 吊销；错误统一走 mapAgentKeyError
function bootAgentKeys(play, T) {
  const $ = (id) => document.getElementById(id);
  const box = $('playAgentKeys');
  const api = play.agentKeys;
  if (!box || !agentKeysGate({ user: play.user, api })) return; // 未登录/SDK 无此面：保持 display:none，零回归
  box.style.display = '';
  const createBtn = $('akCreateBtn'), newBox = $('akNewKey'), newText = $('akNewKeyText');
  const copyBtn = $('akCopyBtn'), msgEl = $('akMsg'), body = $('akListBody');
  const msg = (t) => { if (msgEl) msgEl.textContent = t; };
  const showErr = (e) => { const m = mapAgentKeyError(e); msg(T(m.key, m.vars)); };
  let keys = [];
  const refresh = async () => { keys = (await api.list()) || []; render(); };
  const render = () => {
    if (!body) return;
    body.innerHTML = '';
    const rows = agentKeyRows(keys);
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5; td.style.color = 'var(--dim)'; td.textContent = T('play.akEmpty');
      tr.appendChild(td); body.appendChild(tr);
    }
    for (const r of rows) {
      const tr = document.createElement('tr');
      const td = (t) => { const el = document.createElement('td'); el.textContent = t; return el; };
      tr.appendChild(td(r.id));
      tr.appendChild(td(T(r.statusKey)));
      tr.appendChild(td(r.created));
      tr.appendChild(td(r.lastUsed));
      const act = document.createElement('td');
      if (r.revocable) {
        const b = document.createElement('button');
        b.className = 'btn ghost';
        b.style.cssText = 'padding:2px 8px;font-size:11px';
        b.textContent = T('play.akRevoke');
        b.addEventListener('click', async () => {
          try { await api.revoke(r.id); msg(''); await refresh(); } catch (e) { showErr(e); }
        });
        act.appendChild(b);
      }
      tr.appendChild(act);
      body.appendChild(tr);
    }
    if (createBtn) {
      const full = agentKeyLimitReached(keys);
      createBtn.disabled = full;
      if (full) msg(T('play.akLimit'));
    }
  };
  refresh().catch(showErr);
  if (createBtn) createBtn.addEventListener('click', async () => {
    try {
      const r = await api.create(); // 明文 key 只回一次：立即展示，永不回写云端
      if (newBox && newText && r && r.key) {
        newText.textContent = r.key;
        newBox.style.display = '';
        if (copyBtn) copyBtn.textContent = T('play.akCopy');
      }
      msg('');
      await refresh();
    } catch (e) { showErr(e); }
  });
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(newText ? newText.textContent : '');
      copyBtn.textContent = T('play.akCopied');
    } catch { /* 剪贴板不可用：明文仍在页面上可手动复制 */ }
  });
}

function renderChallenge(ctx, s, chBody, chSum) {
  const T = ctx.T, L = ctx.L;
  if (chSum) {
    chSum.textContent = T('play.summary', {
      total: s.total, w: s.wins, d: s.draws, l: s.losses,
      rate: s.winRate, elo: s.elo === null ? '-' : s.elo,
      rank: s.rank === null ? '-' : s.rank, rankTotal: s.rankTotal === null ? '-' : s.rankTotal,
    });
  }
  if (!chBody) return;
  chBody.innerHTML = '';
  for (const o of s.byOpp) {
    const bot = L.bots && L.bots[o.opponent];
    const tr = document.createElement('tr');
    const name = bot ? bot.tank : o.opponent;
    tr.innerHTML = `<td>${name}</td><td>${o.w}</td><td>${o.d}</td><td>${o.l}</td>`;
    chBody.appendChild(tr);
  }
}
