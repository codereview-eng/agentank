// AI 复盘循环迭代：择优 / 爬山基准 / 成本预估 / 迭代日志（纯函数，脱离 DOM 才能被钉住）
// 用户口径（2026-08-20 拍板）：迭代结束**总是应用训练组最强那版**，不设留出组门槛；
// 留出组验证改成事后可选按钮。所以 pickBest 只看 trainWinRate，且必须排除无效候选。
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBest, nextRoundBase, iterationCost, buildIterationLog, ITER_LIMITS } from '../web/play.js';

const c = (round, wr, extra = {}) => ({
  round, strategy: `s${round}`, codeHash: `h${round}`, trainWinRate: wr,
  valid: extra.valid !== false, ...extra,
});

test('择优：取训练组胜率最高的有效候选', () => {
  const best = pickBest([c(1, 0.5), c(2, 0.75), c(3, 0.58)]);
  assert.equal(best.round, 2);
  assert.equal(best.trainWinRate, 0.75);
});

test('择优：并列时取更早那轮（少改动优先，避免无谓漂移）', () => {
  assert.equal(pickBest([c(1, 0.75), c(2, 0.75)]).round, 1);
});

test('择优：无效候选（代码跑不了/超时）绝不参与比较', () => {
  const best = pickBest([
    c(1, 0.5),
    c(2, null, { valid: false, invalidReason: 'generated code failed: unbalanced brackets' }),
    c(3, 0.42),
  ]);
  assert.equal(best.round, 1, '无效候选不能因为 null 被当成 0 或被当成最高');
});

test('择优：一个有效候选都没有 → null（上层如实报「本轮没跑出任何可用版本」）', () => {
  assert.equal(pickBest([]), null);
  assert.equal(pickBest([c(1, null, { valid: false })]), null);
  assert.equal(pickBest([c(1, undefined)]), null, '缺分数等于没跑出来，不算有效');
});

test('择优：基线也参与比较（迭代不如原版时，最优就是基线）', () => {
  const baseline = { round: 0, strategy: 'base', trainWinRate: 0.8, valid: true, isBaseline: true };
  const best = pickBest([baseline, c(1, 0.6), c(2, 0.7)]);
  assert.equal(best.isBaseline, true);
  assert.equal(best.round, 0);
});

test('爬山基准：下一轮从「当前最优」继续，而不是从上一轮结果继续', () => {
  const baseline = { round: 0, strategy: 'base', trainWinRate: 0.5, valid: true, isBaseline: true };
  // 第 2 轮改坏了：第 3 轮必须回到第 1 轮那版继续，不能在坏版本上打补丁
  const base = nextRoundBase([baseline, c(1, 0.7), c(2, 0.3)]);
  assert.equal(base.round, 1);
  assert.equal(base.strategy, 's1');
});

test('爬山基准：全都改坏了就回到基线', () => {
  const baseline = { round: 0, strategy: 'base', trainWinRate: 0.9, valid: true, isBaseline: true };
  assert.equal(nextRoundBase([baseline, c(1, 0.4), c(2, 0.2)]).isBaseline, true);
});

test('爬山基准：候选池为空时返回 null（调用方必须自己给基线）', () => {
  assert.equal(nextRoundBase([]), null);
});

test('成本预估：N 轮 = 2N 次 AI 调用 + N×12 局，轮数受上限约束', () => {
  const a = iterationCost(5, 12);
  assert.equal(a.aiCalls, 10);
  assert.equal(a.matches, 60);
  assert.ok(a.estMs > 0);
  assert.equal(iterationCost(999, 12).rounds, ITER_LIMITS.maxRounds, '轮数封顶');
  assert.equal(iterationCost(0, 12).rounds, 1, '至少一轮');
});

test('迭代日志：形状固定，含每轮候选与最终应用结果，可下载', () => {
  const log = buildIterationLog({
    at: '2026-08-20T00:00:00.000Z',
    setup: { opponent: '狙击流派', skill: 'teleport', mapKey: '峡谷', model: 'm1', rounds: 3, tank: '我的坦克 v7' },
    baseline: { round: 0, strategy: 'base', trainWinRate: 0.42, valid: true, isBaseline: true },
    candidates: [c(1, 0.58, { changes: ['缩圈预警立刻进圈'] }), c(2, null, { valid: false, invalidReason: 'sdk-error: LLM_TIMEOUT' })],
    applied: { round: 1, trainWinRate: 0.58 },
    stopped: 'done',
  });
  assert.equal(log.kind, 'agentank-iteration');
  assert.equal(log.schema, 1);
  assert.equal(log.setup.model, 'm1');
  assert.equal(log.baseline.trainWinRate, 0.42);
  assert.equal(log.candidates.length, 2);
  assert.equal(log.candidates[1].valid, false);
  assert.equal(log.candidates[1].invalidReason, 'sdk-error: LLM_TIMEOUT');
  assert.equal(log.applied.round, 1);
  assert.equal(log.stopped, 'done');
  assert.equal(log.stats.validRounds, 1);
  assert.equal(log.stats.failedRounds, 1);
});

test('迭代日志：战术文字里的密钥形状会被打码', () => {
  const log = buildIterationLog({
    setup: { model: 'm', rounds: 1 },
    baseline: { round: 0, strategy: 'token=abcdef123456 别泄漏', trainWinRate: 0.1, valid: true },
    candidates: [], applied: null, stopped: 'aborted',
  });
  assert.ok(!log.baseline.strategy.includes('abcdef123456'));
});

test('迭代日志：必须能自证是不是用调试假 AI 跑的', () => {
  const real = buildIterationLog({ setup: {}, baseline: null, candidates: [], applied: null, stopped: 'done' });
  assert.equal(real.fakeLlm, false);
  const fake = buildIterationLog({ setup: {}, baseline: null, candidates: [], applied: null, stopped: 'done', fakeLlm: true });
  assert.equal(fake.fakeLlm, true, '假 AI 跑出来的记录必须带标记，否则无法与真实结果区分');
});

test('迭代日志：中途改了对局设置的中止态如实落档', () => {
  const log = buildIterationLog({ setup: {}, baseline: null, candidates: [], applied: null, stopped: 'setup-changed' });
  assert.equal(log.stopped, 'setup-changed');
});
