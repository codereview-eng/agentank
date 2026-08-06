// 炸弹系统：原地放置、10 tick 后爆炸、十字 2 格、伤所有坦克含自己、土堆挡冲击波且被炸毁、冷却与同场 1 枚、草丛可见。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii } from '../src/engine/index.js';

const idle = () => null;

test('放置+定时爆炸：t=0 放置，t=10 爆炸，十字 2 格伤到自己与敌人', () => {
  const map = mapFromAscii([
    '#######',
    '#A.B..#',
    '#######',
  ]);
  const A = (api) => (api.tick() === 0 ? api.throwBomb() : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 12 });
  const place = r.events.find((e) => e.type === 'bomb_place');
  assert.deepEqual({ t: place.t, who: place.who, x: place.x, y: place.y }, { t: 0, who: 0, x: 1, y: 1 });
  const boom = r.events.find((e) => e.type === 'bomb_explode');
  assert.equal(boom.t, 10, '10 tick 后爆炸');
  assert.deepEqual({ x: boom.x, y: boom.y }, { x: 1, y: 1 });
  assert.ok(boom.cells.some((c) => c.x === 3 && c.y === 1), '十字右 2 格在范围内');
  assert.deepEqual(boom.hits, [{ who: 0, dmg: 45 }, { who: 1, dmg: 45 }], '伤所有坦克含自己');
  const end = r.events.at(-1);
  assert.deepEqual(end.hp, [55, 55]);
});

test('土堆挡冲击波且被炸一击摧毁，摧毁后子弹可通行', () => {
  const map = mapFromAscii([
    '#######',
    '#AD.B.#',
    '#######',
  ]);
  const A = (api) => {
    if (api.tick() === 0) return api.throwBomb();
    if (api.tick() > 10 && api.canFire()) return api.fireAt(api.enemy());
    return null;
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 15 });
  const boom = r.events.find((e) => e.type === 'bomb_explode');
  assert.equal(boom.t, 10);
  assert.ok(!boom.cells.some((c) => c.x === 3 && c.y === 1), '土堆后方 (3,1) 不受冲击波');
  assert.deepEqual(boom.hits, [{ who: 0, dmg: 45 }], '只有自己受伤');
  const destroyed = r.events.find((e) => e.type === 'mound_destroyed');
  assert.deepEqual({ t: destroyed.t, x: destroyed.x, y: destroyed.y }, { t: 10, x: 2, y: 1 }, '炸弹一击摧毁土堆');
  const hit = r.events.find((e) => e.type === 'hit');
  assert.ok(hit && hit.target === 1, '土堆摧毁后子弹穿过原土堆格命中 B');
});

test('冷却 30 tick + 同时最多 1 枚自己的炸弹', () => {
  const map = mapFromAscii([
    '#######',
    '#A.B..#',
    '#######',
  ]);
  const readyLog = [];
  const A = (api) => { readyLog.push(api.ready('bomb')); return api.throwBomb(); };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 32 });
  const places = r.events.filter((e) => e.type === 'bomb_place').map((e) => e.t);
  assert.deepEqual(places, [0, 30], '每拍都尝试放置，只在 t=0 与 t=30 成功');
  assert.equal(readyLog[0], true);
  assert.equal(readyLog[1], false);
  assert.equal(readyLog[29], false);
  assert.equal(readyLog[30], true);
});

test('草丛中的炸弹对双方可见（bombs() 全量返回）', () => {
  const map = mapFromAscii([
    '#######',
    '#a...B#',
    '#######',
  ]);
  const log = [];
  const A = (api) => (api.tick() === 0 ? api.throwBomb() : null);
  const B = (api) => { log.push(api.bombs()); return null; };
  runMatch({ seed: 1, map, botA: A, botB: B, maxTicks: 3 });
  assert.deepEqual(log[1], [{ x: 1, y: 1, fuse: 9, mine: false }], '草丛炸弹对敌方可见且带引信读数');
});
