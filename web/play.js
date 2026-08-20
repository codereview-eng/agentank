// ---------- Play 用户支持（gamesrvd Play SDK v1） ----------
// 纯函数部分（可测）：注入 gating / Tank payload / BattleResult payload / 挑战赛聚合。
// 运行时部分 initPlay(ctx)：仅在 play 部署环境动态注入 SDK 脚本节点（src 指向 __sdk/v1.js），
// dist 静态产物零外链；SDK 不可用/未登录时所有现有功能零回归（匿名照旧）。

import { redactSecrets, aggregateBatch } from '../src/engine/analyze.js';

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

// Tank 实体 payload（与 schema 对齐：name/code/strategy/skill/version/is_active）
export function buildTankPayload(opts) {
  const o = opts || {};
  return {
    name: String(o.name || 'my-tank'),
    code: String(o.code || ''),
    strategy: String(o.strategy || ''),
    skill: String(o.skill || ''),
    version: Number(o.version) > 0 ? Number(o.version) : 1,
    is_active: o.is_active === false ? false : true,
  };
}

// ---------- 策略文本优先（strategy-first）：LLM 生成脚本的纯函数合同 ----------
// prompt 合同（spike 已验证：/docs/strategy-first-plan.md）：引擎 API 契约摘要 + 玩家装备技能 + 策略文本。
// 只要求模型输出一个 ```js 代码块；提取/编译失败一律 fail-closed，绝不静默塞坏代码。
export function buildLlmPrompt(opts) {
  const o = opts || {};
  const strategy = String(o.strategy || '').trim();
  const skill = String(o.skill || 'teleport');
  const feedback = String(o.feedback || '').trim(); // 上一轮编译错误（重试时带上）
  return [
    '你是坦克对战游戏的脚本生成器。根据玩家的策略描述，生成一个 JS 决策函数。',
    '合同（必须严格遵守）：',
    '- 只输出一个 ```js 代码块，里面是 export default function decide(api) {...}，不要任何解释文字。',
    '- 每 tick 调用一次 decide(api)，返回一个动作或 null。',
    '- api 查询：api.me()={x,y,hp,stars,skill,cloaked,stunned,frozen,poisoned,boosted,shielded,bulletInFlight,rapidShots,pierceShots,facing}；',
    '  api.enemy()={x,y,visible}（不可见时为最后目击位置）；api.enemyVisible()；api.canFire()；api.ready(name?)（无参=所装备技能，另可查 \'bomb\'/\'fire\'）；',
    '  api.zone()={ring,x0,y0,x1,y1,next}（毒圈）；api.inZone(p?)；api.nearestStar()；api.items()/api.nearestItem(kind?)（medkit/rapid/pierce）；',
    '  api.nearestGrass()（草丛隐蔽位）；api.safestCorner()；api.inGrass()；api.distTo(p)；api.walkable(p)；api.myBullet()/api.enemyBullet()；api.bombs()；api.tick()；api.rand()。',
    '- api 动作（作为返回值）：api.fireAt(p)；api.moveTo(p)；api.patrol()；api.useSkill(p?)（施放所装备技能，位移类带目标点）；api.throwBomb()。',
    `- 玩家装备技能：${skill}（8 选 1：teleport/shield/freeze/stun/overload/cloak/poison/boost）。`,
    feedback ? `- 上一次生成的代码编译失败，错误：${feedback}。请修正后重新输出完整代码块。` : '',
    `玩家策略描述：${strategy}`,
  ].filter(Boolean).join('\n');
}

// ---------- AI 复盘（战报 → 战术调整）：提示词合同 + 回复解析 ----------
// 分工纪律：「哪里不合理」由引擎的确定性规则判定（src/engine/analyze.js 的 moments），
// AI 只做两件事——解释这些时刻意味着什么、把玩家的战术文字改写掉。
// 所以提示词里必须带上已标好的时刻与指标，且**不塞全量事件**（预算 + 防模型自由发挥）。
const REVIEW_MAX_STRATEGY = 4000;

const pctS = (x) => `${Math.round((Number(x) || 0) * 100)}%`;

// 单局 JSON → 复盘载荷（丢掉 events，只留判定所需）
export function reviewPayloadFromBattle(rep) {
  const r = rep || {};
  const s = r.setup || {};
  const m = r.metrics || {};
  return {
    kind: 'single',
    setup: {
      seed: s.seed, mapKey: s.mapKey, opponent: s.opponent, tank: s.tank,
      skills: Array.isArray(s.skills) ? s.skills.slice() : [],
    },
    result: r.result || {},
    metrics: m,
    moments: (r.moments || []).map((x) => ({ t: x.t, label: x.label, severity: x.severity, why: x.why })),
  };
}

// 批量结果 → 复盘载荷（胜率 + 败因 + 逐局一行 + 高频不合理操作）
export function reviewPayloadFromBatch(batch) {
  const b = batch || {};
  const games = Array.isArray(b.games) ? b.games : [];
  const agg = aggregateBatch(games);
  const ruleCount = {};
  for (const g of games) for (const mo of g.moments || []) {
    const k = mo.label || mo.rule;
    ruleCount[k] = (ruleCount[k] || 0) + 1;
  }
  return {
    kind: 'batch',
    setup: b.setup || {},
    agg,
    games: games.map((g) => ({
      seed: g.seed, win: g.win, reason: g.reason,
      accuracy: (g.metrics || {}).accuracy, dmgDealt: (g.metrics || {}).dmgDealt,
      dmgTaken: (g.metrics || {}).dmgTaken, stars: (g.metrics || {}).stars,
    })),
    topMoments: Object.entries(ruleCount).sort((a, b2) => b2[1] - a[1]).slice(0, 5).map(([label, count]) => ({ label, count })),
  };
}

const REVIEW_CONTRACT = [
  '合同（必须严格遵守）：',
  '- 只输出一个 ```json 代码块，形如：',
  '  {"diagnoses":[{"title":"一句话病灶","detail":"为什么这样不好","evidence":"t=34 或指标数字"}],',
  '   "strategy":"改写后的完整战术文字（中文，给玩家读，不是代码）","changes":["一句话说明改了什么"]}',
  '- diagnoses 每条都必须引用下面给出的时刻（t=…）或指标数字，不许凭空推断。',
  '- strategy 要保留玩家原本合理的部分，只改该改的；不要写代码。',
  '- 不要输出代码块以外的任何解释文字。',
];

export function buildReviewPrompt(opts) {
  const o = opts || {};
  const mode = o.mode;
  if (mode !== 'single' && mode !== 'batch') throw new Error(`buildReviewPrompt: unknown mode ${mode}`);
  const p = o.payload || {};
  const s = p.setup || {};
  const lines = [];
  lines.push('你是坦克对战游戏的战术教练。下面是引擎判定出的确定性事实（不是猜测）。');
  lines.push(mode === 'single'
    ? '任务：指出玩家写的战术在这一局里哪几处表现不合理，并改写战术文字。'
    : '任务：从这一批对局（同关卡、同对手、同技能，只有随机种子不同）里找出系统性毛病，并改写战术文字，目标是提升胜率。');
  lines.push(...REVIEW_CONTRACT);
  lines.push('');
  lines.push('玩家现在的战术：');
  lines.push(String(o.strategy || '（空）'));
  lines.push('');

  if (mode === 'single') {
    const r = p.result || {};
    const m = p.metrics || {};
    lines.push(`这一局：seed=${s.seed} 地图=${s.mapKey} 对手=${s.opponent} 我方技能=${(s.skills || [])[0] ?? '—'}`);
    lines.push(`结果：${r.win ? '胜' : '负'}（${r.reason}，共 ${r.ticks} 拍）星 ${(r.stars || [0, 0]).join(':')}`);
    lines.push(`指标：命中率 ${pctS(m.accuracy)}（${m.fires} 发中 ${m.hits}）｜伤害 打出 ${m.dmgDealt} / 挨了 ${m.dmgTaken}｜子弹被挡 ${m.shotsBlocked}`
      + `｜毒圈挨伤 ${m.zoneDmg}｜技能 ${m.skillCasts} 放 ${m.skillHits} 中｜我首星 t=${m.firstStarTick ?? '—'}，对手 t=${m.enemyFirstStarTick ?? '—'}`
      + `｜阵亡 t=${m.deathTick ?? '无'}`);
    lines.push('');
    lines.push('引擎标出的不合理时刻：');
    if (!(p.moments || []).length) lines.push('（本局没有标出可疑时刻——若战术仍有问题，请从指标里找）');
    for (const mo of p.moments || []) lines.push(`- t=${mo.t} ${mo.label}（${mo.severity === 'high' ? '重' : '中'}）：${mo.why}`);
  } else {
    const a = p.agg || {};
    lines.push(`这一批：对手=${s.opponent} 技能=${s.skill} 地图=${s.mapKey} 种子集=${s.seedSet} 共 ${a.games || 0} 局`);
    lines.push(a.games
      ? `胜率 ${pctS(a.winRate)}（${a.wins} 胜 ${a.losses} 负）｜平均 命中率 ${pctS((a.avg || {}).accuracy)}，打出 ${(a.avg || {}).dmgDealt} / 挨了 ${(a.avg || {}).dmgTaken}，首星 t=${(a.avg || {}).firstStarTick ?? '—'}（对手 ${(a.avg || {}).enemyFirstStarTick ?? '—'}）`
      : '（本批没有跑出任何一局）');
    const buckets = Object.entries(a.lossBuckets || {});
    if (buckets.length) lines.push(`败因分桶：${buckets.map(([k, v]) => `${k} ${v} 局`).join('，')}`);
    if ((p.topMoments || []).length) lines.push(`高频不合理操作：${p.topMoments.map((x) => `${x.label} ×${x.count}`).join('，')}`);
    lines.push('');
    lines.push('逐局：');
    for (const g of p.games || []) {
      lines.push(`- seed ${g.seed} ${g.win ? '胜' : '负'} ${g.reason} 命中 ${pctS(g.accuracy)} 打${g.dmgDealt}/挨${g.dmgTaken} 星${(g.stars || [0, 0]).join(':')}`);
    }
  }
  return lines.join('\n');
}

// 回复 → {diagnoses, strategy, changes, truncated}；拿不到可用结构一律 null（fail-closed）
export function parseReviewReply(text) {
  const raw = String(text || '');
  let jsonText = null;
  const fenced = raw.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  if (fenced) jsonText = fenced[1];
  else {
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i >= 0 && j > i) jsonText = raw.slice(i, j + 1);
  }
  if (!jsonText) return null;
  let obj;
  try { obj = JSON.parse(jsonText); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  let strategy = typeof obj.strategy === 'string' ? obj.strategy.trim() : '';
  if (!strategy) return null;
  let truncated = false;
  if (strategy.length > REVIEW_MAX_STRATEGY) { strategy = strategy.slice(0, REVIEW_MAX_STRATEGY); truncated = true; }
  const diagnoses = (Array.isArray(obj.diagnoses) ? obj.diagnoses : [])
    .filter((d) => d && typeof d === 'object' && typeof d.title === 'string' && d.title.trim())
    .slice(0, 6)
    .map((d) => ({
      title: String(d.title).trim().slice(0, 200),
      detail: typeof d.detail === 'string' ? d.detail.trim().slice(0, 600) : '',
      evidence: typeof d.evidence === 'string' ? d.evidence.trim().slice(0, 120) : '',
    }));
  const changes = (Array.isArray(obj.changes) ? obj.changes : [])
    .filter((c) => typeof c === 'string' && c.trim())
    .slice(0, 8)
    .map((c) => c.trim().slice(0, 200));
  return { diagnoses, strategy, changes, truncated };
}

// ---------- AI 复盘循环迭代：择优 / 爬山 / 成本 / 日志（纯函数） ----------
// 用户拍板（2026-08-20）：迭代结束**总是应用训练组最强那版**，不设留出组门槛
//（留出组验证改成事后可选按钮）。所以 pickBest 只看 trainWinRate。
// 为什么不能用留出组择优：那等于把留出组也变成训练集，最后那四个数字就不再是独立验收。
export const ITER_LIMITS = { maxRounds: 20, minRounds: 1, msPerAiCall: 12000, msPerMatch: 260 };

const validCandidate = (x) => !!x && x.valid !== false && typeof x.trainWinRate === 'number' && Number.isFinite(x.trainWinRate);

// 训练组胜率最高的有效候选；并列取更早那轮（少改动优先）；一个都没有 → null
export function pickBest(candidates) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(validCandidate);
  if (!list.length) return null;
  let best = list[0];
  for (const x of list.slice(1)) {
    if (x.trainWinRate > best.trainWinRate) best = x;
    else if (x.trainWinRate === best.trainWinRate && (x.round ?? 0) < (best.round ?? 0)) best = x;
  }
  return best;
}

// 下一轮从「当前最优」继续（爬山），而不是从上一轮结果继续 ——
// 否则某轮改坏后，后面几轮都在坏版本上打补丁。
export function nextRoundBase(candidates) {
  return pickBest(candidates);
}

// 成本预估：每轮 2 次 AI 调用（复盘 + 生成）+ 每轮 N 局本地对局
export function iterationCost(rounds, matchesPerRound) {
  const r = Math.min(ITER_LIMITS.maxRounds, Math.max(ITER_LIMITS.minRounds, Math.round(Number(rounds) || 0)));
  const m = Math.max(1, Math.round(Number(matchesPerRound) || 12));
  return {
    rounds: r,
    aiCalls: r * 2,
    matches: r * m,
    estMs: r * (2 * ITER_LIMITS.msPerAiCall + m * ITER_LIMITS.msPerMatch),
  };
}

// 迭代留档（可下载）：每轮候选（含无效轮与原因）+ 最终应用了哪一版
export function buildIterationLog(o) {
  const i = o || {};
  const cands = Array.isArray(i.candidates) ? i.candidates : [];
  const clean = (c) => ({
    round: c.round ?? null,
    valid: c.valid !== false,
    trainWinRate: typeof c.trainWinRate === 'number' ? c.trainWinRate : null,
    strategy: redactSecrets(c.strategy || ''),
    codeHash: String(c.codeHash || ''),
    changes: Array.isArray(c.changes) ? c.changes.slice(0, 8).map((x) => redactSecrets(String(x))) : [],
    invalidReason: c.invalidReason ? redactSecrets(String(c.invalidReason)) : '',
    model: c.model ? String(c.model) : '',
  });
  const valid = cands.filter(validCandidate).length;
  return {
    kind: 'agentank-iteration',
    schema: 1,
    at: i.at || new Date().toISOString(),
    setup: {
      opponent: String((i.setup || {}).opponent || ''),
      skill: String((i.setup || {}).skill || ''),
      mapKey: String((i.setup || {}).mapKey || ''),
      tank: String((i.setup || {}).tank || ''),
      model: String((i.setup || {}).model || ''),
      rounds: Number((i.setup || {}).rounds) || 0,
    },
    baseline: i.baseline ? clean(i.baseline) : null,
    candidates: cands.map(clean),
    applied: i.applied ? { round: i.applied.round ?? null, trainWinRate: typeof i.applied.trainWinRate === 'number' ? i.applied.trainWinRate : null } : null,
    stopped: String(i.stopped || 'done'), // done | aborted | setup-changed | no-sdk | error
    fakeLlm: i.fakeLlm === true, // true = 用调试假 AI 跑的，结果不代表真实模型（产物自证来源）
    stats: { validRounds: valid, failedRounds: cands.length - valid },
  };
}

// 改前/改后胜率对比的结论判定（纯函数，脱离 DOM 才能被测试钉住）。
// 五个态一个都不能省：任一侧缺数据、或两侧不是同一套对局设置，都**不许**给出「有没有提升」的定性结论。
// 教训：第一轮只挡了 before 缺失，after 缺失（脚本报错/沙箱超时被丢弃）照样印「本轮没有提升」——
// 在没有数据时给确定性否定判决，和编造提升是同一种谎。
export function compareVerdict(o) {
  const before = (o && o.before) || {};
  const after = (o && o.after) || {};
  const cur = o && o.curKey;
  const keys = (o && Array.isArray(o.keys) ? o.keys : []).filter((k) => k != null && k !== '');
  if (cur != null && keys.some((k) => k !== cur)) return { state: 'setup-changed', gained: false };
  if (before.train == null || before.holdout == null) return { state: 'no-before', gained: false };
  if (after.train == null || after.holdout == null) return { state: 'no-after', gained: false };
  return after.holdout > before.holdout ? { state: 'gain', gained: true } : { state: 'no-gain', gained: false };
}

// LLM 输出 → 代码：优先取 ```js 围栏块；裸输出须含 decide 入口，否则 null（fail-closed）
export function extractLlmCode(text) {
  const m = String(text || '').match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/);
  const code = m ? m[1] : String(text || '');
  if (!/export\s+default\s+function|function\s+decide/.test(code)) return null;
  return code.trim();
}

// PlayError → 文案键（app.js 生成按钮的错误出口；未知码透传 hint/message）
export function mapLlmError(e) {
  const code = e && e.code;
  if (code === 'AUTH_REQUIRED' || code === 'TOKEN_EXPIRED') return { key: 'play.genNeedLogin' };
  if (code === 'LLM_QUOTA_EXCEEDED') return { key: 'play.genQuota', vars: { hint: String((e && e.hint) || '') } };
  if (code === 'LLM_TIMEOUT') return { key: 'play.genTimeout' };
  return { key: 'play.genFail', vars: { msg: String((e && (e.hint || e.message)) || e || '') } };
}

// ---------- 生成闸门（无 eval 版）：托管页 CSP 禁 eval 时替代「编译一次」的结构校验 ----------
// 背景：线上 CSP 为 script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'（无 'unsafe-eval'），
// new Function 必抛。此前生成流程拿 compileScript 当语法闸门 → 任何自定义代码在线上都 100% 失败，
// 且把 CSP 错误当「编译错误」喂回模型重试，白烧一次配额。这里改成不执行代码的静态检查。
const GEN_CODE_MAX = 20000;
// 明确禁止出现在生成脚本里的宿主能力（引擎沙箱只喂 api，出现即为跑偏/注入）
const GEN_FORBIDDEN = [
  { re: /<\/script/i, id: 'script-close' },
  { re: /\beval\s*\(/, id: 'eval' },
  { re: /new\s+Function\s*\(/, id: 'new-function' },
  { re: /\bimport\s*[(\s]/, id: 'import' },
  { re: /\bfetch\s*\(/, id: 'fetch' },
  { re: /XMLHttpRequest|localStorage|sessionStorage|document\.|window\./, id: 'host-api' },
];

// 去掉字符串/注释后再数括号，避免把代码里的 "(" 文本当结构（正则字面量不参与，见 balanced 注释）
function stripLiterals(code) {
  let out = '';
  let mode = null; // null | 'line' | 'block' | '"' | "'" | '`'
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const n = code[i + 1];
    if (mode === null) {
      if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
      if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = c; continue; }
      out += c;
      continue;
    }
    if (mode === 'line') { if (c === '\n') { mode = null; out += c; } continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = null; i++; } continue; }
    if (c === '\\') { i++; continue; } // 字符串里的转义
    if (c === mode) mode = null;
  }
  return out;
}

// 括号配平（结构性语法错的廉价代理；正则字面量里的括号可能误判，因此只在含 / 的行少见场景下生效，
// 误判会被上层当作「本轮不通过 → 带错重试」处理，不会静默塞坏代码）
function balanced(code) {
  const pairs = { ')': '(', ']': '[', '}': '{' };
  const stack = [];
  for (const c of stripLiterals(code)) {
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (pairs[c]) { if (stack.pop() !== pairs[c]) return false; }
  }
  return stack.length === 0;
}

// 返回 { ok, errors[] }：ok=false 时上层按「本轮生成不合格」处理（带错重试 / 如实报错 + 出日志）
export function checkGeneratedCode(code) {
  const src = String(code || '');
  const errors = [];
  if (!src.trim()) errors.push('empty code');
  if (src.length > GEN_CODE_MAX) errors.push(`code too long (${src.length} > ${GEN_CODE_MAX})`);
  if (!/export\s+default\s+function|function\s+decide/.test(src)) errors.push('missing decide(api) entry');
  for (const f of GEN_FORBIDDEN) if (f.re.test(src)) errors.push(`forbidden host API: ${f.id}`);
  if (!balanced(src)) errors.push('unbalanced brackets');
  return { ok: errors.length === 0, errors };
}

// 统一脚本闸门（保存 / 生成 / 挑战赛共用）：
//   宿主允许 eval → 真编译（最强，语法错当场现形）；
//   宿主禁 eval（线上 CSP）→ 不执行代码的结构校验。
// 为什么必须分流：保存到云端、送去沙箱跑，都不需要在主线程执行这段代码。
// 曾经这里直接拿 compileScript 当唯一闸门，于是线上（禁 eval）保存/挑战赛任何自定义脚本 100% 必败，
// 还把宿主 CSP 限制冒充成「你的代码编译失败」——环境性失败绝不能伪装成玩家/模型的输出问题。
export function scriptGate(code, opts) {
  const o = opts || {};
  const compile = typeof o.compile === 'function' ? o.compile : null;
  if (!o.evalOk || !compile) return checkGeneratedCode(code);
  try { compile(code); return { ok: true, errors: [] }; } catch (e) {
    if (e && e.code === 'CSP_NO_EVAL') return checkGeneratedCode(code); // CSP 限制 ≠ 代码写错
    return { ok: false, errors: [String((e && e.message) || e)] };
  }
}

// ---------- 生成诊断日志：失败时一键下载交给产品方分析 ----------
// 只装“定位问题必需”的东西：环境能力（CSP/eval/SDK）、每次尝试的形状与错误、玩家自己的策略文本与产出代码。
// 绝不装凭证：落盘前统一过 redactSecrets（Bearer / ak1_ / gt1_ / token 字段一律打码）。
export { redactSecrets }; // 单一定义点在 src/engine/analyze.js（战报 JSON 与生成日志共用同一套打码，勿另写）

export function genLogFilename(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `agentank-gen-log-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

// attempts[i] = { n, promptChars, replyChars, replyHead, extracted, codeChars, code, error, errorKind }
export function buildGenLog(o) {
  const i = o || {};
  const env = i.env || {};
  return {
    kind: 'agentank-generation-diagnostic',
    schema: 1,
    outcome: String(i.outcome || 'unknown'), // ok | invalid-output | sdk-error | no-sdk
    reason: redactSecrets(i.reason || ''),
    at: new Date(i.at || Date.now()).toISOString(),
    durationMs: Number(i.durationMs) > 0 ? Math.round(Number(i.durationMs)) : 0,
    env: {
      url: redactSecrets(env.url || ''),
      appVersion: String(env.appVersion || ''),
      lang: String(env.lang || ''),
      ua: String(env.ua || ''),
      evalAllowed: env.evalAllowed === true, // false = 宿主 CSP 无 'unsafe-eval'（线上托管版即为此）
      workerAllowed: env.workerAllowed === true,
      sandboxReady: env.sandboxReady === true, // 禁 eval 时是否已用 blob Worker 沙箱跑自定义脚本
      engineSrcChars: Number(env.engineSrcChars) || 0,
      sdk: String(env.sdk || ''), // ready | need-login | absent
      csp: redactSecrets(env.csp || ''),
    },
    input: {
      strategyChars: String(i.strategy || '').length,
      strategy: redactSecrets(i.strategy || ''),
      skill: String(i.skill || ''),
    },
    attempts: (i.attempts || []).map((a) => ({
      n: Number(a.n) || 0,
      promptChars: Number(a.promptChars) || 0,
      replyChars: Number(a.replyChars) || 0,
      replyHead: redactSecrets(String(a.replyHead || '').slice(0, 500)),
      extracted: a.extracted === true,
      codeChars: Number(a.codeChars) || 0,
      code: redactSecrets(a.code || ''),
      errorKind: String(a.errorKind || ''), // no-code | check-failed | compile-failed | sdk-error
      error: redactSecrets(a.error || ''),
    })),
  };
}

// ---------- 编辑器内容裁决：坦克（已保存）vs 草稿（未保存）----------
// 线上故障（2026-08-19）：登录后云端接管直接 applyTankToUi(云端坦克)，用云端的空 strategy
// 覆盖了玩家正在写的战术文字，再 clearDraft() 抹掉草稿 → 刷新后战术文字彻底没了，
// 而代码因为之前保存过所以还在（云端实测三台坦克 strategy 全为空串）。
// 规则：未保存的草稿优先级高于已保存内容（草稿本来就是「还没存的最新改动」），
// 但空草稿绝不覆盖已存内容 —— 零丢失优先。
function draftBelongsTo(draft, cur) {
  if (!draft || typeof draft.code !== 'string' || !draft.code.trim()) return false;
  const dc = draft.cur ?? null;
  return dc === null || dc === (cur ?? null); // cur=null：匿名期写的草稿衔接到登录后的出战坦克
}

export function resolveEditorState(opts) {
  const o = opts || {};
  const t = o.tank || null;
  const isDefaultCode = typeof o.isDefaultCode === 'function' ? o.isDefaultCode : () => false;
  const defaultCode = String(o.defaultCode || '');
  const defaultStrategy = String(o.defaultStrategy || '');
  let code = t ? String(t.code || '') : defaultCode;
  // 战术文字：坦克存过就用存的；没存但代码仍是默认脚本 → 配套的默认战术文本（不留空白）
  let strategy = t ? (String(t.strategy || '') || (isDefaultCode(t.code) ? defaultStrategy : '')) : defaultStrategy;
  let fromDraft = false;
  if (draftBelongsTo(o.draft, o.cur)) {
    fromDraft = true;
    code = String(o.draft.code);
    const ds = typeof o.draft.strategy === 'string' ? o.draft.strategy : '';
    if (ds) strategy = ds; // 空草稿不擦掉已存战术
  }
  return { code, strategy, fromDraft };
}

// 草稿能否安全清掉：只有与坦克逐字一致（= 没有未保存改动）才允许清
export function draftIsClean(draft, tank) {
  if (!draft || typeof draft.code !== 'string' || !draft.code.trim()) return true;
  if (!tank) return false;
  if ((draft.cur ?? null) !== null && (draft.cur ?? null) !== (tank.name ?? null)) return false;
  return String(draft.code) === String(tank.code || '')
    && String(draft.strategy || '') === String(tank.strategy || '');
}

// 版本递增：基于现有实体 version+1，缺省从 0 起
export function nextTankVersion(tank) {
  const v = Number(tank && tank.version);
  return (Number.isFinite(v) && v > 0 ? v : 0) + 1;
}

// ---------- 车库（多坦克）纯函数：行分组 / 本地存档迁移 / 登录时刻衔接 ----------
// 云端 Tank 行 → 车库：每行一台坦克，按 name 分组（同名取最高 version 兜底脏数据），
// is_active=出战坦克（多台标 active 的历史数据取最后一台；全未标取最新入库的）。
export function garageFromRows(rows) {
  const byName = new Map();
  for (const raw of rows || []) {
    const r = entityFields(raw);
    if (!r || typeof r.name !== 'string' || !r.name) continue;
    const t = {
      id: r.id,
      name: r.name,
      code: String(r.code || ''),
      strategy: String(r.strategy || ''),
      skill: String(r.skill || ''),
      v: Number(r.version) > 0 ? Number(r.version) : 1,
      active: r.is_active === true,
    };
    const prev = byName.get(t.name);
    if (!prev || t.v >= prev.v) byName.set(t.name, t);
  }
  const tanks = [...byName.values()];
  let active = null;
  for (const t of tanks) if (t.active) active = t;
  if (!active && tanks.length) active = tanks[tanks.length - 1];
  return { tanks, active };
}

// 本地匿名存档迁移：旧单份 {code,v,n} → 一台默认名坦克（「坦克1」）；
// 新格式 {tanks:[{name,code,skill,v}],cur} 校验透传；坏存量按空处理。
export function migrateLocalSave(raw, defaultName) {
  let s = null;
  try { s = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { /* 坏存量：按空处理 */ }
  if (!s || typeof s !== 'object') return { tanks: [], cur: null };
  if (Array.isArray(s.tanks)) {
    const tanks = s.tanks
      .filter((t) => t && typeof t.name === 'string' && t.name && typeof t.code === 'string')
      .map((t) => ({ name: t.name, code: t.code, strategy: String(t.strategy || ''), skill: String(t.skill || ''), v: Number(t.v) > 0 ? Number(t.v) : 1 }));
    const cur = tanks.some((t) => t.name === s.cur) ? s.cur : (tanks.length ? tanks[0].name : null);
    return { tanks, cur };
  }
  if (typeof s.code === 'string' && s.code.trim()) {
    return {
      tanks: [{ name: String(defaultName), code: s.code, strategy: '', skill: '', v: Number(s.v) > 0 ? Number(s.v) : 1 }],
      cur: String(defaultName),
    };
  }
  return { tanks: [], cur: null };
}

// 本地保存：同名递增 v、新名 v1；返回新 store（不改入参）与本次落点版本
export function upsertLocalTank(store, t) {
  const tanks = (store && Array.isArray(store.tanks) ? store.tanks : []).slice();
  const i = tanks.findIndex((x) => x && x.name === t.name);
  const v = i >= 0 ? (Number(tanks[i].v) > 0 ? Number(tanks[i].v) : 0) + 1 : 1;
  const entry = { name: String(t.name), code: String(t.code || ''), strategy: String(t.strategy || ''), skill: String(t.skill || ''), v };
  if (i >= 0) tanks[i] = entry; else tanks.push(entry);
  return { tanks, cur: entry.name, v };
}

// 登录时刻逐台按名字衔接（方案 v2 三分支）：云端无同名→upload（一键入库）、
// 同名且代码相同→synced（静默跳过）、同名且代码不同→conflict（二选一横幅）
export function reconcileLogin(localTanks, cloudTanks) {
  const cloudByName = new Map((cloudTanks || []).map((t) => [t.name, t]));
  const upload = [];
  const conflicts = [];
  const synced = [];
  for (const lt of localTanks || []) {
    if (!lt || !lt.name) continue;
    const c = cloudByName.get(lt.name);
    if (!c) upload.push(lt);
    else if (String(c.code || '') === String(lt.code || '')) synced.push(lt.name);
    else conflicts.push({ local: lt, cloud: c });
  }
  return { upload, conflicts, synced };
}

// 默认命名：mk(n) 生成候选名（坦克1/坦克2/…），找最小未占用编号
export function nextTankName(existing, mk) {
  const set = new Set(existing || []);
  for (let n = 1; n <= set.size + 1; n++) {
    const c = mk(n);
    if (!set.has(c)) return c;
  }
  return mk(set.size + 1);
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
// ---------- 装备/代码不符检测（纯函数可测） ----------
// 装备由下拉框决定、代码只决定何时施放；旧入口（api.teleport/cloak/stun）与 api.ready('技能名')
// 在装备不符时引擎按 no-op/false 处理——这里找出代码显式点名、但换装备后不会生效的技能。
export const SKILL_IDS = ['shield', 'freeze', 'stun', 'overload', 'cloak', 'poison', 'teleport', 'boost'];
export function skillCodeMismatch(code, equipped) {
  const src = String(code || '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, ''); // 注释里的点名不算调用
  const hits = new Set();
  for (const name of ['teleport', 'cloak', 'stun']) { // 引擎旧入口：仅装备一致时生效
    if (name !== equipped && new RegExp(`api\\s*\\.\\s*${name}\\s*\\(`).test(src)) hits.add(name);
  }
  const re = /api\s*\.\s*ready\s*\(\s*['"]([a-z]+)['"]\s*\)/g; // ready('技能名')：与装备不一致恒 false
  let m;
  while ((m = re.exec(src))) {
    if (SKILL_IDS.includes(m[1]) && m[1] !== equipped) hits.add(m[1]);
  }
  return [...hits];
}

// ---------- Workshop 云端存取（纯函数可测）：工坊条目 ↔ 实体行 ----------
export function buildWorkshopPayload(entry) {
  return {
    type: String(entry.type),
    slug: String(entry.id),
    name: String(entry.name || entry.id),
    def: JSON.stringify(entry),
    stage: entry.stage === 'shared' ? 'shared' : 'private',
    is_active: true,
  };
}
export function parseWorkshopRow(row) {
  const f = entityFields(row);
  if (!f || f.is_active === false) return null;
  try {
    const entry = JSON.parse(f.def);
    if (!entry || !entry.type || !entry.id) return null;
    entry.stage = f.stage === 'shared' ? 'shared' : 'private';
    return { rowId: f.id ?? (row && row.id), entry };
  } catch { return null; }
}

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
  const fillBtn = $('playFillBtn'), challengeBtn = $('playChallengeBtn');
  const chBox = $('playChallenge'), chBody = $('playChallengeBody'), chSum = $('playChallengeSummary');
  let play;
  try { play = await Play.init(); } catch (e) { console.log('Play.init failed:', e && e.message); return; }

  // 未登录：只露登录按钮，云端区隐藏；AI 生成按钮降级为「登录后可用」（点击引导登录）
  if (!play.user) {
    if (loginBtn) {
      loginBtn.style.display = '';
      loginBtn.textContent = T('play.login');
      loginBtn.addEventListener('click', () => play.login());
    }
    if (typeof ctx.llmConnect === 'function') ctx.llmConnect({ needLogin: true, login: () => play.login() });
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

  // 策略文本优先：登录态把 SDK LLM 递给 app.js 生成按钮（SDK 无 llm 面时按不可用降级）
  if (typeof ctx.llmConnect === 'function') {
    const llm = play.llm;
    // 指定模型：SDK 契约里 chat(input) 的 input 为对象时**原样作为请求体**，故把 model 拼进 body；
    // models() 走 GET /api/llm/models（平台按当前玩家 tier 下发可选表）。
    ctx.llmConnect(llm && typeof llm.chat === 'function'
      ? {
        chat: (prompt, opts) => {
          const o = opts || {};
          const body = o.model
            ? { messages: [{ role: 'user', content: String(prompt) }], model: o.model }
            : prompt;
          return llm.chat(body, o);
        },
        models: typeof llm.models === 'function' ? () => llm.models() : null,
      }
      : null);
  }

  // 创作工坊：私有内容只存服务器端（Workshop 实体，owner 隔离）；登录后接管 app.js 工坊持久层
  const Workshop = play.db && play.db.Workshop;
  if (Workshop && typeof ctx.workshopConnect === 'function') {
    try {
      const idBySlug = new Map(); // `${type}:${slug}` -> 云端行 id
      const entries = [];
      for (const row of (await Workshop.list()) || []) {
        const p = parseWorkshopRow(row);
        if (!p) continue;
        idBySlug.set(`${p.entry.type}:${p.entry.id}`, p.rowId);
        entries.push(p.entry);
      }
      const save = async (entry) => {
        const key = `${entry.type}:${entry.id}`;
        const payload = buildWorkshopPayload(entry);
        const rid = idBySlug.get(key);
        if (rid) await Workshop.update(rid, payload);
        else { const r = await Workshop.create(payload); if (r && r.id) idBySlug.set(key, r.id); }
      };
      const remove = async (entry) => { // 删除 = 置 is_active:false（与 Tank 同款软删）
        const rid = idBySlug.get(`${entry.type}:${entry.id}`);
        if (rid) await Workshop.update(rid, { is_active: false });
      };
      await ctx.workshopConnect({ entries, save, remove });
    } catch (e) { console.log('workshop cloud failed:', e && e.message); }
  }

  const Tank = play.db && play.db.Tank;
  const BR = play.db && play.db.BattleResult;
  if (!Tank || !BR) { status(T('play.noEntity')); return; }

  // 车库（云端）：Tank 每行一台坦克（name 分组、version 原地递增、is_active=出战）。
  // 登录时刻逐台衔接（方案 v2 三分支）与车库 UI 全部由 app.js 车库模块接管，这里只递云端 CRUD。
  if (typeof ctx.garageConnect === 'function') {
    try {
      await ctx.garageConnect({
        list: async () => garageFromRows((await Tank.list()) || []),
        create: (payload) => Tank.create(payload),
        update: (id, patch) => Tank.update(id, patch),
      });
    } catch (e) { status(T('play.loadFail', { msg: String(e && e.message || e) })); }
  }

  // 登出（SDK 支持时才露出）：清车库/编辑器回默认模板，防同一浏览器下一人看到上一人代码
  const logoutBtn = $('playLogoutBtn');
  if (logoutBtn && typeof play.logout === 'function') {
    logoutBtn.style.display = '';
    logoutBtn.textContent = T('play.logout');
    logoutBtn.addEventListener('click', async () => {
      if (typeof ctx.resetForLogout === 'function') ctx.resetForLogout();
      try { await play.logout(); } catch { /* 忽略 */ }
      location.reload(); // 干净回到匿名态
    });
  }

  // 一键回填默认流派代码（只改编辑器，不写云端）
  if (fillBtn) fillBtn.addEventListener('click', () => { ctx.editorSet(ctx.defaultScript); status(T('play.filled')); });

  // 挑战赛：我的坦克（编辑器脚本）× ROSTER 各 bot × LADDER_SEEDS 固定局，逐局写 BattleResult
  const tickAsync = () => new Promise((res) => setTimeout(res, 0));
  let running = false;
  if (challengeBtn) challengeBtn.addEventListener('click', async () => {
    if (running) return;
    running = true;
    try {
      // 闸门与保存同源：禁 eval 的宿主（线上）用结构校验放行，跑局改走沙箱 —— 曾经这里 100% 必败
      const code = ctx.editorGet();
      const evalOk = ctx.evalOk !== false;
      const skill = ctx.userSkill();
      const gate = scriptGate(code, { evalOk, compile: ctx.compileScript });
      if (!gate.ok) { chSum.textContent = T('play.gateFail', { msg: gate.errors.join('; ') }); return; }
      let gfn = null;
      if (evalOk) {
        try { gfn = ctx.guardWrap(ctx.compileScript(code), { count: 0, last: '' }); } catch (e) { chSum.textContent = T('play.gateFail', { msg: String(e && e.message || e) }); return; }
        gfn.skill = skill;
      } else if (typeof ctx.sandboxMatch !== 'function') {
        chSum.textContent = T('err.cspEval'); // 既不能 eval、沙箱也起不来：如实报错，不伪造战绩
        return;
      }
      const jobs = [];
      for (const r of ctx.ROSTER) for (const seed of ctx.LADDER_SEEDS) jobs.push({ r, seed });
      let myElo = 1200;
      for (let k = 0; k < jobs.length; k++) {
        const { r, seed } = jobs[k];
        chSum.textContent = T('play.challengeRunning', { done: k, total: jobs.length });
        await tickAsync();
        const map = ctx.makeMap(seed);
        let result;
        if (evalOk) {
          result = ctx.runMatch({ seed, botA: gfn, botB: r.fn, map, content: ctx.getPack() });
        } else {
          try { // 沙箱失败一律显式报错（含原因），绝不静默跳过这一局把战绩做漂亮
            result = await ctx.sandboxMatch({ seed, map, a: { kind: 'user', skill }, b: { kind: 'builtin', key: r.key } }, code);
          } catch (e) { chSum.textContent = T('play.sandboxFail', { msg: String(e && e.message || e) }); return; }
        }
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
