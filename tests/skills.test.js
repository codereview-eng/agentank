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

test('传送非法目标（墙）：不生效也不消耗冷却', () => {
  const readyLog = [];
  const A = (api) => {
    readyLog.push(api.ready('teleport'));
    return api.teleport({ x: 0, y: 0 });
  };
  const r = runMatch({ seed: 1, map: openMap(), botA: A, botB: idle, maxTicks: 3 });
  assert.deepEqual(readyLog, [true, true, true]);
  assert.equal(r.events.filter((e) => e.type === 'skill' && e.name === 'teleport').length, 0);
});

test('隐身：生效期间对敌不可见，到期后恢复可见', () => {
  const vis = [];
  let used = false;
  const A = (api) => {
    if (!used && api.ready('cloak')) { used = true; return api.cloak(); }
    return null;
  };
  const B = (api) => { vis.push(api.enemyVisible()); return null; };
  runMatch({ seed: 1, map: openMap(), botA: A, botB: B, maxTicks: 40 });
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
  runMatch({ seed: 1, map: openMap(), botA: A, botB: B, maxTicks: 6 });
  assert.equal(vis[1], false, '隐身中不可见');
  assert.equal(vis[2], true, '开火后隐身应被打破');
});

test('眩晕：命中后敌人若干拍不能行动，冷却期内不可再用', () => {
  const map = mapFromAscii([
    '######',
    '#A.B.#',
    '######',
  ]);
  const readyLog = [];
  const A = (api) => {
    readyLog.push(api.ready('stun'));
    if (api.ready('stun')) return api.stun();
    return null;
  };
  const B = (api) => api.moveTo({ x: 4, y: 1 });
  const r = runMatch({ seed: 1, map, botA: A, botB: B, maxTicks: 12 });
  assert.ok(r.events.some((e) => e.type === 'stun_hit' && e.target === 1));
  assert.equal(readyLog[0], true);
  assert.equal(readyLog[1], false, '眩晕进入冷却');
  const movesB = r.events.filter((e) => e.type === 'move' && e.who === 1);
  assert.ok(movesB.length >= 1, '眩晕结束后应能行动');
  assert.equal(movesB[0].t, 8, '眩晕 8 拍内不能移动，第 8 拍恢复');
});

test('开火冷却：射击后 canFire=false，冷却结束恢复', () => {
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
  assert.equal(canLog[5], true, '冷却 5 拍后恢复');
  assert.equal(r.winner, 0);
  assert.equal(r.reason, 'kill');
});
