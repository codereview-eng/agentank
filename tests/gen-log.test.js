// 生成闸门（无 eval）+ 诊断日志：线上 CSP 禁 eval 时的生成链路合同
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGeneratedCode, buildGenLog, redactSecrets, genLogFilename } from '../web/play.js';

test('checkGeneratedCode: 正常生成代码通过（不执行任何代码）', () => {
  const code = [
    'export default function decide(api) {',
    '  const me = api.me();',
    '  if (api.enemyVisible() && api.canFire()) return api.fireAt(api.enemy());',
    '  if (me.hp < 30 && api.ready()) return api.useSkill(api.safestCorner());',
    '  const s = api.nearestStar();',
    '  return s ? api.moveTo(s) : api.patrol();',
    '}',
  ].join('\n');
  assert.deepEqual(checkGeneratedCode(code), { ok: true, errors: [] });
});

test('checkGeneratedCode: 缺 decide 入口 / 括号不配平 / 空 一律拦下', () => {
  assert.equal(checkGeneratedCode('const a = 1;').ok, false);
  assert.equal(checkGeneratedCode('').ok, false);
  const broken = 'function decide(api) { if (api.canFire()) { return api.patrol(); }';
  const r = checkGeneratedCode(broken);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('unbalanced')));
});

test('checkGeneratedCode: 字符串/注释里的括号不算结构（不误伤）', () => {
  const code = 'function decide(api) {\n  // 说明：( 不配平的注释\n  const s = "))) {{{";\n  return api.patrol();\n}';
  assert.equal(checkGeneratedCode(code).ok, true);
});

test('checkGeneratedCode: 越权宿主 API 与 eval 一律拦下（沙箱只喂 api）', () => {
  for (const bad of [
    'function decide(api){ fetch("https://x"); return null }',
    'function decide(api){ return eval("1") }',
    'function decide(api){ localStorage.setItem("a","b"); return null }',
    'function decide(api){ return new Function("return 1")() }',
  ]) assert.equal(checkGeneratedCode(bad).ok, false, bad);
});

test('redactSecrets: 凭证一律打码，不进诊断日志', () => {
  const s = redactSecrets('Authorization: Bearer abc.def-123 与 ak1_SECRETVALUE1 与 "access_token":"zzzzzzzzzz" 与 ?token=abcdef123');
  assert.ok(!s.includes('abc.def-123'));
  assert.ok(!s.includes('SECRETVALUE1'));
  assert.ok(!s.includes('zzzzzzzzzz'));
  assert.ok(!s.includes('abcdef123'));
  assert.ok(s.includes('«redacted»'));
});

test('buildGenLog: 结构完整 + 环境事实如实 + 附上每轮尝试', () => {
  const log = buildGenLog({
    outcome: 'ok-cannot-run',
    reason: 'host forbids dynamic compilation (CSP without unsafe-eval)',
    at: Date.UTC(2026, 7, 19, 6, 0, 0),
    durationMs: 4321.7,
    env: {
      url: 'https://play-agentank.run.ceo/?token=supersecret1',
      lang: 'zh',
      ua: 'Mozilla/5.0',
      evalAllowed: false,
      workerAllowed: true,
      sdk: 'ready',
      csp: "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    },
    strategy: '看得见敌人就开炮',
    skill: 'teleport',
    attempts: [{ n: 1, promptChars: 1200, replyChars: 800, replyHead: '```js', extracted: true, codeChars: 300, code: 'function decide(){}', errorKind: '', error: '' }],
  });
  assert.equal(log.kind, 'agentank-generation-diagnostic');
  assert.equal(log.schema, 1);
  assert.equal(log.outcome, 'ok-cannot-run');
  assert.equal(log.env.evalAllowed, false);
  assert.equal(log.env.workerAllowed, true);
  assert.equal(log.durationMs, 4322);
  assert.equal(log.input.strategyChars, '看得见敌人就开炮'.length);
  assert.equal(log.attempts.length, 1);
  assert.equal(log.attempts[0].extracted, true);
  assert.ok(!JSON.stringify(log).includes('supersecret1')); // URL 里的凭证也被打码
  assert.ok(log.at.endsWith('Z'));
});

test('buildGenLog: 缺省输入不炸，evalAllowed 缺省按 false（不谎报能力）', () => {
  const log = buildGenLog({});
  assert.equal(log.env.evalAllowed, false);
  assert.equal(log.env.workerAllowed, false);
  assert.deepEqual(log.attempts, []);
  assert.equal(log.outcome, 'unknown');
});

test('genLogFilename: 文件名带本地时间戳且为 .json', () => {
  const name = genLogFilename(new Date(2026, 7, 19, 14, 5, 9));
  assert.equal(name, 'agentank-gen-log-20260819-140509.json');
});
