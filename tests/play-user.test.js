import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sdkInjectDecision,
  buildTankPayload,
  nextTankVersion,
  buildBattleResultPayload,
  summarizeChallenge,
} from '../web/play.js';

// ---------- SDK 注入 gating ----------
test('gating：file: 协议一律不注入', () => {
  assert.equal(sdkInjectDecision({ protocol: 'file:', search: '' }), 'no');
  assert.equal(sdkInjectDecision({ protocol: 'file:', search: '?play=1' }), 'no');
});

test('gating：http 无 flag 只允许探测（probe），不直接注入', () => {
  assert.equal(sdkInjectDecision({ protocol: 'http:', search: '' }), 'probe');
  assert.equal(sdkInjectDecision({ protocol: 'https:', search: '?seed=x' }), 'probe');
});

test('gating：?play=1 显式开启直接注入', () => {
  assert.equal(sdkInjectDecision({ protocol: 'http:', search: '?play=1' }), 'yes');
  assert.equal(sdkInjectDecision({ protocol: 'https:', search: '?a=b&play=1' }), 'yes');
});

// ---------- Tank payload ----------
test('Tank payload：字段与 spike schema 对齐（name/code/skill/version/is_active）', () => {
  const p = buildTankPayload({ name: '我的坦克', code: 'export default function decide(){}', skill: 'freeze' });
  assert.deepEqual(Object.keys(p).sort(), ['code', 'is_active', 'name', 'skill', 'version']);
  assert.equal(p.version, 1);
  assert.equal(p.is_active, true);
  assert.equal(p.skill, 'freeze');
});

test('Tank version 递增：基于现有实体 version+1，缺省从 0 起', () => {
  assert.equal(nextTankVersion(null), 1);
  assert.equal(nextTankVersion({}), 1);
  assert.equal(nextTankVersion({ version: 3 }), 4);
  assert.equal(nextTankVersion({ version: '7' }), 8);
});

// ---------- BattleResult payload ----------
test('BattleResult payload：字段与 spike schema 对齐', () => {
  const p = buildBattleResultPayload({
    seed: 42, map: 'ravine', opponent: 'stealth',
    result: { winner: 0, reason: 'hp', ticks: 300, stars: [3, 1] },
    elo: 1216, player: 'u1',
  });
  assert.deepEqual(p, {
    seed: '42', map: 'ravine', opponent: 'stealth',
    winner: 0, reason: 'hp', ticks: 300, stars_a: 3, stars_b: 1,
    elo: 1216, player: 'u1',
  });
  // 平局 winner=null 保留 null
  const d = buildBattleResultPayload({ seed: 1, map: 'm', opponent: 'o', result: { winner: null, reason: 'timeout', ticks: 600, stars: [0, 0] }, elo: 1200, player: 'u1' });
  assert.equal(d.winner, null);
});

// ---------- 挑战赛聚合 ----------
test('挑战赛聚合：胜/平/负、胜率、终局 ELO、按对手分组', () => {
  const rows = [
    { opponent: 'a', winner: 0, elo: 1210, player: 'u1' },
    { opponent: 'a', winner: 1, elo: 1200, player: 'u1' },
    { opponent: 'b', winner: null, elo: 1201, player: 'u1' },
    { opponent: 'b', winner: 0, elo: 1215, player: 'u1' },
    { opponent: 'b', winner: 0, elo: 1224, player: 'other' }, // 非本人：过滤
  ];
  const s = summarizeChallenge(rows, 'u1');
  assert.equal(s.total, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.draws, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.winRate, Math.round(((2 + 0.5) / 4) * 100));
  assert.equal(s.elo, 1215); // 最后一条本人记录的 elo
  assert.deepEqual(s.byOpp.map((o) => o.opponent), ['a', 'b']);
  const b = s.byOpp.find((o) => o.opponent === 'b');
  assert.deepEqual({ w: b.w, d: b.d, l: b.l }, { w: 1, d: 1, l: 0 });
});

test('挑战赛聚合：空记录零除保护', () => {
  const s = summarizeChallenge([], 'u1');
  assert.deepEqual({ total: s.total, wins: s.wins, winRate: s.winRate }, { total: 0, wins: 0, winRate: 0 });
  assert.equal(s.elo, null);
});

// ---------- 排名 ----------
test('挑战赛排名：按终局 ELO 对内置 1200 基线排位', () => {
  const s = summarizeChallenge([{ opponent: 'a', winner: 0, elo: 1250, player: 'u1' }], 'u1', [1200, 1300, 1180]);
  // 1300 > 1250 > 1200 > 1180 → rank 2 / 4
  assert.equal(s.rank, 2);
  assert.equal(s.rankTotal, 4);
});
