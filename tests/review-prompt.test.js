// AI 复盘的提示词合同与回复解析：两种模式（这一局 / 一批）+ fail-closed 解析。
// 纪律：AI 只解释「引擎已经标好的可疑时刻」并改写战术文字；解析不出结构就当本轮失败，
// 绝不把半截输出塞进玩家的战术框。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, parseReviewReply, reviewPayloadFromBattle, reviewPayloadFromBatch, compareVerdict } from '../web/play.js';

const battle = {
  setup: { seed: '33', mapKey: 'crossFort', opponent: '狙击流派', tank: '我的坦克 v7', skills: ['teleport', 'shield'], strategy: '优先吃星；血量低于 40 找急救包' },
  result: { win: false, reason: 'kill', ticks: 119, stars: [1, 3] },
  metrics: { accuracy: 0.19, fires: 11, hits: 2, shotsBlocked: 6, dmgDealt: 35, dmgTaken: 100, zoneDmg: 18, skillCasts: 2, skillHits: 0, firstStarTick: 52, enemyFirstStarTick: 34, deathTick: 118, ticks: 119, stars: [1, 3] },
  moments: [
    { t: 34, rule: 'star-ignored', label: '该吃的星没吃', severity: 'high', why: '3 格内就有星，你却奔向 (7,7)', snapshot: { star: { x: 3, y: 2, dist: 3 } } },
    { t: 94, rule: 'heal-ignored', label: '该回血没回', severity: 'high', why: '血只剩 25，6 格外就有急救包却没去', snapshot: { hp: 25, threshold: 40 } },
  ],
  events: new Array(400).fill({ t: 1, type: 'move' }),
};

test('单局提示词：带战术原文、结果、指标与可疑时刻，且不塞全量事件', () => {
  const p = buildReviewPrompt({ mode: 'single', payload: reviewPayloadFromBattle(battle), strategy: battle.setup.strategy });
  assert.ok(p.includes('优先吃星'), '要带玩家战术原文');
  assert.ok(p.includes('该吃的星没吃') && p.includes('t=34'), '要带可疑时刻');
  assert.ok(p.includes('狙击流派'));
  assert.ok(p.includes('"strategy"'), '要给出严格 JSON 的输出合同');
  assert.ok(!p.includes('"events"'), '不把全量事件塞进提示词（预算）');
  assert.ok(p.length < 6000, `提示词应受控，实际 ${p.length}`);
});

test('批量提示词：带胜率、败因分桶与高频不合理操作', () => {
  const batch = {
    setup: { opponent: '狙击流派', skill: 'teleport', mapKey: 'crossFort', tank: '我的坦克 v7', seedSet: 'train', seeds: ['11', '22'] },
    games: [
      { seed: '11', win: false, reason: 'kill', ticks: 200, metrics: { accuracy: 0.2, dmgDealt: 40, dmgTaken: 100, stars: [1, 3] }, moments: battle.moments },
      { seed: '22', win: true, reason: 'stars', ticks: 210, metrics: { accuracy: 0.4, dmgDealt: 70, dmgTaken: 60, stars: [3, 2] }, moments: [] },
    ],
  };
  const p = buildReviewPrompt({ mode: 'batch', payload: reviewPayloadFromBatch(batch), strategy: '优先吃星' });
  assert.ok(p.includes('50%') || p.includes('胜率'), '要带胜率');
  assert.ok(p.includes('seed 11'), '要带逐局行');
  assert.ok(p.includes('该吃的星没吃'), '要带高频不合理操作');
  assert.ok(p.length < 9000, `批量提示词应受控，实际 ${p.length}`);
});

test('提示词：模式非法即抛（不静默按单局处理）', () => {
  assert.throws(() => buildReviewPrompt({ mode: 'whatever', payload: {}, strategy: 's' }), /mode/);
});

test('回复解析：围栏 JSON 正常解析出诊断与新战术', () => {
  const reply = [
    '好的，分析如下：',
    '```json',
    JSON.stringify({
      diagnoses: [
        { title: '缩圈反应慢', detail: '第 2 圈才往里走', evidence: 't=62' },
        { title: '首星慢', detail: '开局绕路捡道具', evidence: 't=34' },
      ],
      strategy: '开局直取最近星星，不绕路捡道具。缩圈预警一出现立刻进圈。血量低于 40 立即找急救包（硬中断）。',
      changes: ['开局直取最近星星', '缩圈预警立刻进圈'],
    }),
    '```',
  ].join('\n');
  const r = parseReviewReply(reply);
  assert.ok(r);
  assert.equal(r.diagnoses.length, 2);
  assert.equal(r.diagnoses[0].title, '缩圈反应慢');
  assert.ok(r.strategy.includes('开局直取最近星星'));
  assert.equal(r.changes.length, 2);
});

test('回复解析：裸 JSON 也接受', () => {
  const r = parseReviewReply(JSON.stringify({ diagnoses: [{ title: 'a', detail: 'b' }], strategy: '新战术' }));
  assert.ok(r);
  assert.equal(r.strategy, '新战术');
  assert.deepEqual(r.changes, []);
});

test('回复解析：缺 strategy / 不是 JSON / 空 → null（fail-closed，不写进战术框）', () => {
  assert.equal(parseReviewReply(''), null);
  assert.equal(parseReviewReply('我觉得你应该更激进一点'), null);
  assert.equal(parseReviewReply(JSON.stringify({ diagnoses: [{ title: 'a' }] })), null);
  assert.equal(parseReviewReply(JSON.stringify({ strategy: '   ' })), null);
});

test('回复解析：诊断条目缺字段时逐条丢弃，不整体崩', () => {
  const r = parseReviewReply(JSON.stringify({
    diagnoses: [{ title: 'ok', detail: 'd' }, { detail: '没标题' }, 'not-an-object'],
    strategy: '新战术文字',
  }));
  assert.ok(r);
  assert.equal(r.diagnoses.length, 1);
  assert.equal(r.diagnoses[0].title, 'ok');
});

test('回复解析：新战术过长时截断，不让模型灌爆战术框', () => {
  const r = parseReviewReply(JSON.stringify({ diagnoses: [], strategy: 'x'.repeat(9000) }));
  assert.ok(r);
  assert.ok(r.strategy.length <= 4000);
  assert.equal(r.truncated, true);
});

// ───────── 改前/改后结论判定：五个态（评审 R2-B1 / R2-B2 回归） ─────────

const K = 'stealth|teleport|crossFort|我的坦克 v7';

test('对比结论：留出组涨了才叫涨', () => {
  const v = compareVerdict({ before: { train: 0.42, holdout: 0.38 }, after: { train: 0.67, holdout: 0.58 }, keys: [K, K], curKey: K });
  assert.deepEqual(v, { state: 'gain', gained: true });
});

test('对比结论：训练组涨、留出组没涨 → 不算涨', () => {
  const v = compareVerdict({ before: { train: 0.42, holdout: 0.83 }, after: { train: 0.92, holdout: 0.58 }, keys: [K], curKey: K });
  assert.deepEqual(v, { state: 'no-gain', gained: false });
});

test('对比结论：没有改前基线 → 不许给「没有提升」的定性结论', () => {
  const v = compareVerdict({ before: { train: 0.42, holdout: null }, after: { train: 0.67, holdout: 0.58 }, keys: [K], curKey: K });
  assert.equal(v.state, 'no-before');
  assert.equal(v.gained, false);
});

test('对比结论：改后批次被丢弃（脚本报错/超时）→ 也不许给否定结论', () => {
  const v = compareVerdict({ before: { train: 0.33, holdout: 0.25 }, after: { train: null, holdout: null }, keys: [K], curKey: K });
  assert.equal(v.state, 'no-after', '这正是「脚本报错整批丢弃」的正常出口，不能说成「没有提升」');
});

test('对比结论：改前改后不是同一套对局设置 → 对比不成立（优先于其它判定）', () => {
  const v = compareVerdict({
    before: { train: 0.25, holdout: 0.25 }, after: { train: 0.5, holdout: 0.5 },
    keys: ['camper|teleport|crossFort|我的坦克 v7', K], curKey: K,
  });
  assert.equal(v.state, 'setup-changed');
  assert.equal(v.gained, false, '换了对手换来的「提升」不得标成 gain');
});

test('对比结论：没给 key 时不误报设置变更（老数据兼容）', () => {
  const v = compareVerdict({ before: { train: 0.4, holdout: 0.4 }, after: { train: 0.5, holdout: 0.5 }, keys: [], curKey: K });
  assert.equal(v.state, 'gain');
});
