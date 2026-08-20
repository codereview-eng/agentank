// 胜负结论必须带「谁死了 + 怎么死的」，且文案是我方视角
//
// 用户实测（2026-08-20，训练组 12 局全胜）报告长这样：
//   seed tr01  胜  被打死  命中 0%  打0/挨0  星1:0
// 「胜」+「被打死」并列，读起来就是「我被打死却判我胜」；而回放里真正发生的是毒圈致死。
// 两个真缺陷：
//   ① 引擎的 reason 是**全局**胜负原因（kill = 有人被打死），renderBatchText 把它当**我方败因**贴在胜负后面；
//   ② kill 从不区分致死来源（子弹/炸弹/毒/毒圈），回放里明明是毒圈，报告说不出来
//      （旁证：AZ_REASON_CN 里有个引擎永不产生的死键 zone: '毒圈拖死'）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, presetMap, summarizeGame, aggregateBatch, renderBatchText, verdictOf } from '../src/engine/index.js';

// 毒圈收缩提前 + 中等伤害：给「往圈心走」的那台留出赶到安全区的时间，
// 于是「谁站在圈外」成为唯一死因 —— 单亡且确定性可复现。
const ZONE_RULES = { zone: { start: 40, every: 6, dmg: 25, dmgStep: 5 } };
const idle = () => null;
const toCenter = (api) => {
  const z = api.zone();
  return api.moveTo({ x: Math.floor((z.x0 + z.x1) / 2), y: Math.floor((z.y0 + z.y1) / 2) });
};

function zoneKillMatch() {
  // A 往圈心走（活）、B 原地蹲角（被毒圈拖死）→ 单亡，死因必须是 zone
  return runMatch({
    seed: 7, map: presetMap('arena'), botA: toCenter, botB: idle,
    rules: ZONE_RULES, maxTicks: 200,
  });
}

test('引擎：两台都蹲着不动 = 同拍双亡，胜负走判定链而不是「被打死」', () => {
  // 这正是用户那份报告的现场形态（双方命中 0%、伤害 0、260 拍前后结算）
  const r = runMatch({ seed: 7, map: presetMap('arena'), botA: idle, botB: idle, rules: ZONE_RULES, maxTicks: 200 });
  assert.notEqual(r.reason, 'kill', '双亡不能报成 kill');
  assert.equal(r.deaths.length, 2, '两台都阵亡');
  assert.ok(r.deaths.every((d) => d.cause === 'zone'), `双方都该死于毒圈，实际：${JSON.stringify(r.deaths)}`);
  const v = verdictOf(r, 0);
  assert.equal(v.how, 'tiebreak');
  assert.equal(v.cause, 'zone', '判定局也要说得出我方是怎么倒下的');
});

test('引擎：毒圈致死必须记下死因（谁死的、怎么死的）', () => {
  const r = zoneKillMatch();
  assert.equal(r.reason, 'kill', '单亡仍是 kill（旧契约不破）');
  assert.ok(Array.isArray(r.deaths), 'result.deaths 必须存在，否则报告永远说不出「毒圈」');
  assert.equal(r.deaths.length, 1, '只有一方阵亡');
  assert.equal(r.deaths[0].who, 1, '死的是原地不动那台');
  assert.equal(r.deaths[0].cause, 'zone', '死因是毒圈，不是被打死');
  assert.equal(r.winner, 0);
});

test('我方视角：对手被毒圈拖死 = 我胜，且结论不能写成「被打死」', () => {
  const r = zoneKillMatch();
  const v = verdictOf(r, 0);
  assert.deepEqual(v, { win: true, how: 'enemy-dead', cause: 'zone', tiebreak: null });
});

test('我方视角：我被毒圈拖死 = 我负（同一局换视角，结论必须翻面）', () => {
  const r = zoneKillMatch();
  const v = verdictOf(r, 1);
  assert.deepEqual(v, { win: false, how: 'self-dead', cause: 'zone', tiebreak: null });
});

test('我方视角：子弹击杀与毒圈拖死必须能分开', () => {
  const shot = { winner: 0, reason: 'kill', deaths: [{ who: 1, cause: 'bullet' }] };
  assert.deepEqual(verdictOf(shot, 0), { win: true, how: 'enemy-dead', cause: 'bullet', tiebreak: null });
  assert.deepEqual(verdictOf(shot, 1), { win: false, how: 'self-dead', cause: 'bullet', tiebreak: null });
});

test('我方视角：同拍双亡/超时走判定链，不能说成谁被打死', () => {
  const both = { winner: 0, reason: 'stars', deaths: [{ who: 0, cause: 'zone' }, { who: 1, cause: 'zone' }] };
  assert.deepEqual(verdictOf(both, 0), { win: true, how: 'tiebreak', cause: 'zone', tiebreak: 'stars' });
  const timeout = { winner: 1, reason: 'center', deaths: [] };
  assert.deepEqual(verdictOf(timeout, 0), { win: false, how: 'tiebreak', cause: null, tiebreak: 'center' });
});

test('旧战报兼容：没有 deaths 字段时不许崩，只是死因未知', () => {
  const old = { winner: 0, reason: 'kill' };
  assert.deepEqual(verdictOf(old, 0), { win: true, how: 'enemy-dead', cause: null, tiebreak: null });
  assert.deepEqual(verdictOf(old, 1), { win: false, how: 'self-dead', cause: null, tiebreak: null });
});

test('单局摘要：带上我方视角的结论与死因（批量报告靠它出文案）', () => {
  const r = zoneKillMatch();
  const g = summarizeGame({ map: presetMap('arena'), result: r, who: 0, seed: 'tr01', strategy: '' });
  assert.equal(g.win, true);
  assert.equal(g.how, 'enemy-dead');
  assert.equal(g.cause, 'zone');
});

test('批量文本：全胜的报告里绝不能出现「被打死」，胜局要写清对手怎么死的', () => {
  const r = zoneKillMatch();
  const games = ['tr01', 'tr02'].map((s) => summarizeGame({ map: presetMap('arena'), result: r, who: 0, seed: s, strategy: '' }));
  const batch = {
    setup: { opponent: '哨戒流', skill: 'shield', mapKey: '迷宫回廊', tank: 'tankbase v6', seedSet: 'train' },
    at: '2026-08-20T02:15:00.000Z',
    games, agg: aggregateBatch(games),
  };
  const text = renderBatchText(batch).join('\n');
  assert.ok(/对手被毒圈拖死/.test(text), `胜局应写明对手死因，实际：\n${text}`);
  assert.ok(!/被打死/.test(text), `全胜报告里不该出现「被打死」，实际：\n${text}`);
});

test('批量文本：负局按我方视角分桶（毒圈拖死与被打死分开统计）', () => {
  // 见下一条：双亡局的文案必须同时交代死因与判定方式
  const lost = { winner: 1, reason: 'kill', deaths: [{ who: 0, cause: 'zone' }], ticks: 30, events: [], stars: [0, 0] };
  const games = [{ seed: 'tr01', win: false, how: 'self-dead', cause: 'zone', reason: 'kill', ticks: 30, metrics: {} }];
  const agg = aggregateBatch(games);
  assert.equal(agg.losses, 1);
  assert.deepEqual(Object.keys(agg.lossBuckets), ['self-dead:zone'], '败因桶必须区分死因，而不是笼统的 kill');
  const text = renderBatchText({ setup: {}, at: '', games, agg }).join('\n');
  assert.ok(/毒圈/.test(text), `败因区应点名毒圈，实际：\n${text}`);
  assert.ok(lost.winner === 1);
});

test('批量文本：同拍双亡局必须同时交代死因与判定方式（只写「掷签负」会与回放脱节）', () => {
  // 用户那份报告的真实形态：双方都不开火、260 拍毒圈同拍带走两台、胜负由掷签定
  const games = ['tr01', 'tr02'].map((s) => ({
    seed: s, win: false, reason: 'coin', how: 'tiebreak', cause: 'zone', ticks: 261, metrics: {},
  }));
  const agg = aggregateBatch(games);
  assert.deepEqual(Object.keys(agg.lossBuckets), ['tiebreak:coin:zone'], '桶名要留住死因，否则「输在哪」说不出毒圈');
  const text = renderBatchText({ setup: {}, at: '', games, agg }).join('\n');
  assert.ok(/双方被毒圈拖死/.test(text), `逐局行要说双方都被毒圈带走，实际：\n${text}`);
  assert.ok(/种子掷签负/.test(text), `还要说清胜负是怎么判出来的，实际：\n${text}`);
});
