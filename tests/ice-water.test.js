import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii, isWalkable, tileAt, TILE } from '../src/engine/index.js';

const idle = () => null;

test('图例：~=水域 ==冰面，水域挡车、冰面可走', () => {
  const map = mapFromAscii(['#####', '#A~B#', '#.=.#', '#####']);
  assert.equal(tileAt(map, 2, 1), TILE.WATER);
  assert.equal(tileAt(map, 2, 2), TILE.ICE);
  assert.equal(isWalkable(map, 2, 1), false, '水域应不可通行');
  assert.equal(isWalkable(map, 2, 2), true, '冰面应可通行');
});

test('冰面滑行：踏上冰面沿原方向续滑，直到离开冰面才停', () => {
  // A 在 (1,1)，右侧两格冰，再右空地：走 1 步应一路滑到 (4,1)
  const map = mapFromAscii(['########', '#A==..B#', '#......#', '########']);
  const meLog = [];
  let moved = false;
  const A = (api) => {
    meLog.push(api.me());
    if (!moved) { moved = true; return api.moveTo({ x: 2, y: 1 }); }
    return null;
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 3 });
  assert.equal(meLog[1].x, 4, `1 拍后应滑到 x=4，实际 x=${meLog[1].x}`);
  const slides = r.events.filter((e) => e.type === 'slide' && e.who === 0);
  assert.equal(slides.length, 2, `应有 2 条 slide 事件，实际 ${slides.length}`);
  assert.equal(slides.at(-1).x, 4, '最后一滑应落在 (4,1)');
});

test('冰面滑行：前方是墙则停在冰上；前方是敌人则停在敌前', () => {
  const wallMap = mapFromAscii(['#####', '#A=.#', '#..B#', '#####']);
  // 目标 (2,1) 是冰，滑向 (3,1) 空地，再往前 (4,1) 是墙 → 停在 (3,1)
  const A1 = (api) => api.moveTo({ x: 2, y: 1 });
  const meLog1 = [];
  runMatch({ seed: 1, map: wallMap, botA: (api) => { meLog1.push(api.me()); return A1(api); }, botB: idle, maxTicks: 2 });
  assert.equal(meLog1[1].x, 3, `撞墙前应停下，实际 x=${meLog1[1].x}`);

  const enemyMap = mapFromAscii(['######', '#A==B#', '#....#', '######']);
  const meLog2 = [];
  runMatch({ seed: 1, map: enemyMap, botA: (api) => { meLog2.push(api.me()); return api.moveTo({ x: 2, y: 1 }); }, botB: idle, maxTicks: 2 });
  assert.equal(meLog2[1].x, 3, `滑行不得撞入敌人格，应停在 x=3，实际 x=${meLog2[1].x}`);
});

test('冰面滑行途中吃星', () => {
  const map = mapFromAscii(['########', '#A=*=.B#', '#......#', '########']);
  const A = (api) => api.moveTo({ x: 2, y: 1 });
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 3 });
  assert.ok(r.events.some((e) => e.type === 'star' && e.who === 0), '滑行经过星星应吃到');
});

test('水域挡车不挡弹：坦克绕不过去打得过去', () => {
  // 中间一整列水，A/B 完全隔开：子弹能飞过水命中
  const map = mapFromAscii(['#######', '#A.~.B#', '#..~..#', '#######']);
  const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 6 });
  assert.ok(r.events.some((e) => e.type === 'hit' && e.who === 0), '子弹应飞越水域命中');
  // 而移动指令无法跨水：全程 A 不应出现在水格或对岸
  const mv = (api) => api.moveTo({ x: 5, y: 1 });
  const meLog = [];
  runMatch({ seed: 1, map: mapFromAscii(['#######', '#A.~.B#', '#..~..#', '#######']), botA: (api) => { meLog.push(api.me()); return mv(api); }, botB: idle, maxTicks: 10 });
  assert.ok(meLog.every((m) => m.x <= 2), '水域完全隔断时坦克不应过河');
});

test('传送不能落在水上：非法落点重定向到最近合法格', () => {
  const map = mapFromAscii(['#######', '#A...B#', '#.~~..#', '#######']);
  let used = false;
  const meLog = [];
  const A = (api) => {
    meLog.push(api.me());
    if (!used && api.ready()) { used = true; return api.teleport({ x: 2, y: 2 }); }
    return null;
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, skillA: 'teleport', maxTicks: 4 });
  assert.ok(r.events.some((e) => e.type === 'skill' && e.name === 'teleport'), '应发生传送');
  const dest = meLog[1];
  assert.notEqual(tileAt(map, dest.x, dest.y), TILE.WATER, `落点 (${dest.x},${dest.y}) 不应是水域`);
});

test('确定性：含冰/水地图同 seed 战报逐字节一致', () => {
  const mk = () => mapFromAscii(['#########', '#A.=~.g.#', '#..=~...#', '#..*..B.#', '#########']);
  const A = (api) => (api.enemyVisible() && api.canFire() ? api.fireAt(api.enemy()) : api.patrol());
  const B = (api) => { const s = api.nearestStar(); return s ? api.moveTo(s) : api.patrol(); };
  const r1 = runMatch({ seed: 9, map: mk(), botA: A, botB: B, maxTicks: 120 });
  const r2 = runMatch({ seed: 9, map: mk(), botA: A, botB: B, maxTicks: 120 });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});
