// 无 eval 沙箱：源码切割 / 脚本包装 / Worker 调度协议的合同
// （真引擎的「沙箱 vs 主线程」确定性对拍在 scripts/check-dist.mjs ⑧，跑的是发布产物本身）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEngineSource, decideEntryName, wrapDecide, buildWorkerSource } from '../web/sandbox.js';

const MARK_A = '/*__ENGINE' + '_START__*/';
const MARK_B = '/*__ENGINE' + '_END__*/';

test('extractEngineSource: 从单文件产物切出引擎段', () => {
  const bundle = `"use strict";\n${MARK_A}\nconst RULES = 1;\n${MARK_B}\nconst app = 2;`;
  assert.equal(extractEngineSource(bundle).trim(), 'const RULES = 1;');
});

test('extractEngineSource: 没有标记时返回空串（上层据此 fail-closed，不静默降级）', () => {
  assert.equal(extractEngineSource('const a = 1;'), '');
  assert.equal(extractEngineSource(`${MARK_A} 缺尾标记`), '');
  assert.equal(extractEngineSource(''), '');
});

test('decideEntryName: export default function 取真实函数名，否则按约定 decide', () => {
  assert.equal(decideEntryName('export default function myBot(api) {}'), 'myBot');
  assert.equal(decideEntryName('function decide(api) {}'), 'decide');
});

test('wrapDecide: 包成命名 IIFE，去掉 export default，两段脚本互不污染', () => {
  const a = wrapDecide('export default function decide(api) { const x = 1; return x; }', '__userDecide');
  const b = wrapDecide('function decide(api) { const x = 2; return x; }', '__oppDecide');
  assert.ok(!/export\s+default/.test(a));
  assert.ok(a.includes('const __userDecide = (function ()'));
  const run = new Function(`${a}\n${b}\n;return [__userDecide(), __oppDecide()];`); // 测试环境允许 eval，仅用于验证拼装结果
  assert.deepEqual(run(), [1, 2]); // 同名 decide/x 各自封闭在 IIFE 里，不互相覆盖
});

test('buildWorkerSource: 引擎源缺失即抛（沙箱起不来必须显式失败）', () => {
  assert.throws(() => buildWorkerSource({ engineSrc: '', userCode: 'function decide(){}' }), /engine source unavailable/);
});

// 用最小假引擎验证 Worker 内调度协议：单局 / 天梯批量 / 用户脚本报错兜底 / 未知对手报错
function runHarness(job, opts) {
  const fakeEngine = `
    const bots = { camper: (api) => 'camper-move' };
    function runMatch(o) {
      const a = typeof o.botA === 'function' ? o.botA({ tag: 'A' }) : null;
      const b = typeof o.botB === 'function' ? o.botB({ tag: 'B' }) : null;
      return { winner: a === b ? null : 0, seed: o.seed, a, b, skillA: o.botA && o.botA.skill, map: o.map, content: o.content };
    }
  `;
  const src = buildWorkerSource({ engineSrc: fakeEngine, ...opts });
  const out = [];
  const self = { postMessage: (m) => out.push(m) };
  new Function('self', src)(self); // 模拟 Worker 全局：本测试进程允许 eval，线上则由 blob 加载
  self.onmessage({ data: job });
  return out[0];
}

test('沙箱协议：单局作业跑通，用户装备技能与内容包如实传到引擎', () => {
  const m = runHarness(
    { id: 7, type: 'match', seed: 42, map: { w: 3 }, content: { formatVersion: 1 }, a: { kind: 'user', skill: 'teleport' }, b: { kind: 'builtin', key: 'camper' } },
    { userCode: 'export default function decide(api) { return "user-move"; }' },
  );
  assert.equal(m.id, 7);
  assert.equal(m.ok, true);
  assert.equal(m.result.a, 'user-move');
  assert.equal(m.result.b, 'camper-move');
  assert.equal(m.result.skillA, 'teleport');
  assert.equal(m.result.seed, 42);
  assert.deepEqual(m.result.map, { w: 3 });
  assert.equal(m.errCount, 0);
});

test('沙箱协议：工坊 bot 以源码随行（Worker 内同样零 eval）', () => {
  const m = runHarness(
    { type: 'match', seed: 1, a: { kind: 'user', skill: 'shield' }, b: { kind: 'code', skill: 'freeze' } },
    { userCode: 'function decide() { return "u"; }', oppCode: 'export default function botMain() { return "pack-bot"; }' },
  );
  assert.equal(m.ok, true);
  assert.equal(m.result.b, 'pack-bot');
});

test('沙箱协议：玩家脚本抛错 = 本拍待机并计数，不整局崩', () => {
  const m = runHarness(
    { type: 'match', seed: 1, a: { kind: 'user', skill: 'shield' }, b: { kind: 'builtin', key: 'camper' } },
    { userCode: 'function decide() { throw new Error("boom"); }' },
  );
  assert.equal(m.ok, true);
  assert.equal(m.result.a, null); // 报错这拍返回 null（待机），与引擎口径一致
  assert.equal(m.errCount, 1);
  assert.match(m.errLast, /boom/);
});

test('沙箱协议：天梯批量作业按序返回胜负', () => {
  const m = runHarness(
    { type: 'ladder', jobs: [
      { seed: 1, a: { kind: 'user', skill: 'shield' }, b: { kind: 'builtin', key: 'camper' } },
      { seed: 2, a: { kind: 'builtin', key: 'camper' }, b: { kind: 'builtin', key: 'camper' } },
    ] },
    { userCode: 'function decide() { return "u"; }' },
  );
  assert.equal(m.ok, true);
  assert.deepEqual(m.results, [{ winner: 0 }, { winner: null }]);
});

test('沙箱协议：脚本没有 decide 入口 / 未知内置对手 → 显式失败，不静默出假结果', () => {
  const noEntry = runHarness(
    { type: 'match', seed: 1, a: { kind: 'user', skill: 'shield' }, b: { kind: 'builtin', key: 'camper' } },
    { userCode: 'const notADecide = 1;' },
  );
  assert.equal(noEntry.ok, false);
  assert.match(noEntry.error, /no decide\(api\) entry/);

  const badOpp = runHarness(
    { type: 'match', seed: 1, a: { kind: 'user', skill: 'shield' }, b: { kind: 'builtin', key: 'nope' } },
    { userCode: 'function decide() { return 1; }' },
  );
  assert.equal(badOpp.ok, false);
  assert.match(badOpp.error, /unknown builtin bot/);
});
