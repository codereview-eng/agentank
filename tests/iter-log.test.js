// 多轮 AI 复盘的「每轮汇总日志 + 防误认卡死」纯函数（脱离 DOM 才能被钉住）
// 为什么要有这一层：迭代要跑几分钟，界面上原先只有一行不动的字（第 r/n 轮 · 步骤名），
// 且 AI 调用没有任何超时——模型挂住时那行字永远不变，用户与自动化都分不出「在跑」和「死了」。
// 这里钉住的正是「让活着可被看见」的三件事：日志事件形状、耗时/涨跌/剩余时间口径、失败原因说人话。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ITER_TIMEOUTS, pushIterLog, winDelta, explainIterFail, iterEta, iterProgress, stepPace, fmtClock,
  buildIterationLog,
} from '../web/play.js';
import { LOCALES } from '../web/i18n.js';

// ---------- 日志事件：追加、限长、顺序 ----------
test('日志追加：按发生顺序累积，每条带轮次/步骤/耗时', () => {
  let log = [];
  log = pushIterLog(log, { kind: 'review', round: 1, ok: true, ms: 12400, detail: '一味追击' });
  log = pushIterLog(log, { kind: 'gen', round: 1, ok: true, ms: 8100 });
  assert.equal(log.length, 2);
  assert.equal(log[0].kind, 'review');
  assert.equal(log[0].round, 1);
  assert.equal(log[0].ok, true);
  assert.equal(log[0].ms, 12400);
  assert.equal(log[1].kind, 'gen');
  assert.ok(typeof log[0].at === 'string' && log[0].at, '每条都要有时间戳，否则事后无法还原节奏');
});

test('日志追加：不改原数组（渲染层靠引用变化判断要不要重画）', () => {
  const a = [];
  const b = pushIterLog(a, { kind: 'review', round: 1, ok: true, ms: 1 });
  assert.equal(a.length, 0);
  assert.notEqual(a, b);
});

test('日志限长：只留最近 cap 条，丢最老的（10 轮 × 多步不能无上限涨）', () => {
  let log = [];
  for (let i = 1; i <= 12; i++) log = pushIterLog(log, { kind: 'review', round: i, ok: true, ms: i }, 5);
  assert.equal(log.length, 5);
  assert.equal(log[0].round, 8, '丢的是最老那批');
  assert.equal(log[4].round, 12);
});

// ---------- 胜率涨跌：日志里「比基线好了多少」必须是同一口径 ----------
test('涨跌：以百分点给出方向与幅度', () => {
  assert.deepEqual(winDelta(0.58, 0.42), { pt: 16, dir: 'up' });
  assert.deepEqual(winDelta(0.3, 0.42), { pt: -12, dir: 'down' });
  assert.deepEqual(winDelta(0.42, 0.42), { pt: 0, dir: 'flat' });
});

test('涨跌：缺任一侧就返回 null（不能把「没有基线」印成 0 提升）', () => {
  assert.equal(winDelta(0.5, null), null);
  assert.equal(winDelta(null, 0.5), null);
  assert.equal(winDelta(0.5, undefined), null);
  assert.equal(winDelta(NaN, 0.5), null);
});

// ---------- 失败原因：内部串 → 人话 key（原始串仍保留，供下载日志排查） ----------
test('失败原因：每类内部串都映射到人话文案，且原始串不丢', () => {
  const cases = [
    ['review timeout after 90000ms', 'ui.itFailTimeout'],
    ['review unparsable: chars=0 head=', 'ui.itFailUnparsable'],
    ['review AbortError: aborted', 'ui.itFailAborted'],
    ['review Error: LLM_RATE_LIMIT', 'ui.itFailReview'],
    ['gen timeout after 120000ms', 'ui.itFailTimeout'],
    ['gen produced identical code', 'ui.itFailSameCode'],
    ['gen invalid-output: no code block found in output', 'ui.itFailGen'],
    ['eval failed: 脚本第 3 局抛异常', 'ui.itFailEval'],
    ['setup changed during eval', 'ui.itFailSetup'],
    ['', 'ui.itFailOther'],
  ];
  for (const [raw, key] of cases) {
    const r = explainIterFail(raw);
    assert.equal(r.key, key, `${raw} 应映射到 ${key}`);
    assert.equal(r.raw, raw, '原始串必须原样保留（下载日志要靠它定位）');
  }
});

test('失败原因：人话文案在 zh/en 词典里都真的存在（不能渲染出裸 key）', () => {
  const keys = new Set(['itFailTimeout', 'itFailUnparsable', 'itFailAborted', 'itFailReview',
    'itFailSameCode', 'itFailGen', 'itFailEval', 'itFailSetup', 'itFailOther']);
  for (const k of keys) {
    assert.ok(LOCALES.zh.ui[k], `zh 缺 ui.${k}`);
    assert.ok(LOCALES.en.ui[k], `en 缺 ui.${k}`);
  }
});

// ---------- 剩余时间：优先用已跑完那几轮的实测均值 ----------
test('剩余时间：有实测轮耗时就按均值推，不用理论估算', () => {
  // 已跑完 2 轮，各 30s → 剩 1 轮 ≈ 30s
  const ms = iterEta({ round: 2, rounds: 3, roundMs: [30000, 30000] });
  assert.equal(ms, 30000);
});

test('剩余时间：还没有任何一轮跑完时退回理论估算（而不是显示 0）', () => {
  const ms = iterEta({ round: 1, rounds: 3, roundMs: [], matchesPerRound: 12 });
  assert.ok(ms > 0, '开跑第一轮就该给出一个估算，否则界面上是「约剩 0:00」的假象');
});

test('剩余时间：最后一轮跑完 → 0', () => {
  assert.equal(iterEta({ round: 3, rounds: 3, roundMs: [1000, 1000, 1000] }), 0);
});

test('剩余时间：轮内也要随已用时间递减（整轮不动的数字看着就像卡死）', () => {
  const a = iterEta({ round: 1, rounds: 3, roundMs: [30000], curElapsedMs: 0 });
  const b = iterEta({ round: 1, rounds: 3, roundMs: [30000], curElapsedMs: 5000 });
  assert.equal(a, 60000);
  assert.equal(b, 55000);
  assert.equal(iterEta({ round: 1, rounds: 3, roundMs: [30000], curElapsedMs: 999999 }), 0, '不许出现负数');
});

test('时钟格式：毫秒 → mm:ss（语言中立，中英共用）', () => {
  assert.equal(fmtClock(0), '0:00');
  assert.equal(fmtClock(9000), '0:09');
  assert.equal(fmtClock(130000), '2:10');
  assert.equal(fmtClock(3600000), '60:00');
});

// ---------- 总进度：条形必须单调前进，不能在轮内静止 ----------
test('总进度：轮内每推进一步都涨，且封在 0..1', () => {
  const a = iterProgress({ round: 1, rounds: 3, stepIndex: 0 });
  const b = iterProgress({ round: 1, rounds: 3, stepIndex: 1 });
  const c = iterProgress({ round: 1, rounds: 3, stepIndex: 2 });
  const d = iterProgress({ round: 2, rounds: 3, stepIndex: 0 });
  assert.ok(a < b && b < c && c <= d, `轮内三步必须递增：${a} ${b} ${c} ${d}`);
  assert.ok(a >= 0 && d <= 1);
  assert.equal(iterProgress({ round: 3, rounds: 3, stepIndex: 3 }), 1);
});

// ---------- 慢提示：正常 / 偏慢 / 快超时 ----------
test('步骤节奏：超过慢阈值报「还在想」，接近超时再升级', () => {
  assert.equal(stepPace(3000, 90000, 20000), 'normal');
  assert.equal(stepPace(25000, 90000, 20000), 'slow');
  assert.equal(stepPace(85000, 90000, 20000), 'near-timeout');
});

test('超时口径：复盘/生成都有硬超时，且慢提示阈值小于超时', () => {
  assert.ok(ITER_TIMEOUTS.reviewMs > 0 && ITER_TIMEOUTS.genMs > 0);
  assert.ok(ITER_TIMEOUTS.slowHintMs < ITER_TIMEOUTS.reviewMs);
  assert.ok(ITER_TIMEOUTS.evalMs > 0, '线上评分整批丢进 Worker，也要有超时');
});

// ---------- 下载记录：日志事件一起落档 ----------
test('迭代记录：日志事件随记录落档，密钥形状打码', () => {
  const log = buildIterationLog({
    setup: {}, baseline: null, candidates: [], applied: null, stopped: 'done',
    events: [
      { kind: 'review', round: 1, ok: true, ms: 1200, detail: 'token=abcdef123456 泄漏样本', at: '2026-08-20T00:00:00.000Z' },
      { kind: 'eval', round: 1, ok: true, ms: 3200, winRate: 0.58 },
    ],
  });
  assert.equal(log.events.length, 2);
  assert.equal(log.events[0].kind, 'review');
  assert.ok(!log.events[0].detail.includes('abcdef123456'), '日志正文同样要打码');
  assert.equal(log.events[1].winRate, 0.58);
});

test('迭代记录：没有日志事件时是空数组（字段永不缺，下游不用判 undefined）', () => {
  const log = buildIterationLog({ setup: {}, baseline: null, candidates: [], applied: null, stopped: 'done' });
  assert.deepEqual(log.events, []);
});
