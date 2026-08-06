// 飞行子弹：速度 2 格/tick、单发在飞、tick 内结算顺序（先推进子弹再执行动作）、事件字段、子弹视锥。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii } from '../src/engine/index.js';

const idle = () => null;

test('飞行速度：距离 5 的目标在开火后第 3 拍被命中（2 格/tick）', () => {
  const map = mapFromAscii([
    '########',
    '#A....B#',
    '########',
  ]);
  let fired = false;
  const A = (api) => {
    if (!fired && api.canFire()) { fired = true; return api.fireAt(api.enemy()); }
    return null;
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 10 });
  const fire = r.events.find((e) => e.type === 'fire');
  const hit = r.events.find((e) => e.type === 'hit');
  const end = r.events.find((e) => e.type === 'bullet_end');
  assert.deepEqual({ t: fire.t, x: fire.x, y: fire.y, dx: fire.dx, dy: fire.dy }, { t: 0, x: 1, y: 1, dx: 1, dy: 0 }, 'fire 事件带出膛口位置与方向');
  assert.equal(hit.t, 3, '距离 5、速度 2/tick ⇒ 第 3 拍命中');
  assert.deepEqual({ x: hit.x, y: hit.y }, { x: 6, y: 1 });
  assert.equal(end.reason, 'hit');
  assert.equal(end.t, 3);
});

test('结算顺序锁定：本拍先推进已有子弹，再执行双方动作', () => {
  const map = mapFromAscii([
    '######',
    '#A.B.#',
    '######',
  ]);
  let fired = false;
  const A = (api) => {
    if (!fired && api.canFire()) { fired = true; return api.fireAt(api.enemy()); }
    return null;
  };
  // B 从 t=1 起想逃离：若动作先于子弹结算，B 会在 t=1 逃到 (4,1) 免伤
  const B = (api) => (api.tick() >= 1 ? api.moveTo({ x: 4, y: 1 }) : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: B, maxTicks: 4 });
  const hit = r.events.find((e) => e.type === 'hit');
  assert.ok(hit, '应命中');
  assert.equal(hit.t, 1, '子弹先于动作结算：t=1 命中原地的 B');
  assert.deepEqual({ x: hit.x, y: hit.y }, { x: 3, y: 1 });
  const moveB = r.events.find((e) => e.type === 'move' && e.who === 1 && e.t === 1);
  assert.ok(moveB, 'B 被命中后同拍仍执行了移动（动作在子弹之后）');
  assert.equal(moveB.x, 4);
});

test('单发在飞：在飞期间 canFire=false、bulletInFlight=true，再 fire 为 no-op', () => {
  const map = mapFromAscii([
    '###############',
    '#A...........B#',
    '###############',
  ]);
  const log = [];
  const A = (api) => {
    log.push([api.canFire(), api.me().bulletInFlight]);
    return api.fireAt(api.enemy()); // 每拍都尝试开火
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 8 });
  const fires = r.events.filter((e) => e.type === 'fire').map((e) => e.t);
  assert.deepEqual(fires, [0, 6], '距离 12 飞 6 拍：冷却 5 拍已过仍要等子弹终结');
  assert.deepEqual(log[0], [true, false]);
  for (let t = 1; t <= 5; t++) assert.deepEqual(log[t], [false, true], `t=${t} 在飞期间不可再开火`);
  assert.deepEqual(log[6], [true, false], '子弹终结后恢复');
});

test('子弹不伤及发射者：超载补射后同向前进走进自己弹道不自伤', () => {
  const map = mapFromAscii([
    '############',
    '#A........B#',
    '############',
  ]);
  const A = (api) => {
    if (api.tick() === 0) return api.useSkill();
    if (api.canFire()) return api.fireAt(api.enemy());
    return api.moveTo({ x: 9, y: 1 }); // 在飞期间朝同向追进，走进自己补射弹道
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, skillA: 'overload', maxTicks: 8 });
  assert.ok(!r.events.some((e) => e.type === 'hit' && e.target === 0), '自己的子弹不应命中自己');
  assert.ok(r.events.some((e) => e.type === 'hit' && e.target === 1), '子弹穿过自身后仍能命中敌人');
});

test('bullet_end reason=out：无边界地图子弹出界', () => {
  const map = mapFromAscii([
    'A....',
    '.....',
    '....B',
  ]);
  let fired = false;
  const A = (api) => {
    if (!fired && api.canFire()) { fired = true; return api.fireAt(api.enemy()); }
    return null;
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 5 });
  const end = r.events.find((e) => e.type === 'bullet_end');
  assert.deepEqual({ t: end.t, x: end.x, y: end.y, reason: end.reason }, { t: 3, x: 5, y: 0, reason: 'out' });
});

test('myBullet：自己的子弹状态始终可查', () => {
  const map = mapFromAscii([
    '########',
    '#A....B#',
    '########',
  ]);
  const log = [];
  let fired = false;
  const A = (api) => {
    log.push(api.myBullet());
    if (!fired && api.canFire()) { fired = true; return api.fireAt(api.enemy()); }
    return null;
  };
  runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 6 });
  assert.equal(log[0], null, '未开火时无子弹');
  assert.deepEqual(log[1], { x: 3, y: 1, dx: 1, dy: 0 }, 't=1 子弹已飞 2 格');
  assert.equal(log[4], null, '命中终结后为空');
});

test('子弹视锥：正前方 90° 锥内的敌方子弹可见', () => {
  const map = mapFromAscii([
    '########',
    '#A....B#',
    '########',
  ]);
  const log = [];
  const A = (api) => { log.push(api.enemyBullet()); return null; };
  const B = (api) => (api.tick() === 0 ? api.fireAt(api.enemy()) : null);
  runMatch({ seed: 1, map, botA: A, botB: B, maxTicks: 4 });
  assert.deepEqual(log[1], { x: 4, y: 1, dx: -1, dy: 0 }, 'A 朝右，迎面子弹在视锥内');
});

test('子弹视锥：锥外（侧后方）的敌方子弹不可见', () => {
  const map = mapFromAscii([
    '#######',
    '#A...B#',
    '#.....#',
    '#######',
  ]);
  const log = [];
  const A = (api) => {
    log.push(api.enemyBullet());
    if (api.tick() === 0) return api.moveTo({ x: 1, y: 2 }); // 下移一步 ⇒ 炮口朝下
    return null;
  };
  const B = (api) => (api.tick() === 0 ? api.fireAt(api.enemy()) : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: B, maxTicks: 4 });
  assert.ok(r.events.some((e) => e.type === 'bullet_end'), '子弹确实存在并终结');
  assert.equal(log[1], null, 'A 朝下，行 1 的子弹在锥外');
  assert.equal(log[2], null);
});
