import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii } from '../src/engine/index.js';

const idle = () => null;

test('墙挡子弹：弹道被墙截断，无命中', () => {
  const map = mapFromAscii([
    '##########',
    '#A..#...B#',
    '##########',
  ]);
  const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 3 });
  const fires = r.events.filter((e) => e.type === 'fire');
  const ends = r.events.filter((e) => e.type === 'bullet_end');
  const hits = r.events.filter((e) => e.type === 'hit');
  assert.ok(fires.length >= 1, '应有开火事件');
  assert.ok(ends.length >= 1);
  assert.equal(ends[0].cause, 'wall');
  assert.deepEqual({ x: ends[0].x, y: ends[0].y }, { x: 4, y: 1 });
  assert.equal(hits.length, 0, '子弹被墙挡下，不应命中');
});

test('土堆挡子弹：弹道被土堆截断，无命中', () => {
  const map = mapFromAscii([
    '##########',
    '#A..D...B#',
    '##########',
  ]);
  const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 3 });
  const ends = r.events.filter((e) => e.type === 'bullet_end');
  assert.ok(ends.length >= 1);
  assert.equal(ends[0].cause, 'dirt');
  assert.equal(r.events.filter((e) => e.type === 'hit').length, 0);
});

test('土堆不挡坦克：可以走上土堆格', () => {
  const map = mapFromAscii([
    '#####',
    '#ADB#',
    '#####',
  ]);
  const A = (api) => api.moveTo({ x: 2, y: 1 });
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 2 });
  const moves = r.events.filter((e) => e.type === 'move' && e.who === 0);
  assert.ok(moves.length >= 1);
  assert.deepEqual({ x: moves[0].x, y: moves[0].y }, { x: 2, y: 1 });
});

test('草丛隐身：敌人在草丛且距离>1 ⇒ 不可见', () => {
  const map = mapFromAscii([
    '##########',
    '#A......b#',
    '##########',
  ]);
  const vis = [];
  const A = (api) => { vis.push(api.enemyVisible()); return null; };
  runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 5 });
  assert.ok(vis.length >= 3);
  assert.ok(vis.every((v) => v === false), '草丛中的敌人应不可见');
});

test('对照：同位置无草丛 ⇒ 可见', () => {
  const map = mapFromAscii([
    '##########',
    '#A......B#',
    '##########',
  ]);
  const vis = [];
  const A = (api) => { vis.push(api.enemyVisible()); return null; };
  runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 5 });
  assert.ok(vis.every((v) => v === true), '空地上的敌人应可见');
});

test('草丛贴脸可见：距离≤1 时草丛不再隐身', () => {
  const map = mapFromAscii([
    '####',
    '#Ab#',
    '####',
  ]);
  const vis = [];
  const A = (api) => { vis.push(api.enemyVisible()); return null; };
  runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 3 });
  assert.ok(vis.every((v) => v === true), '贴脸时草丛敌人应可见');
});
