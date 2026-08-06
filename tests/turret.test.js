// 炮口四向硬规则：只能沿水平/垂直开炮；炮口未对准需先转向一拍。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii } from '../src/engine/index.js';

const idle = () => null;

test('斜向目标：先出 turn 事件转炮口，下一拍才 fire', () => {
  // B 在 A 的右下方（dx=5,dy=2，主轴为水平→，但 A 初始即朝右）；
  // 为逼出转向，改用垂直主轴：B 在 A 正下偏右（dx=1,dy=3，主轴为垂直↓）。
  const map = mapFromAscii([
    '#######',
    '#A....#',
    '#.....#',
    '#.....#',
    '#.B...#',
    '#######',
  ]);
  const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 4 });
  const evs = r.events.filter((e) => (e.type === 'turn' || e.type === 'fire') && e.who === 0);
  assert.ok(evs.length >= 2, '应先转向再开火');
  assert.equal(evs[0].type, 'turn');
  assert.deepEqual({ dx: evs[0].dx, dy: evs[0].dy }, { dx: 0, dy: 1 }, '主轴为垂直，应转炮口↓');
  assert.equal(evs[1].type, 'fire');
  assert.deepEqual({ dx: evs[1].dx, dy: evs[1].dy }, { dx: 0, dy: 1 });
});

test('弹道只走直线：fire 起点与 bullet_end 终点必共行或共列', () => {
  const map = mapFromAscii([
    '#########',
    '#A......#',
    '#....B..#',
    '#.......#',
    '#########',
  ]);
  const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const B = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({ seed: 7, map, botA: A, botB: B, maxTicks: 30 });
  // 子弹逐 tick 飞行后事件不再相邻，按所属坦克分队配对
  for (const who of [0, 1]) {
    const fires = r.events.filter((e) => e.type === 'fire' && e.who === who);
    const ends = r.events.filter((e) => e.type === 'bullet_end' && e.who === who);
    assert.ok(fires.length >= 1, '应有开火');
    assert.equal(fires.length, ends.length, '每次开火恰有一次弹道终结');
    for (let k = 0; k < fires.length; k++) {
      const f = fires[k];
      const b = ends[k];
      assert.ok(f.x === b.x || f.y === b.y, `弹道必须水平或垂直：fire(${f.x},${f.y}) → end(${b.x},${b.y})`);
      assert.ok(Math.abs(f.dx) + Math.abs(f.dy) === 1, 'fire 事件必须带四向单位方向');
    }
  }
});

test('炮口已对准时直接开火，不多耗转向拍', () => {
  const map = mapFromAscii([
    '##########',
    '#A......B#',
    '##########',
  ]);
  const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 2 });
  const first = r.events.find((e) => (e.type === 'turn' || e.type === 'fire') && e.who === 0);
  assert.equal(first.type, 'fire', 'P1 初始朝右，正右方敌人应第一拍直接开火');
});

test('移动会带动炮口：向下走一步后，右方敌人需先转向才能打', () => {
  const map = mapFromAscii([
    '#######',
    '#A...B#',
    '#.....#',
    '#######',
  ]);
  let st = 0;
  const A = (api) => {
    st++;
    if (st === 1) return api.moveTo({ x: api.me().x, y: api.me().y + 1 }); // 向下走，炮口变↓
    return api.fireAt({ x: api.me().x + 3, y: api.me().y }); // 打正右方目标
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 5 });
  const seq = r.events.filter((e) => (e.type === 'turn' || e.type === 'fire') && e.who === 0).map((e) => e.type);
  assert.deepEqual(seq.slice(0, 2), ['turn', 'fire'], '移动改变朝向后需先转回→再开火');
});

test('me().facing 暴露炮口方向且随转向更新', () => {
  const map = mapFromAscii([
    '#######',
    '#A....#',
    '#.....#',
    '#.....#',
    '#.B...#',
    '#######',
  ]);
  const seen = [];
  const A = (api) => {
    seen.push(api.me().facing);
    return api.fireAt(api.enemy());
  };
  runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 3 });
  assert.deepEqual(seen[0], { dx: 1, dy: 0 }, '初始朝右');
  assert.deepEqual(seen[1], { dx: 0, dy: 1 }, '转向后朝下');
});
