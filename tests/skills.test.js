import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii } from '../src/engine/index.js';

const idle = () => null;

const openMap = () => mapFromAscii([
  '#######',
  '#A...B#',
  '#.....#',
  '#######',
]);

test('传送：位置立即改变，冷却期内 ready(teleport)=false', () => {
  const readyLog = [];
  const meLog = [];
  let used = false;
  const A = (api) => {
    readyLog.push(api.ready('teleport'));
    meLog.push(api.me());
    if (!used && api.ready('teleport')) { used = true; return api.teleport({ x: 1, y: 2 }); }
    return null;
  };
  const r = runMatch({ seed: 1, map: openMap(), botA: A, botB: idle, maxTicks: 5 });
  assert.equal(readyLog[0], true);
  assert.equal(readyLog[1], false, '传送后冷却期内应不可再用');
  assert.deepEqual({ x: meLog[1].x, y: meLog[1].y }, { x: 1, y: 2 }, '传送应立即生效');
  assert.ok(r.events.some((e) => e.type === 'skill' && e.name === 'teleport' && e.who === 0));
});

test('传送非法目标（墙）：重定向到最近合法格并消耗冷却', () => {
  const readyLog = [];
  let used = false;
  const A = (api) => {
    readyLog.push(api.ready('teleport'));
    if (!used) { used = true; return api.teleport({ x: 0, y: 0 }); }
    return null;
  };
  const r = runMatch({ seed: 1, map: openMap(), botA: A, botB: idle, maxTicks: 3 });
  const sk = r.events.find((e) => e.type === 'skill' && e.name === 'teleport');
  assert.ok(sk, '非法目标应被重定向而非作废');
  assert.deepEqual({ x: sk.x, y: sk.y }, { x: 1, y: 1 }, '离 (0,0) 最近的合法格是出发格自身');
  assert.deepEqual(readyLog, [true, false, false], '重定向传送同样消耗冷却');
  assert.ok(r.events.some((e) => e.type === 'teleport_reveal' && e.who === 0));
});

test('隐身：生效期间对敌不可见，到期后恢复可见', () => {
  const vis = [];
  let used = false;
  const A = (api) => {
    if (!used && api.ready('cloak')) { used = true; return api.cloak(); }
    return null;
  };
  const B = (api) => { vis.push(api.enemyVisible()); return null; };
  runMatch({ seed: 1, map: openMap(), botA: A, botB: B, skillA: 'cloak', maxTicks: 40 });
  assert.equal(vis[0], true, '隐身生效前可见');
  assert.equal(vis[10], false, '隐身期间不可见');
  assert.equal(vis[30], true, '隐身到期后恢复可见');
});

test('隐身被开火打破', () => {
  const vis = [];
  let st = 0;
  const A = (api) => {
    if (st === 0) { st = 1; return api.cloak(); }
    if (st === 1) { st = 2; return api.fireAt(api.enemy()); }
    return null;
  };
  const B = (api) => { vis.push(api.enemyVisible()); return null; };
  runMatch({ seed: 1, map: openMap(), botA: A, botB: B, skillA: 'cloak', maxTicks: 6 });
  assert.equal(vis[1], false, '隐身中不可见');
  assert.equal(vis[2], true, '开火后隐身应被打破');
});

test('冰冻（原眩晕语义）：命中后敌人 8 拍不能行动，冷却期内不可再用', () => {
  const map = mapFromAscii([
    '######',
    '#A.B.#',
    '######',
  ]);
  const readyLog = [];
  const A = (api) => {
    readyLog.push(api.ready('freeze'));
    if (api.ready('freeze') && api.enemyVisible()) return api.useSkill();
    return null;
  };
  const B = (api) => api.moveTo({ x: 4, y: 1 });
  const r = runMatch({ seed: 1, map, botA: A, botB: B, skillA: 'freeze', maxTicks: 12 });
  assert.ok(r.events.some((e) => e.type === 'freeze_hit' && e.target === 1));
  assert.equal(readyLog[0], true);
  assert.equal(readyLog[1], false, '冰冻进入冷却');
  const movesB = r.events.filter((e) => e.type === 'move' && e.who === 1);
  assert.ok(movesB.length >= 1, '冰冻结束后应能行动');
  assert.equal(movesB[0].t, 8, '冰冻 8 拍内不能移动，第 8 拍恢复');
});

test('开火冷却：射击后 canFire=false，冷却结束且子弹终结后恢复', () => {
  const map = mapFromAscii([
    '########',
    '#A....B#',
    '########',
  ]);
  const canLog = [];
  const A = (api) => {
    canLog.push(api.canFire());
    return api.canFire() ? api.fireAt(api.enemy()) : null;
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle });
  assert.equal(canLog[0], true);
  assert.equal(canLog[1], false);
  assert.equal(canLog[4], false);
  assert.equal(canLog[5], true, '冷却 5 拍后恢复（此时子弹已于 t=3 终结）');
  assert.equal(r.winner, 0);
  assert.equal(r.reason, 'kill');
});
