// 技能 8 选 1：runMatch 增加 skillA/skillB；统一入口 useSkill()+ready()；旧入口映射；逐技能语义。
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, mapFromAscii } from '../src/engine/index.js';

const idle = () => null;

const corridor = () => mapFromAscii([
  '########',
  '#A....B#',
  '########',
]);

test('shield：挡下一次子弹伤害后消耗，第二发正常受伤', () => {
  const shieldLog = [];
  let used = false;
  const A = (api) => {
    shieldLog.push(api.me().shielded);
    if (!used && api.ready()) { used = true; return api.useSkill(); }
    return null;
  };
  const B = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
  const r = runMatch({ seed: 1, map: corridor(), botA: A, botB: B, skillA: 'shield', maxTicks: 10 });
  const block = r.events.find((e) => e.type === 'shield_block');
  assert.deepEqual({ t: block.t, who: block.who, source: block.source }, { t: 3, who: 0, source: 'bullet' });
  const hit = r.events.find((e) => e.type === 'hit' && e.target === 0);
  assert.equal(hit.t, 8, '第二发（t=5 出膛）在 t=8 正常命中');
  assert.equal(hit.hp, 80);
  assert.equal(shieldLog[1], true, '施放后持有护盾');
  assert.equal(shieldLog[3], false, '挡弹后护盾消耗');
});

test('shield：也能挡炸弹伤害', () => {
  const map = mapFromAscii([
    '#####',
    '#A.B#',
    '#####',
  ]);
  const A = (api) => (api.tick() === 0 ? api.useSkill() : null);
  const B = (api) => (api.tick() === 0 ? api.throwBomb() : null);
  const r = runMatch({ seed: 1, map, botA: A, botB: B, skillA: 'shield', maxTicks: 12 });
  const block = r.events.find((e) => e.type === 'shield_block');
  assert.deepEqual({ who: block.who, source: block.source }, { who: 0, source: 'bomb' });
  const end = r.events.at(-1);
  assert.deepEqual(end.hp, [100, 55], 'A 被护盾保住，B 自伤 45');
});

test('freeze：冻结 8 拍完全不能行动（区别于 stun），冷却 90', () => {
  const map = mapFromAscii([
    '######',
    '#A.B.#',
    '######',
  ]);
  const readyLog = [];
  const A = (api) => {
    readyLog.push(api.ready());
    if (api.ready() && api.enemyVisible()) return api.useSkill();
    return null;
  };
  const B = (api) => api.moveTo({ x: 4, y: 1 });
  const r = runMatch({ seed: 1, map, botA: A, botB: B, skillA: 'freeze', maxTicks: 12 });
  const fh = r.events.find((e) => e.type === 'freeze_hit');
  assert.deepEqual({ target: fh.target, duration: fh.duration }, { target: 1, duration: 8 });
  assert.deepEqual([readyLog[0], readyLog[1]], [true, false]);
  const movesB = r.events.filter((e) => e.type === 'move' && e.who === 1);
  assert.equal(movesB[0].t, 8, '冻结 8 拍内完全无移动，第 8 拍恢复');
});

test('stun：6 拍内可行动但移动/转向方向被种子 RNG 随机反转', () => {
  let anyReversed = false;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const map = mapFromAscii([
      '###########',
      '#A.B......#',
      '###########',
    ]);
    let used = false;
    const A = (api) => {
      if (!used && api.ready() && api.enemyVisible()) { used = true; return api.useSkill(); }
      return null;
    };
    const B = (api) => api.moveTo({ x: 9, y: 1 });
    const r = runMatch({ seed, map, botA: A, botB: B, skillA: 'stun', maxTicks: 10 });
    const sh = r.events.find((e) => e.type === 'stun_hit');
    assert.deepEqual({ target: sh.target, duration: sh.duration }, { target: 1, duration: 6 });
    const moves = r.events.filter((e) => e.type === 'move' && e.who === 1 && e.t < 6);
    assert.ok(moves.length >= 1, `seed=${seed} 眩晕不禁止行动，窗口内应有移动`);
    let px = 3;
    for (const m of moves) { if (m.x < px) anyReversed = true; px = m.x; }
  }
  assert.ok(anyReversed, '10 个种子中应至少出现一次方向反转（向左走）');
});

test('overload：下一次开火 2 连发（间隔 1 拍同向补射），两发都终结后才能再手动开火', () => {
  const map = mapFromAscii([
    '############',
    '#A........B#',
    '############',
  ]);
  const readyLog = [];
  const A = (api) => {
    readyLog.push(api.ready());
    if (api.tick() === 0) return api.useSkill();
    if (api.canFire()) return api.fireAt(api.enemy());
    return null;
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, skillA: 'overload', maxTicks: 8 });
  const fires = r.events.filter((e) => e.type === 'fire' && e.who === 0);
  assert.deepEqual(fires.map((e) => e.t), [1, 2, 7], 't=1 手动、t=2 自动补射、两发终结后 t=7 才能再射');
  assert.deepEqual([fires[0].dx, fires[0].dy], [fires[1].dx, fires[1].dy], '补射同向');
  const hits = r.events.filter((e) => e.type === 'hit' && e.target === 1);
  assert.deepEqual(hits.map((e) => e.t), [6, 7], '两发先后命中');
  assert.equal(readyLog[1], false, '施放后进入冷却');
});

test('cloak：作为装备技能经 useSkill 施放，隐身 25 拍', () => {
  const vis = [];
  let used = false;
  const A = (api) => {
    if (!used && api.ready()) { used = true; return api.useSkill(); }
    return null;
  };
  const B = (api) => { vis.push(api.enemyVisible()); return null; };
  runMatch({ seed: 1, map: corridor(), botA: A, botB: B, skillA: 'cloak', maxTicks: 30 });
  assert.equal(vis[0], true);
  assert.equal(vis[1], false);
  assert.equal(vis[24], false);
  assert.equal(vis[25], true, '25 拍后恢复可见');
});

test('poison：每拍 -2 HP 持续 10 拍，共 -20', () => {
  const map = mapFromAscii([
    '#####',
    '#A.B#',
    '#####',
  ]);
  const hpLog = [];
  let used = false;
  const A = (api) => {
    if (!used && api.ready() && api.enemyVisible()) { used = true; return api.useSkill(); }
    return null;
  };
  const B = (api) => { hpLog.push(api.me().hp); return null; };
  const r = runMatch({ seed: 1, map, botA: A, botB: B, skillA: 'poison', maxTicks: 14 });
  const ph = r.events.find((e) => e.type === 'poison_hit');
  assert.deepEqual({ target: ph.target, duration: ph.duration }, { target: 1, duration: 10 });
  assert.equal(r.events.filter((e) => e.type === 'poison_tick').length, 10);
  assert.equal(hpLog[1], 98, '施放当拍即开始掉血');
  assert.equal(hpLog[10], 80);
  assert.equal(hpLog[12], 80, '10 拍后停止');
});

test('teleport：非法落点（星星格）重定向到最近合法格，炮口不变，产生位置暴露事件', () => {
  const map = mapFromAscii([
    '#########',
    '#A..*..g#',
    '#......B#',
    '#########',
  ]);
  const meLog = [];
  const A = (api) => {
    meLog.push(api.me());
    if (api.tick() === 0) return api.teleport({ x: 4, y: 1 });
    return null;
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 3 });
  const sk = r.events.find((e) => e.type === 'skill' && e.name === 'teleport');
  assert.deepEqual({ x: sk.x, y: sk.y }, { x: 3, y: 1 }, '重定向到最近合法格 (3,1)');
  const rv = r.events.find((e) => e.type === 'teleport_reveal');
  assert.deepEqual({ who: rv.who, x: rv.x, y: rv.y }, { who: 0, x: 3, y: 1 });
  assert.deepEqual(meLog[1].facing, { dx: 1, dy: 0 }, '传送不改变炮口朝向');
  assert.deepEqual({ x: meLog[1].x, y: meLog[1].y }, { x: 3, y: 1 });
});

test('teleport：位置暴露更新敌方 lastSeen（即使落点在草丛）', () => {
  const map = mapFromAscii([
    '##########',
    '#A......g#',
    '#B.......#',
    '##########',
  ]);
  const log = [];
  const A = (api) => (api.tick() === 0 ? api.teleport({ x: 8, y: 1 }) : null);
  const B = (api) => { log.push(api.enemy()); return null; };
  runMatch({ seed: 1, map, botA: A, botB: B, maxTicks: 3 });
  assert.deepEqual(log[1], { x: 8, y: 1, visible: false }, '虽在草丛不可见，但传送当拍暴露了位置');
});

test('boost：10 拍内移动动作每拍走 2 格', () => {
  const map = mapFromAscii([
    '###########',
    '#A........#',
    '#B........#',
    '###########',
  ]);
  const xLog = [];
  const A = (api) => {
    xLog.push(api.me().x);
    if (api.tick() === 0) return api.useSkill();
    return api.moveTo({ x: 9, y: 1 });
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, skillA: 'boost', maxTicks: 5 });
  assert.deepEqual(xLog.slice(0, 4), [1, 1, 3, 5], '施放后每拍推进 2 格');
  const movesT1 = r.events.filter((e) => e.type === 'move' && e.who === 0 && e.t === 1);
  assert.equal(movesT1.length, 2, '单拍两个 move 事件');
});

test('旧入口映射：调用未装备技能 = no-op（旧脚本不炸），已装备技能正常生效', () => {
  const map = mapFromAscii([
    '#######',
    '#A...B#',
    '#######',
  ]);
  const A = (api) => {
    const t = api.tick();
    if (t === 0) return api.cloak();  // 装备 teleport（默认）→ no-op
    if (t === 1) return api.stun();   // no-op
    if (t === 2) return api.teleport({ x: 3, y: 1 }); // 装备的 teleport → 生效
    return null;
  };
  const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 4 });
  const skillEvs = r.events.filter((e) => e.type === 'skill' && e.who === 0);
  assert.equal(skillEvs.length, 1, '未装备技能的调用不产生任何技能事件');
  assert.deepEqual({ name: skillEvs[0].name, t: skillEvs[0].t }, { name: 'teleport', t: 2 });
});

test('默认技能：A=teleport、B=cloak，旧脚本 ready/cloak 路径可用', () => {
  const map = mapFromAscii([
    '#######',
    '#A...B#',
    '#######',
  ]);
  const B = (api) => (api.ready('cloak') ? api.cloak() : null);
  const r = runMatch({ seed: 1, map, botA: idle, botB: B, maxTicks: 3 });
  assert.ok(r.events.some((e) => e.type === 'skill' && e.name === 'cloak' && e.who === 1));
});
