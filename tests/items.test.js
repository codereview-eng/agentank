import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii, RULES } from '../src/engine/index.js';

const idle = () => null;

// 9x9 空场（四周墙）：专供道具测试；缩圈推到 9999 避免干扰
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
const noZone = { zone: { start: 9999, every: 30, dmg: 0, dmgStep: 0 } };

test('RULES.items 常量存在（start/every/max + kinds 表 + 各道具数值）', () => {
  assert.ok(RULES.items, '应有 RULES.items');
  for (const k of ['start', 'every', 'max']) {
    assert.equal(typeof RULES.items[k], 'number', `items.${k} 应为数值`);
  }
  assert.ok(Array.isArray(RULES.items.kinds) && RULES.items.kinds.length === 6, 'kinds 应为 6 种道具');
  for (const k of ['medkit', 'rapid', 'pierce', 'helmet', 'clock', 'boots']) {
    assert.ok(RULES.items.kinds.includes(k), `kinds 应含 ${k}`);
  }
  assert.equal(typeof RULES.items.medkit.heal, 'number');
  assert.equal(typeof RULES.items.rapid.shots, 'number');
  assert.equal(typeof RULES.items.pierce.shots, 'number');
  assert.equal(typeof RULES.items.pierce.bonus, 'number');
  assert.equal(typeof RULES.items.clock.dur, 'number');
  assert.equal(typeof RULES.items.boots.dur, 'number');
});

test('刷新时刻表：t=start 首刷、每 every 再刷、场上封顶 max，落点合法', () => {
  const r = runMatch({
    seed: 1, map: openMap(), botA: idle, botB: idle,
    rules: { ...noZone, items: { start: 3, every: 4, max: 2 } },
    maxTicks: 30,
  });
  const spawns = r.events.filter((e) => e.type === 'item_spawn');
  assert.ok(spawns.length >= 2, `应有多次 item_spawn，实际 ${spawns.length}`);
  assert.equal(spawns[0].t, 3, '首刷应在 t=start');
  assert.equal(spawns[1].t, 7, '第二刷应在 start+every');
  // 双方闲置无人拾取：场上道具数封顶 max=2，不再继续刷
  assert.equal(spawns.length, 2, '道具数到 max 后不应再刷');
  for (const s of spawns) {
    assert.ok(['medkit', 'rapid', 'pierce', 'helmet', 'clock', 'boots'].includes(s.kind), `kind=${s.kind}`);
    assert.ok(s.x >= 1 && s.x <= 7 && s.y >= 1 && s.y <= 7, '落点应在场内可走区');
  }
});

test('api.items()/nearestItem() 可查；压过道具产生 item_pick 并从场上移除', () => {
  const itemLog = [];
  const A = (api) => {
    itemLog.push(api.items());
    const it = api.nearestItem();
    return it ? api.moveTo(it) : null;
  };
  const r = runMatch({
    seed: 2, map: openMap(), botA: A, botB: idle,
    rules: { ...noZone, items: { start: 2, every: 50, max: 1, kinds: ['medkit'] } },
    maxTicks: 40,
  });
  assert.ok(itemLog[0].length === 0, 't0 场上应无道具');
  const seen = itemLog.find((l) => l.length > 0);
  assert.ok(seen, '刷新后 api.items() 应可查');
  assert.ok(typeof seen[0].x === 'number' && seen[0].kind === 'medkit', 'items() 应带 {x,y,kind}');
  const pick = r.events.find((e) => e.type === 'item_pick' && e.who === 0);
  assert.ok(pick, '压过道具应产生 item_pick');
  assert.equal(pick.kind, 'medkit');
  assert.ok(itemLog.at(-1).length === 0 || itemLog.at(-1)[0].x !== pick.x || itemLog.at(-1)[0].y !== pick.y, '拾取后道具应移除');
});

test('急救包：受伤后拾取回血 +heal，且不超过 HP 上限', () => {
  // A 在 (1,1)，道具 kinds 锁定 medkit；先让 B 打 A 一发（-20），再去捡包
  const map = mapFromAscii(['##########', '#A......B#', '#........#', '##########']);
  const hpLog = [];
  const A = (api) => {
    hpLog.push(api.me().hp);
    const it = api.nearestItem();
    return it ? api.moveTo(it) : null;
  };
  let fired = false;
  const B = (api) => {
    if (!fired && api.canFire()) { fired = true; return api.fireAt(api.enemy()); }
    return null;
  };
  const r = runMatch({
    seed: 3, map, botA: A, botB: B,
    rules: { ...noZone, items: { start: 8, every: 50, max: 1, kinds: ['medkit'] } },
    maxTicks: 60,
  });
  const hit = r.events.find((e) => e.type === 'hit' && e.target === 0);
  assert.ok(hit, 'A 应先被打掉一发');
  const pick = r.events.find((e) => e.type === 'item_pick' && e.who === 0 && e.kind === 'medkit');
  assert.ok(pick, 'A 应捡到急救包');
  assert.equal(pick.hp, Math.min(RULES.hp, hit.hp + RULES.items.medkit.heal), '回血应 +heal 且封顶');
  assert.ok(hpLog.at(-1) > hit.hp, '拾取后 me().hp 应回升');
});

test('头盔：拾取后挡下一次子弹（shield_block），护盾状态可查', () => {
  const map = mapFromAscii(['##########', '#A......B#', '##########']);
  const meLog = [];
  const A = (api) => { meLog.push(api.me().shielded); return null; };
  const B = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({
    seed: 1, map, botA: A, botB: B,
    rules: { ...noZone, items: { start: 0, every: 50, max: 1, kinds: ['helmet'], forceAt: { x: 1, y: 1 } } },
    maxTicks: 20,
  });
  const pick = r.events.find((e) => e.type === 'item_pick' && e.who === 0 && e.kind === 'helmet');
  assert.ok(pick, 'A 原地即有头盔（forceAt 定点投放）应拾取');
  const block = r.events.find((e) => e.type === 'shield_block' && e.who === 0);
  assert.ok(block, '头盔应挡下第一发子弹');
  assert.ok(meLog.some((s) => s === true), '护盾期间 me().shielded 应为 true');
  const firstHit = r.events.find((e) => e.type === 'hit' && e.target === 0);
  assert.ok(!firstHit || firstHit.t > block.t, '第一次真实掉血应在 shield_block 之后');
});

test('时钟：拾取后冻结敌人 dur 拍（敌人动作全部作废）', () => {
  const map = mapFromAscii(['##########', '#A.......#', '#.......B#', '##########']);
  const B = (api) => api.moveTo({ x: 1, y: 2 });
  const r = runMatch({
    seed: 1, map, botA: idle, botB: B,
    rules: { ...noZone, items: { start: 2, every: 50, max: 1, kinds: ['clock'], forceAt: { x: 1, y: 1 } } },
    maxTicks: 20,
  });
  const pick = r.events.find((e) => e.type === 'item_pick' && e.who === 0 && e.kind === 'clock');
  assert.ok(pick, 'A 应拾取时钟');
  const fh = r.events.find((e) => e.type === 'freeze_hit' && e.target === 1 && e.source === 'clock');
  assert.ok(fh && fh.t === pick.t, '拾取当拍应冻结敌人（freeze_hit source=clock）');
  assert.equal(fh.duration, RULES.items.clock.dur);
  const movesB = r.events.filter((e) => e.type === 'move' && e.who === 1 && e.t > pick.t);
  assert.ok(!movesB.length || movesB[0].t >= pick.t + RULES.items.clock.dur, '冻结期间 B 不应移动');
});

test('疾行靴：拾取后移动每拍 2 格（持续 dur 拍）', () => {
  const map = mapFromAscii(['############', '#A.........#', '#.........B#', '############']);
  const meLog = [];
  const A = (api) => { meLog.push(api.me()); return api.moveTo({ x: 10, y: 1 }); };
  const r = runMatch({
    seed: 1, map, botA: A, botB: idle,
    rules: { ...noZone, items: { start: 0, every: 50, max: 1, kinds: ['boots'], forceAt: { x: 1, y: 1 } } },
    maxTicks: 6,
  });
  const pick = r.events.find((e) => e.type === 'item_pick' && e.who === 0 && e.kind === 'boots');
  assert.ok(pick, 'A 原地应拾取疾行靴');
  assert.ok(meLog.some((m) => m.boosted === true), 'me().boosted 应为 true');
  // 拾取发生在 t=0 决策前，t=0 起每拍应走 2 格
  const later = meLog[2];
  assert.ok(later.x - 1 >= 3, `2 拍后应至少前进 4 格附近（实际 ${later.x - 1}）`);
});

test('双发弹：拾取后接下来 shots 次开火自动 2 连发', () => {
  const map = mapFromAscii(['##############', '#A..........B#', '##############']);
  const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({
    seed: 1, map, botA: A, botB: idle,
    rules: { ...noZone, items: { start: 0, every: 100, max: 1, kinds: ['rapid'], forceAt: { x: 1, y: 1 } } },
    maxTicks: 40,
  });
  const pick = r.events.find((e) => e.type === 'item_pick' && e.who === 0 && e.kind === 'rapid');
  assert.ok(pick, '应拾取双发弹');
  const fires = r.events.filter((e) => e.type === 'fire' && e.who === 0);
  assert.ok(fires.length >= 4, `双发生效后 fire 事件应成对出现，实际 ${fires.length}`);
  // 前两发应间隔 1 tick（主射 + 自动补射）
  assert.equal(fires[1].t - fires[0].t, 1, '第一组双发应间隔 1 拍');
});

test('穿甲弹：子弹一击摧毁土堆且伤害 +bonus', () => {
  const map = mapFromAscii(['##########', '#A..D...B#', '##########']);
  const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({
    seed: 1, map, botA: A, botB: idle,
    rules: { ...noZone, items: { start: 0, every: 100, max: 1, kinds: ['pierce'], forceAt: { x: 1, y: 1 } } },
    maxTicks: 60,
  });
  const pick = r.events.find((e) => e.type === 'item_pick' && e.who === 0 && e.kind === 'pierce');
  assert.ok(pick, '应拾取穿甲弹');
  const destroyed = r.events.find((e) => e.type === 'mound_destroyed');
  const moundHits = r.events.filter((e) => e.type === 'mound_hit' && e.t <= destroyed.t);
  assert.equal(moundHits.length, 1, `穿甲弹应一击摧毁土堆（命中 ${moundHits.length} 次）`);
  const hit = r.events.find((e) => e.type === 'hit' && e.who === 0);
  assert.ok(hit, '摧毁土堆后应命中敌人');
  assert.equal(hit.dmg, RULES.damage + RULES.items.pierce.bonus, '穿甲弹伤害应 +bonus');
});

test('缩圈吞没圈外道具（item_gone）', () => {
  const r = runMatch({
    seed: 1, map: openMap(), botA: idle, botB: idle,
    rules: {
      zone: { start: 6, every: 100, dmg: 0, dmgStep: 0 },
      items: { start: 2, every: 100, max: 1, kinds: ['medkit'], forceAt: { x: 1, y: 4 } },
    },
    maxTicks: 20,
  });
  const spawn = r.events.find((e) => e.type === 'item_spawn');
  assert.ok(spawn && spawn.x === 1 && spawn.y === 4, '道具应定点投放在圈边');
  const gone = r.events.find((e) => e.type === 'item_gone');
  assert.ok(gone, '收圈后圈外道具应被吞没');
  assert.equal(gone.t, 6, '吞没应发生在收圈当拍');
  assert.equal(gone.kind, 'medkit');
});

test('刷新落点避让：不落在星星/坦克/道具占位（forceAt 非法时重定向）', () => {
  // forceAt 指向 A 车位 → 应重定向到最近合法格而不是叠在坦克上
  const r = runMatch({
    seed: 4, map: openMap(), botA: idle, botB: idle,
    rules: { ...noZone, items: { start: 2, every: 100, max: 1, kinds: ['helmet'], forceAt: { x: 0, y: 0 } } },
    maxTicks: 10,
  });
  const spawn = r.events.find((e) => e.type === 'item_spawn');
  assert.ok(spawn, '应有 item_spawn');
  assert.ok(spawn.x >= 1 && spawn.y >= 1, '非法 forceAt 应重定向到合法格');
});

test('确定性：含道具整局同 seed 战报逐字节一致', () => {
  const A = (api) => {
    const it = api.nearestItem();
    if (it) return api.moveTo(it);
    return api.enemyVisible() && api.canFire() ? api.fireAt(api.enemy()) : api.patrol();
  };
  const B = (api) => api.patrol();
  const o = { seed: 9, botA: A, botB: B, rules: { items: { start: 5, every: 10, max: 2 } }, maxTicks: 200 };
  const r1 = runMatch({ ...o, map: openMap() });
  const r2 = runMatch({ ...o, map: openMap() });
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});
