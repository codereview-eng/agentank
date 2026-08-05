import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii } from '../src/engine/index.js';

const idle = () => null;

test('吃星计数：走上星星格即拾取并计数', () => {
  const map = mapFromAscii([
    '#####',
    '#A*.#',
    '#..B#',
    '#####',
  ]);
  const A = (api) => { const s = api.nearestStar(); return s ? api.moveTo(s) : null; };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 6 });
  const starEvents = r.events.filter((e) => e.type === 'star');
  assert.equal(starEvents.length, 1);
  assert.equal(starEvents[0].who, 0);
  assert.equal(starEvents[0].total, 1);
  assert.deepEqual(r.stars, [1, 0]);
});

test('超时判定：无击杀时星多者胜（reason=stars）', () => {
  const map = mapFromAscii([
    '#####',
    '#A*.#',
    '#..B#',
    '#####',
  ]);
  const A = (api) => { const s = api.nearestStar(); return s ? api.moveTo(s) : null; };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 6 });
  assert.equal(r.winner, 0);
  assert.equal(r.reason, 'stars');
  const end = r.events.at(-1);
  assert.equal(end.type, 'end');
  assert.equal(end.winner, 0);
  assert.equal(end.reason, 'stars');
});

test('超时判定：无击杀且星数相同 ⇒ 平局', () => {
  const map = mapFromAscii([
    '#####',
    '#A.B#',
    '#####',
  ]);
  const r = runMatch({ seed: 1, map, botA: idle, botB: idle, maxTicks: 10 });
  assert.equal(r.winner, null);
  assert.equal(r.reason, 'draw');
});

test('击杀即胜（reason=kill），早于超时', () => {
  const map = mapFromAscii([
    '########',
    '#A....B#',
    '########',
  ]);
  const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: idle });
  assert.equal(r.winner, 0);
  assert.equal(r.reason, 'kill');
  assert.ok(r.ticks < 900);
  assert.ok(r.events.some((e) => e.type === 'death' && e.who === 1));
});
