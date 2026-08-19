// 回归：线上（CSP 禁 eval）保存自定义脚本 100% 必败
//
// 真凶：saveVersion() 拿 compileScript() 当语法闸门，而 compileScript 在禁 eval 的宿主上
// 对任何非默认脚本无条件抛 CSP_NO_EVAL —— 保存只是把代码写进云端、根本不需要执行它，
// 却被"能不能执行"挡死；提示文案还谎称"沙箱也没起来"（实测沙箱是好的）。
//
// 闸门正解 = scriptGate：能 eval 就真编译（最强），禁 eval 就用不执行代码的结构校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scriptGate } from '../web/play.js';

const GOOD = `export default function decide(api) {
  const me = api.me();
  if (api.enemyVisible() && api.canFire()) return api.fireAt(api.enemy());
  return api.patrol();
}`;

// 线上宿主：禁 eval。这条以前是 100% 必败的那一条。
test('禁 eval 的宿主：合法自定义脚本照样能过保存闸门', () => {
  const g = scriptGate(GOOD, { evalOk: false });
  assert.equal(g.ok, true, `应放行，实际 errors=${JSON.stringify(g.errors)}`);
  assert.deepEqual(g.errors, []);
});

test('禁 eval 的宿主：闸门绝不调用 compile（不执行代码）', () => {
  let called = 0;
  const g = scriptGate(GOOD, { evalOk: false, compile: () => { called++; } });
  assert.equal(called, 0);
  assert.equal(g.ok, true);
});

test('禁 eval 的宿主：真结构错误仍被拦（不是无脑放行）', () => {
  assert.equal(scriptGate('export default function decide(api) { return api.patrol();', { evalOk: false }).ok, false);
  assert.equal(scriptGate('const x = 1;', { evalOk: false }).ok, false); // 无 decide 入口
  assert.equal(scriptGate('', { evalOk: false }).ok, false);
  assert.equal(scriptGate('function decide(){ return eval("1"); }', { evalOk: false }).ok, false); // 禁用宿主 API
});

test('允许 eval 的宿主：走真编译，语法错如实拦下', () => {
  const compile = (src) => { if (!src.includes('decide')) throw new Error('boom'); return () => null; };
  assert.equal(scriptGate(GOOD, { evalOk: true, compile }).ok, true);
  const bad = scriptGate('const x =', { evalOk: true, compile });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, ['boom']);
});

test('compile 抛 CSP_NO_EVAL：退回结构校验，绝不当成玩家代码写错', () => {
  const compile = () => { const e = new Error('CSP 挡了'); e.code = 'CSP_NO_EVAL'; throw e; };
  const g = scriptGate(GOOD, { evalOk: true, compile });
  assert.equal(g.ok, true, 'CSP 限制不得冒充编译失败');
});

// 机械防回归：保存路径与挑战赛路径都不得再把 compileScript 当唯一闸门。
// （这两处正是本次线上必败的落点；源码级断言比行为测试更能钉住"别再退回去"。）
test('源码防回归：保存与挑战赛闸门都走 scriptGate，不再裸调 compileScript', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const save = app.slice(app.indexOf('async function saveVersion()'), app.indexOf('function updateVersionUi()'));
  assert.ok(save.length > 100, 'saveVersion 源码定位失败（函数名改了？）');
  assert.ok(!/compileScript\s*\(/.test(save), 'saveVersion 不得再拿 compileScript 当闸门');
  assert.ok(/scriptGate\s*\(/.test(save), 'saveVersion 必须走 scriptGate');

  const play = readFileSync(new URL('../web/play.js', import.meta.url), 'utf8');
  const ch = play.slice(play.indexOf('challengeBtn.addEventListener'), play.indexOf('function bootAgentKeys'));
  assert.ok(ch.length > 100, '挑战赛源码定位失败');
  assert.ok(/scriptGate\s*\(/.test(ch), '挑战赛必须走 scriptGate');
});
