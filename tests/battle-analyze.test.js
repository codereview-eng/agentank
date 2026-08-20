// 单局战报分析（给 AI 批这一局用）：状态重建 / 指标 / 可疑时刻 / JSON 契约 / 批量聚合。
// 设计口径：可疑时刻是「引擎事件推导出的确定性事实」，AI 只负责解释与给改法——
// 所以这里必须能用手写事件精确触发每一条规则，不允许出现「靠模型判断」的分支。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii, RULES } from '../src/engine/index.js';
import {
  replayStates, buildMetrics, detectMoments, buildBattleReport,
  aggregateBatch, renderBatchText, battleReportFilename, MOMENT_RULES, healThresholdFrom,
} from '../src/engine/analyze.js';

// 测试图：9x9，A 出生 (1,1)，B 出生 (7,7)，星在 (3,2)
const MAP = mapFromAscii([
  '#########',
  '#A......#',
  '#..*....#',
  '#.......#',
  '#.......#',
  '#.......#',
  '#.......#',
  '#......B#',
  '#########',
]);

// 手写战报：events 末尾自动补 end 事件，ticks 取最大 t+1
function mk(events, o = {}) {
  const last = events.reduce((m, e) => Math.max(m, e.t), 0);
  const ticks = o.ticks ?? last + 1;
  const winner = o.winner ?? 1;
  return {
    events: [
      { t: 0, type: 'start', seed: 1, width: MAP.width, height: MAP.height, skills: o.skills ?? ['teleport', 'shield'] },
      ...events,
      { t: ticks - 1, type: 'end', winner, reason: o.reason ?? 'kill', stars: o.stars ?? [0, 1], hp: o.hp ?? [0, 100] },
    ],
    winner,
    reason: o.reason ?? 'kill',
    stars: o.stars ?? [0, 1],
    skills: o.skills ?? ['teleport', 'shield'],
    ticks,
    seed: 1,
  };
}

const rules = (ms) => ms.map((m) => m.rule);

// ───────── 状态重建 ─────────

test('状态重建：出生位置/血量与事件同步，且与引擎终局自洽', () => {
  const idle = () => null;
  const A = (api) => { const s = api.nearestStar(); return s ? api.moveTo(s) : api.patrol(); };
  const r = runMatch({ seed: 7, map: MAP, botA: A, botB: idle, maxTicks: 60 });
  const st = replayStates(MAP, r);
  assert.equal(st.length, r.ticks);
  // 第 0 拍双方就可能已经动过，所以按「不超过出生点 1 格」与「静止方仍在出生点」对账
  assert.ok(Math.abs(st[0].pos[0].x - 1) + Math.abs(st[0].pos[0].y - 1) <= 1);
  assert.deepEqual(st[0].pos[1], { x: 7, y: 7 });
  assert.equal(st[0].hp[0], RULES.hp);
  // 与引擎自己给出的终局对账：星数、血量必须一致（重建不能跑偏）
  const end = r.events.find((e) => e.type === 'end');
  assert.deepEqual(st[st.length - 1].held, r.stars);
  assert.deepEqual(st[st.length - 1].hp, end.hp);
});

test('状态重建：技能冷却按 RULES 表递减（传送 cd=100）', () => {
  const r = mk([{ t: 5, type: 'skill', who: 0, name: 'teleport', x: 4, y: 4 }], { ticks: 30 });
  const st = replayStates(MAP, r);
  assert.equal(st[4].cd[0].skill, 0);
  assert.equal(st[5].cd[0].skill, RULES.skills.teleport.cd);
  assert.equal(st[10].cd[0].skill, RULES.skills.teleport.cd - 5);
  assert.deepEqual(st[5].pos[0], { x: 4, y: 4 }); // 传送落点进位置
});

// ───────── 指标 ─────────

test('指标：命中率/伤害收支与事件逐条对账', () => {
  const r = mk([
    { t: 3, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 },
    { t: 5, type: 'hit', who: 0, target: 1, dmg: 20, hp: 80, x: 4, y: 1 },
    { t: 9, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 },
    { t: 11, type: 'bullet_end', who: 0, reason: 'wall', x: 6, y: 1 },
    { t: 14, type: 'hit', who: 1, target: 0, dmg: 20, hp: 80, x: 1, y: 1 },
    { t: 20, type: 'zone_hit', target: 0, dmg: 5, hp: 75 },
  ], { ticks: 30 });
  const m = buildMetrics(MAP, r, 0);
  assert.equal(m.fires, 2);
  assert.equal(m.hits, 1);
  assert.equal(m.accuracy, 0.5);
  assert.equal(m.shotsBlocked, 1);
  assert.equal(m.dmgDealt, 20);
  assert.equal(m.dmgTaken, 25); // 子弹 20 + 毒圈 5
  assert.equal(m.zoneDmg, 5);
});

test('指标：首星时间双方各记一份（用于判断谁抢星更快）', () => {
  const r = mk([
    { t: 12, type: 'star', who: 1, x: 3, y: 2, total: 1 },
    { t: 30, type: 'star', who: 0, x: 3, y: 2, total: 1 },
  ], { ticks: 40 });
  const m = buildMetrics(MAP, r, 0);
  assert.equal(m.firstStarTick, 30);
  assert.equal(m.enemyFirstStarTick, 12);
});

test('指标：真实一局的伤害收支与 hit 事件之和一致', () => {
  const A = (api) => (api.canFire() && api.enemyVisible() ? api.fireAt(api.enemy()) : api.moveTo(api.enemy()));
  const B = (api) => (api.canFire() && api.enemyVisible() ? api.fireAt(api.enemy()) : api.patrol());
  const r = runMatch({ seed: 3, map: MAP, botA: A, botB: B, maxTicks: 300 });
  const m = buildMetrics(MAP, r, 0);
  const bulletDealt = r.events
    .filter((e) => e.type === 'hit' && e.who === 0)
    .reduce((s, e) => s + e.dmg, 0);
  assert.ok(m.dmgDealt >= bulletDealt, '打出伤害至少包含子弹命中之和');
  assert.equal(m.fires, r.events.filter((e) => e.type === 'fire' && e.who === 0).length);
});

// ───────── 可疑时刻：8 条规则逐条 ─────────

test('可疑时刻：规则清单是 8 条且 id 稳定', () => {
  assert.deepEqual(MOMENT_RULES.map((r) => r.id), [
    'star-ignored', 'zone-outward', 'cooldown-brawl', 'heal-ignored',
    'wasted-shots', 'skill-whiff', 'static-under-fire', 'losing-melee',
  ]);
});

test('可疑时刻 star-ignored：3 格内有星却奔向别处', () => {
  const r = mk([{ t: 4, type: 'goal', who: 0, x: 7, y: 7, tag: 'enemy' }], { ticks: 20 });
  const ms = detectMoments(MAP, r, { who: 0 });
  const hit = ms.find((m) => m.rule === 'star-ignored');
  assert.ok(hit, '应标出「该吃的星没吃」');
  assert.equal(hit.t, 4);
  assert.equal(hit.snapshot.star.dist, 3);
  assert.ok(hit.why.length > 0);
});

test('可疑时刻 star-ignored：星在 6 格外不算不合理', () => {
  const far = mapFromAscii([
    '#########',
    '#A......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.....*.#',
    '#.......#',
    '#......B#',
    '#########',
  ]);
  const r = mk([{ t: 4, type: 'goal', who: 0, x: 7, y: 7, tag: 'enemy' }], { ticks: 20 });
  const ms = detectMoments(far, r, { who: 0 });
  assert.equal(ms.filter((m) => m.rule === 'star-ignored').length, 0);
});

test('可疑时刻 zone-outward：缩圈后仍留在圈外且没往里走', () => {
  const r = mk([{ t: 10, type: 'zone_shrink', ring: 1, x0: 2, y0: 2, x1: 6, y1: 6 }], { ticks: 30 });
  const ms = detectMoments(MAP, r, { who: 0 }); // A 在 (1,1)，ring1 安全区是 [2,6]
  const hit = ms.find((m) => m.rule === 'zone-outward');
  assert.ok(hit, '应标出「缩圈了还不进圈」');
  assert.ok(hit.t >= 13, '连续 3 拍后才判定');
  assert.equal(hit.snapshot.ring, 1);
});

test('可疑时刻 zone-outward：一直在圈内不触发', () => {
  const r = mk([
    { t: 8, type: 'move', who: 0, x: 4, y: 4 },
    { t: 10, type: 'zone_shrink', ring: 1, x0: 2, y0: 2, x1: 6, y1: 6 },
  ], { ticks: 30 });
  const ms = detectMoments(MAP, r, { who: 0 });
  assert.equal(ms.filter((m) => m.rule === 'zone-outward').length, 0);
});

test('可疑时刻 cooldown-brawl：技能冷却中在中距离对射', () => {
  const r = mk([
    { t: 2, type: 'skill', who: 0, name: 'teleport', x: 4, y: 4 }, // 之后 cd=100
    { t: 20, type: 'move', who: 1, x: 6, y: 6 },                   // 敌到 (6,6)，与 (4,4) 距 4
    { t: 22, type: 'fire', who: 0, x: 4, y: 4, dx: 1, dy: 0 },
  ], { ticks: 40 });
  const ms = detectMoments(MAP, r, { who: 0 });
  const hit = ms.find((m) => m.rule === 'cooldown-brawl');
  assert.ok(hit, '应标出「冷却期硬拼」');
  assert.ok(hit.snapshot.cdLeft > 0);
  assert.ok(hit.snapshot.dist >= 3 && hit.snapshot.dist <= 6);
});

test('可疑时刻 heal-ignored：血低于战术写明的阈值却不去急救包', () => {
  const r = mk([
    { t: 2, type: 'item_spawn', kind: 'medkit', x: 3, y: 1 },
    { t: 5, type: 'hit', who: 1, target: 0, dmg: 70, hp: 30, x: 1, y: 1 },
  ], { ticks: 40 });
  const ms = detectMoments(MAP, r, { who: 0, strategy: '优先吃星；血量低于 40 就去找急救包' });
  const hit = ms.find((m) => m.rule === 'heal-ignored');
  assert.ok(hit, '应标出「该回血没回」');
  assert.equal(hit.snapshot.threshold, 40);
  assert.equal(hit.snapshot.hp, 30);
  assert.ok(hit.why.includes('40'));
});

test('可疑时刻 heal-ignored：真去捡了就不算', () => {
  const r = mk([
    { t: 2, type: 'item_spawn', kind: 'medkit', x: 3, y: 1 },
    { t: 5, type: 'hit', who: 1, target: 0, dmg: 70, hp: 30, x: 1, y: 1 },
    { t: 9, type: 'item_pick', who: 0, kind: 'medkit', x: 3, y: 1, hp: 60 },
  ], { ticks: 40 });
  const ms = detectMoments(MAP, r, { who: 0, strategy: '血量低于 40 找急救包' });
  assert.equal(ms.filter((m) => m.rule === 'heal-ignored').length, 0);
});

test('可疑时刻 wasted-shots：连续三发被墙/土堆挡下', () => {
  const r = mk([
    { t: 3, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 },
    { t: 4, type: 'bullet_end', who: 0, reason: 'wall', x: 8, y: 1 },
    { t: 9, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 },
    { t: 10, type: 'bullet_end', who: 0, reason: 'mound', x: 5, y: 1 },
    { t: 15, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 },
    { t: 16, type: 'bullet_end', who: 0, reason: 'wall', x: 8, y: 1 },
  ], { ticks: 30 });
  const ms = detectMoments(MAP, r, { who: 0 });
  const hit = ms.find((m) => m.rule === 'wasted-shots');
  assert.ok(hit, '应标出「白开炮」');
  assert.equal(hit.t, 16);
  assert.equal(hit.snapshot.streak, 3);
});

test('可疑时刻 skill-whiff：攻击型技能放空', () => {
  const r = mk([{ t: 6, type: 'skill', who: 0, name: 'freeze' }], { ticks: 30, skills: ['freeze', 'shield'] });
  const ms = detectMoments(MAP, r, { who: 0 });
  const hit = ms.find((m) => m.rule === 'skill-whiff');
  assert.ok(hit, '应标出「技能空放」');
  assert.equal(hit.snapshot.skill, 'freeze');
});

test('可疑时刻 skill-whiff：命中了就不算', () => {
  const r = mk([
    { t: 6, type: 'skill', who: 0, name: 'freeze' },
    { t: 6, type: 'freeze_hit', target: 1, duration: 8 },
  ], { ticks: 30, skills: ['freeze', 'shield'] });
  const ms = detectMoments(MAP, r, { who: 0 });
  assert.equal(ms.filter((m) => m.rule === 'skill-whiff').length, 0);
});

test('可疑时刻 static-under-fire：连挨两发还站原地', () => {
  const r = mk([
    { t: 5, type: 'hit', who: 1, target: 0, dmg: 20, hp: 80, x: 1, y: 1 },
    { t: 9, type: 'hit', who: 1, target: 0, dmg: 20, hp: 60, x: 1, y: 1 },
  ], { ticks: 30 });
  const ms = detectMoments(MAP, r, { who: 0 });
  const hit = ms.find((m) => m.rule === 'static-under-fire');
  assert.ok(hit, '应标出「挨打不动」');
  assert.equal(hit.t, 9);
});

test('可疑时刻 static-under-fire：挨打后挪窝就不算', () => {
  const r = mk([
    { t: 5, type: 'hit', who: 1, target: 0, dmg: 20, hp: 80, x: 1, y: 1 },
    { t: 7, type: 'move', who: 0, x: 1, y: 2 },
    { t: 9, type: 'hit', who: 1, target: 0, dmg: 20, hp: 60, x: 1, y: 2 },
  ], { ticks: 30 });
  const ms = detectMoments(MAP, r, { who: 0 });
  assert.equal(ms.filter((m) => m.rule === 'static-under-fire').length, 0);
});

test('可疑时刻 losing-melee：血量劣势还主动贴身', () => {
  const r = mk([
    { t: 4, type: 'hit', who: 1, target: 0, dmg: 70, hp: 30, x: 1, y: 1 },
    { t: 10, type: 'move', who: 0, x: 6, y: 7 }, // 贴到 B(7,7) 隔一格
  ], { ticks: 30 });
  const ms = detectMoments(MAP, r, { who: 0 });
  const hit = ms.find((m) => m.rule === 'losing-melee');
  assert.ok(hit, '应标出「无谓贴身」');
  assert.ok(hit.snapshot.hp < hit.snapshot.enemyHp);
});

test('可疑时刻：按时间排序、条数有上限、每条都带说明与快照', () => {
  const evs = [];
  for (let k = 0; k < 40; k++) {
    const t = 3 + k * 4;
    evs.push({ t, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 });
    evs.push({ t: t + 1, type: 'bullet_end', who: 0, reason: 'wall', x: 8, y: 1 });
  }
  const r = mk(evs, { ticks: 200 });
  const ms = detectMoments(MAP, r, { who: 0, max: 12 });
  assert.ok(ms.length <= 12, '条数不超过上限');
  for (let i = 1; i < ms.length; i++) assert.ok(ms[i].t >= ms[i - 1].t, '按时间升序');
  for (const m of ms) {
    assert.ok(typeof m.why === 'string' && m.why.length > 0);
    assert.ok(m.snapshot && typeof m.snapshot === 'object');
    assert.ok(['high', 'mid'].includes(m.severity));
  }
});

// ───────── 单局 JSON 契约（喂 AI 的那份） ─────────

test('单局 JSON：形状固定，含战术原文，且不带人读文字行', () => {
  const A = (api) => (api.canFire() && api.enemyVisible() ? api.fireAt(api.enemy()) : api.patrol());
  const r = runMatch({ seed: 5, map: MAP, botA: A, botB: () => null, maxTicks: 120 });
  const rep = buildBattleReport({
    map: MAP, result: r, who: 0, at: '2026-08-20T00:00:00.000Z',
    setup: { seed: 'abc123', mapKey: 'test', opponent: '狙击流派', tank: '我的坦克 v7', strategy: '优先吃星', codeHash: 'deadbeef' },
  });
  assert.equal(rep.kind, 'agentank-battle');
  assert.equal(rep.schema, 1);
  assert.equal(rep.setup.seed, 'abc123');
  assert.equal(rep.setup.strategy, '优先吃星');
  assert.equal(rep.setup.skills.length, 2);
  assert.equal(rep.result.win, r.winner === 0);
  assert.equal(rep.result.reason, r.reason);
  assert.ok(rep.metrics && typeof rep.metrics.accuracy === 'number');
  assert.ok(Array.isArray(rep.moments));
  assert.ok(Array.isArray(rep.events) && rep.events.length === r.events.length);
  assert.equal(rep.text, undefined, '单局 JSON 不带人读文字（老板定的口径）');
  assert.equal(rep.at, '2026-08-20T00:00:00.000Z');
});

test('单局 JSON：同种子同脚本两次生成逐字节一致（可复现）', () => {
  const A = (api) => (api.canFire() && api.enemyVisible() ? api.fireAt(api.enemy()) : api.patrol());
  const one = () => {
    const r = runMatch({ seed: 9, map: MAP, botA: A, botB: () => null, maxTicks: 120 });
    return JSON.stringify(buildBattleReport({
      map: MAP, result: r, who: 0, at: '2026-08-20T00:00:00.000Z',
      setup: { seed: '9', mapKey: 'test', opponent: 'x', tank: 't', strategy: 's', codeHash: 'h' },
    }));
  };
  assert.equal(one(), one());
});

test('单局 JSON：战术里的密钥形状会被打码', () => {
  const r = mk([], { ticks: 5 });
  const rep = buildBattleReport({
    map: MAP, result: r, who: 0, at: '2026-08-20T00:00:00.000Z',
    setup: { seed: '1', mapKey: 'test', opponent: 'x', tank: 't', strategy: '我的密钥是 ak1_abcdef123456 别泄漏', codeHash: 'h' },
  });
  assert.ok(!rep.setup.strategy.includes('abcdef123456'));
  assert.ok(rep.setup.strategy.includes('«redacted»'));
});

test('文件名：带种子与时间戳，扩展名 json', () => {
  const n = battleReportFilename(new Date('2026-08-20T12:34:56'), 'seed-xy');
  assert.match(n, /^agentank-battle-seed-xy-20260820-123456\.json$/);
});

// ───────── 批量聚合 + 人读文字 ─────────

const g = (seed, win, reason, extra = {}) => ({
  seed, win, reason, ticks: 200,
  metrics: { accuracy: 0.3, dmgDealt: 60, dmgTaken: 80, firstStarTick: 40, enemyFirstStarTick: 25, skillCasts: 3, skillHits: 1, zoneDmg: 10, shotsBlocked: 2, fires: 10, hits: 3, stars: [1, 2], deathTick: win ? null : 199, ...extra.metrics },
  moments: extra.moments ?? [],
});

test('批量聚合：胜率与败因分桶', () => {
  const agg = aggregateBatch([
    g('11', false, 'kill'), g('22', true, 'stars'), g('33', false, 'kill'),
    g('44', true, 'kill'), g('55', false, 'stars'), g('66', false, 'zone'),
  ]);
  assert.equal(agg.games, 6);
  assert.equal(agg.wins, 2);
  assert.equal(agg.winRate, 2 / 6);
  assert.equal(agg.lossBuckets.kill, 2);
  assert.equal(agg.lossBuckets.stars, 1);
  assert.equal(agg.lossBuckets.zone, 1);
  assert.ok(Math.abs(agg.avg.accuracy - 0.3) < 1e-9);
});

test('批量聚合：零局时如实给 null，不编 0%', () => {
  const agg = aggregateBatch([]);
  assert.equal(agg.games, 0);
  assert.equal(agg.winRate, null);
});

test('人读批量报告：段落顺序固定、含胜率与逐局行，可直接展示', () => {
  const batch = {
    setup: { opponent: '狙击流派', skill: 'teleport', mapKey: 'crossFort', tank: '我的坦克 v7', seedSet: 'train', seeds: ['11', '22', '33'] },
    at: '2026-08-20T00:00:00.000Z',
    games: [g('11', false, 'kill'), g('22', true, 'stars'), g('33', false, 'kill')],
  };
  const lines = renderBatchText(batch);
  const txt = lines.join('\n');
  assert.ok(Array.isArray(lines));
  assert.ok(txt.includes('AgenTank 批量战报'));
  assert.ok(txt.includes('33%') || txt.includes('33.3%'), '要有胜率百分比');
  assert.ok(txt.includes('狙击流派'));
  assert.ok(txt.includes('seed 11'), '要有逐局行');
  assert.ok(txt.indexOf('总览') < txt.indexOf('逐局'), '段落顺序：总览在逐局之前');
  assert.ok(txt.indexOf('输在哪') < txt.indexOf('逐局'), '段落顺序：败因在逐局之前');
});

test('人读批量报告：一局都没跑成时说清楚，不假装有数据', () => {
  const lines = renderBatchText({ setup: { opponent: 'x', skill: 'teleport', mapKey: 'm', tank: 't', seedSet: 'train', seeds: [] }, at: '2026-08-20T00:00:00.000Z', games: [] });
  const txt = lines.join('\n');
  assert.ok(txt.includes('没有'), '要如实说明没有跑出任何一局');
  assert.ok(!txt.includes('0%'), '不拿 0% 冒充结果');
});

// ───────── 评审 FAIL 后补的回归测试（B4 / 非阻断项） ─────────

test('血线解析：回传来源，读不到就是 default，不许当成玩家写过', () => {
  assert.deepEqual(healThresholdFrom('血量低于 40%'), { value: 40, source: 'parsed' });
  assert.deepEqual(healThresholdFrom('HP 30 以下'), { value: 30, source: 'parsed' });
  assert.deepEqual(healThresholdFrom('不要低于 25 血'), { value: 25, source: 'parsed' });
  assert.deepEqual(healThresholdFrom('hp<30 撤退'), { value: 30, source: 'parsed' });
  assert.deepEqual(healThresholdFrom('血少就撤'), { value: 40, source: 'default' });
  assert.deepEqual(healThresholdFrom('血量低于百分之三十'), { value: 40, source: 'default' });
  assert.deepEqual(healThresholdFrom(''), { value: 40, source: 'default' });
});

test('血线解析：对手的血线不能当成我的回血线', () => {
  assert.deepEqual(healThresholdFrom('对手血量 50 以下时贴身'), { value: 40, source: 'default' });
  assert.deepEqual(healThresholdFrom('敌人血量低于 30 就追击'), { value: 40, source: 'default' });
  // 同时写了双方血线时，取我方那句
  assert.deepEqual(healThresholdFrom('对手血量 50 以下时贴身。我血量低于 25 就撤。'), { value: 25, source: 'parsed' });
});

test('可疑时刻 heal-ignored：战术没写血线时，文案不得声称「你的战术写了」', () => {
  const r = mk([
    { t: 2, type: 'item_spawn', kind: 'medkit', x: 3, y: 1 },
    { t: 5, type: 'hit', who: 1, target: 0, dmg: 70, hp: 30, x: 1, y: 1 },
  ], { ticks: 40 });
  const ms = detectMoments(MAP, r, { who: 0, strategy: '看到敌人就开火' }); // 没写血线
  const hit = ms.find((m) => m.rule === 'heal-ignored');
  assert.ok(hit);
  assert.equal(hit.snapshot.thresholdSource, 'default');
  assert.ok(!hit.why.includes('你的战术写了'), `不得编造玩家没说过的话：${hit.why}`);
  assert.ok(hit.why.includes('默认'), hit.why);
});

test('可疑时刻 wasted-shots：跨度超过时间窗就不算「连续三发」', () => {
  const far = [];
  for (let k = 0; k < 3; k++) { // 每发间隔 40 拍 > wastedWindow(30)
    far.push({ t: 3 + k * 40, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 });
    far.push({ t: 4 + k * 40, type: 'bullet_end', who: 0, reason: 'wall', x: 8, y: 1 });
  }
  const r = mk(far, { ticks: 140 });
  assert.equal(detectMoments(MAP, r, { who: 0 }).filter((m) => m.rule === 'wasted-shots').length, 0);
});

test('可疑时刻 wasted-shots：子弹飞出场外也重置计数（不是被挡）', () => {
  const r = mk([
    { t: 3, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 },
    { t: 4, type: 'bullet_end', who: 0, reason: 'wall', x: 8, y: 1 },
    { t: 6, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 },
    { t: 7, type: 'bullet_end', who: 0, reason: 'out', x: 9, y: 1 },
    { t: 9, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 },
    { t: 10, type: 'bullet_end', who: 0, reason: 'wall', x: 8, y: 1 },
    { t: 12, type: 'fire', who: 0, x: 1, y: 1, dx: 1, dy: 0 },
    { t: 13, type: 'bullet_end', who: 0, reason: 'wall', x: 8, y: 1 },
  ], { ticks: 30 });
  assert.equal(detectMoments(MAP, r, { who: 0 }).filter((m) => m.rule === 'wasted-shots').length, 0);
});

test('状态重建：冻结/眩晕/时钟进状态（引擎不让你动的拍要能识别）', () => {
  const r = mk([
    { t: 5, type: 'freeze_hit', target: 0, duration: 8 },
    { t: 20, type: 'stun_hit', target: 0, duration: 6 },
    { t: 30, type: 'item_pick', who: 1, kind: 'clock', x: 4, y: 4 },
  ], { ticks: 40 });
  const st = replayStates(MAP, r);
  assert.equal(st[5].frozen[0], 8);
  assert.equal(st[9].frozen[0], 4);
  assert.equal(st[14].frozen[0], 0);
  assert.equal(st[20].stunned[0], 6);
  assert.ok(st[30].frozen[0] > 0, '对手拾取时钟应冻住我方');
});

test('可疑时刻：被冻住的那几拍不算「缩圈了还不进圈」（引擎不让动 ≠ 不作为）', () => {
  const evs = [{ t: 10, type: 'zone_shrink', ring: 1, x0: 2, y0: 2, x1: 6, y1: 6 }];
  const free = mk(evs, { ticks: 30 });
  assert.ok(detectMoments(MAP, free, { who: 0 }).some((m) => m.rule === 'zone-outward'), '不被冻时应标出');
  const frozen = mk(evs.concat([{ t: 9, type: 'freeze_hit', target: 0, duration: 25 }]), { ticks: 30 });
  assert.equal(detectMoments(MAP, frozen, { who: 0 }).filter((m) => m.rule === 'zone-outward').length, 0);
});
