import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii, RULES } from '../src/engine/index.js';

const idle = () => null;

// 9x9 空场（四周墙），零星星：专供缩圈测试
const openMap = () => mapFromAscii([
  '#########',
  '#A......#',
  '#.......#',
  '#.......#',
  '#.......#',
  '#.......#',
  '#.......#',
  '#......B#',
  '#########',
]);

test('RULES.zone 常量存在（start/every/dmg/dmgStep）', () => {
  assert.ok(RULES.zone, '应有 RULES.zone');
  for (const k of ['start', 'every', 'dmg', 'dmgStep']) {
    assert.equal(typeof RULES.zone[k], 'number', `zone.${k} 应为数值`);
  }
});

test('缩圈时刻表：t=start 起每 every 拍收一圈，安全区矩形逐级内收且有事件', () => {
  const r = runMatch({
    seed: 1, map: openMap(), botA: idle, botB: idle,
    rules: { zone: { start: 5, every: 3, dmg: 0, dmgStep: 0 } },
    maxTicks: 20,
  });
  const shrinks = r.events.filter((e) => e.type === 'zone_shrink');
  assert.ok(shrinks.length >= 3, `应有多次 zone_shrink，实际 ${shrinks.length}`);
  assert.deepEqual(shrinks.slice(0, 3).map((e) => e.t), [5, 8, 11], '收圈时刻应为 start + k*every');
  assert.deepEqual(
    shrinks.slice(0, 3).map((e) => e.ring), [1, 2, 3], 'ring 应逐级 +1');
  // 9x9：可走区 [1,7]，ring r 的安全区 [1+r, 7-r]
  for (const [i, s] of shrinks.slice(0, 3).entries()) {
    const r0 = i + 1;
    assert.deepEqual(
      { x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 },
      { x0: 1 + r0, y0: 1 + r0, x1: 7 - r0, y1: 7 - r0 },
      `第 ${r0} 圈安全区矩形错误`,
    );
  }
  // 收到中心 1 格封顶：9x9 最多 3 圈
  assert.ok(shrinks.every((s) => s.ring <= 3), '安全区最小收到中心 1 格，不再继续');
});

test('毒圈伤害：圈外每拍掉血、事件带 dmg/hp，且随圈数递增', () => {
  const r = runMatch({
    seed: 1, map: openMap(), botA: idle, botB: idle,
    rules: { zone: { start: 2, every: 4, dmg: 5, dmgStep: 1 } },
    maxTicks: 12,
  });
  const hits = r.events.filter((e) => e.type === 'zone_hit' && e.target === 0);
  assert.ok(hits.length >= 6, `A 在角落应持续吃毒圈伤害，实际 ${hits.length} 次`);
  assert.equal(hits[0].t, 2, '第一口毒应在收圈当拍结算');
  assert.equal(hits[0].dmg, 5, '第 1 圈伤害应为 dmg 基础值');
  const after2 = hits.find((e) => e.t >= 6);
  assert.equal(after2.dmg, 6, '第 2 圈起伤害应 +dmgStep');
  for (let i = 1; i < hits.length; i++) {
    assert.ok(hits[i].hp < hits[i - 1].hp, 'hp 应单调下降');
  }
});

test('毒圈致死：双闲置整局必出胜负（缩圈根治混时间），无 draw', () => {
  const r = runMatch({
    seed: 3, map: openMap(), botA: idle, botB: idle,
    rules: { zone: { start: 4, every: 4, dmg: 8, dmgStep: 2 } },
    maxTicks: 200,
  });
  assert.ok(r.events.some((e) => e.type === 'death'), '毒圈应能致死');
  assert.notEqual(r.winner, null, '任何对局都不允许平局');
  assert.ok(['kill', 'stars', 'hp', 'damage', 'center', 'coin'].includes(r.reason), `reason=${r.reason}`);
});

test('星星避圈：被圈吞没发 star_gone 并在安全区内重生', () => {
  const map = mapFromAscii([
    '#########',
    '#A*.....#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#......B#',
    '#########',
  ]);
  const r = runMatch({
    seed: 1, map, botA: idle, botB: idle,
    rules: { zone: { start: 3, every: 50, dmg: 0, dmgStep: 0 } },
    maxTicks: 60,
  });
  const gone = r.events.find((e) => e.type === 'star_gone');
  assert.ok(gone, '圈外星星应被吞没（star_gone）');
  assert.equal(gone.t, 3, '吞没应发生在收圈当拍');
  const spawn = r.events.find((e) => e.type === 'star_spawn' && e.t > gone.t);
  assert.ok(spawn, '吞没后应在圈内重生');
  assert.ok(spawn.x >= 2 && spawn.x <= 6 && spawn.y >= 2 && spawn.y <= 6, `重生点 (${spawn.x},${spawn.y}) 应在安全区内`);
});

test('传送避圈：落点在圈外时重定向进安全区', () => {
  let used = false;
  const meLog = [];
  const A = (api) => {
    meLog.push(api.me());
    if (!used && api.ready() && api.zone().ring >= 1) { used = true; return api.teleport({ x: 1, y: 1 }); }
    return null;
  };
  const r = runMatch({
    seed: 1, map: openMap(), botA: A, botB: idle, skillA: 'teleport',
    rules: { zone: { start: 2, every: 100, dmg: 0, dmgStep: 0 } },
    maxTicks: 8,
  });
  assert.ok(r.events.some((e) => e.type === 'skill' && e.name === 'teleport'), '应发生传送');
  const dest = meLog.at(-1);
  assert.ok(dest.x >= 2 && dest.x <= 6 && dest.y >= 2 && dest.y <= 6, `落点 (${dest.x},${dest.y}) 应被重定向进安全区`);
});

test('api.zone()：脚本可查安全区矩形与圈数', () => {
  const log = [];
  const A = (api) => { log.push(api.zone()); return null; };
  runMatch({
    seed: 1, map: openMap(), botA: A, botB: idle,
    rules: { zone: { start: 2, every: 100, dmg: 0, dmgStep: 0 } },
    maxTicks: 5,
  });
  assert.deepEqual(
    { ring: log[0].ring, x0: log[0].x0, x1: log[0].x1 },
    { ring: 0, x0: 1, x1: 7 },
    't0 应为全图安全',
  );
  const after = log.at(-1);
  assert.deepEqual(
    { ring: after.ring, x0: after.x0, y0: after.y0, x1: after.x1, y1: after.y1 },
    { ring: 1, x0: 2, y0: 2, x1: 6, y1: 6 },
    '收圈后 api.zone() 应反映新安全区',
  );
});

test('超时判定链：星数平→剩余 HP 高者胜（reason=hp）', () => {
  const map = mapFromAscii(['##########', '#A......B#', '##########']);
  let fired = false;
  const A = (api) => {
    if (!fired && api.canFire()) { fired = true; return api.fireAt(api.enemy()); }
    return null;
  };
  const r = runMatch({
    seed: 1, map, botA: A, botB: idle,
    rules: { zone: { start: 9999, every: 30, dmg: 5, dmgStep: 1 } },
    maxTicks: 30,
  });
  assert.equal(r.winner, 0, '打掉对方 20 血后超时应判 A 胜');
  assert.equal(r.reason, 'hp');
});

test('终局掷签：完全镜像对局也必出胜负（reason=coin，确定性）', () => {
  const map = () => mapFromAscii(['#######', '#A...B#', '#######']);
  const opts = {
    seed: 5, botA: idle, botB: idle,
    rules: { zone: { start: 9999, every: 30, dmg: 5, dmgStep: 1 } },
    maxTicks: 6,
  };
  const r1 = runMatch({ ...opts, map: map() });
  const r2 = runMatch({ ...opts, map: map() });
  assert.notEqual(r1.winner, null, '掷签兜底后不存在平局');
  assert.equal(r1.reason, 'coin');
  assert.equal(r1.winner, r2.winner, '同 seed 掷签结果必须一致');
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), '战报应逐字节一致');
});

test('确定性：含缩圈整局同 seed 战报逐字节一致', () => {
  const mk = () => openMap();
  const A = (api) => (api.enemyVisible() && api.canFire() ? api.fireAt(api.enemy()) : api.patrol());
  const B = (api) => api.patrol();
  const o = { seed: 9, botA: A, botB: B, rules: { zone: { start: 10, every: 8, dmg: 5, dmgStep: 1 } }, maxTicks: 150 };
  const r1 = runMatch({ ...o, map: mk() });
  const r2 = runMatch({ ...o, map: mk() });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});
