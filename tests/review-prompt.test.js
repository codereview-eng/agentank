// AI 复盘的提示词合同与回复解析：两种模式（这一局 / 一批）+ fail-closed 解析。
// 纪律：AI 只解释「引擎已经标好的可疑时刻」并改写战术文字；解析不出结构就当本轮失败，
// 绝不把半截输出塞进玩家的战术框。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewPrompt, parseReviewReply, reviewPayloadFromBattle, reviewPayloadFromBatch } from '../web/play.js';

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
