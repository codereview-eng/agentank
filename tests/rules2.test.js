// 规则修正：土堆两发摧毁、单星（同场≤1、被吃后 15 tick 种子 RNG 重生）、带技能的确定性重放。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii } from '../src/engine/index.js';
import { bots } from '../bots/index.js';

const idle = () => null;

test('土堆可摧毁：子弹命中 2 次销毁，之后弹道可通行', () => {
  const map = mapFromAscii([
    '######',
    '#AD.B#',
    '######',
  ]);
  const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 13 });
  const mh = r.events.filter((e) => e.type === 'mound_hit');
  assert.deepEqual(mh.map((e) => ({ t: e.t, hp: e.hp })), [{ t: 1, hp: 1 }, { t: 6, hp: 0 }]);
  const md = r.events.find((e) => e.type === 'mound_destroyed');
  assert.deepEqual({ t: md.t, x: md.x, y: md.y }, { t: 6, x: 2, y: 1 });
  const ends = r.events.filter((e) => e.type === 'bullet_end');
  assert.deepEqual(ends.slice(0, 2).map((e) => e.reason), ['mound', 'mound']);
  const hit = r.events.find((e) => e.type === 'hit');
  assert.deepEqual({ t: hit.t, target: hit.target }, { t: 12, target: 1 }, '第三发穿过原土堆格命中 B');
});

test('单星：初始截断为 1 颗，被吃后 15 tick 在种子 RNG 合法格重生，同场永不超过 1 颗', () => {
  const map = mapFromAscii([
    '#######',
    '#A*.*B#',
    '#######',
  ]);
  const starLog = [];
  const A = (api) => {
    starLog.push(api.nearestStar());
    const s = api.nearestStar();
    return s ? api.moveTo(s) : null;
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 18 });
  const eat = r.events.find((e) => e.type === 'star');
  assert.equal(eat.t, 0, 't=0 吃到唯一的星');
  assert.equal(starLog[1], null, '地图声明的第二颗星被截断，场上无星');
  assert.equal(starLog[5], null);
  const spawns = r.events.filter((e) => e.type === 'star_spawn');
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].t, 15, '被吃后 15 tick 重生');
  assert.ok(starLog[16], '重生后可再次索敌');
  // 事件回放校验同场星数 ≤1
  let field = 1;
  for (const e of r.events) {
    if (e.type === 'star') field--;
    if (e.type === 'star_spawn') field++;
    assert.ok(field >= 0 && field <= 1, '同场星数必须始终 ≤1');
  }
});

test('确定性：同 seed+同脚本+同技能 ⇒ 战报逐字节相同；技能不同 ⇒ 战报不同', () => {
  const base = { seed: 5, botA: bots.camper, botB: bots.brawler, skillA: 'freeze', skillB: 'overload' };
  const r1 = runMatch(base);
  const r2 = runMatch(base);
  assert.equal(JSON.stringify(r1.events), JSON.stringify(r2.events));
  const r3 = runMatch({ ...base, skillB: 'shield' });
  assert.notEqual(JSON.stringify(r1.events), JSON.stringify(r3.events));
});
