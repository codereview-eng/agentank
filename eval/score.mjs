#!/usr/bin/env node
// AgenTank 一键评分脚本：node eval/score.mjs
// 纯 Node ESM、零外部依赖。真实调用引擎 API 实测打分，产出 eval/scorecard.json。
// 不修改 src/ bots/ tests/ 任何代码。

import { runMatch, mapFromAscii } from '../src/engine/index.js';
import { bots } from '../bots/index.js';
import { writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const idle = () => null;
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- Section 1: 机制覆盖 40（逐项真跑引擎） ----------
function sectionMechanics() {
  const checks = [];
  const add = (name, fn) => {
    try {
      const detail = fn();
      checks.push({ name, pass: true, detail: String(detail ?? 'ok') });
    } catch (e) {
      checks.push({ name, pass: false, detail: String(e.message ?? e) });
    }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  add('墙挡子弹（bullet_end.reason=wall，无 hit）', () => {
    const map = mapFromAscii(['##########', '#A..#...B#', '##########']);
    const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 5 });
    const ends = r.events.filter((e) => e.type === 'bullet_end');
    assert(ends.length >= 1 && ends[0].reason === 'wall', `reason=${ends[0]?.reason}`);
    assert(r.events.filter((e) => e.type === 'hit').length === 0, '不应命中');
    return `bullet_end@(${ends[0].x},${ends[0].y}) reason=wall`;
  });

  add('墙挡坦克（moveTo 墙格不产生 move，位置不变）', () => {
    const map = mapFromAscii(['#####', '#A.B#', '#####']);
    const meLog = [];
    const A = (api) => { meLog.push(api.me()); return api.moveTo({ x: 1, y: 0 }); };
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 4 });
    const moves = r.events.filter((e) => e.type === 'move' && e.who === 0);
    assert(moves.length === 0, `不应有 move 事件，实际 ${moves.length}`);
    assert(meLog.every((m) => m.x === 1 && m.y === 1), '位置应保持 (1,1)');
    return '4 拍尝试走墙格均被拒，位置保持 (1,1)';
  });

  add('土堆挡子弹（bullet_end.reason=mound + mound_hit，无 hit）', () => {
    const map = mapFromAscii(['##########', '#A..D...B#', '##########']);
    const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 4 });
    const ends = r.events.filter((e) => e.type === 'bullet_end');
    assert(ends.length >= 1 && ends[0].reason === 'mound', `reason=${ends[0]?.reason}`);
    assert(r.events.some((e) => e.type === 'mound_hit'), '应有 mound_hit 事件');
    assert(r.events.filter((e) => e.type === 'hit').length === 0, '不应命中');
    return 'bullet_end reason=mound + mound_hit，无命中';
  });

  add('土堆两发摧毁（mound_hit → mound_destroyed 后弹道打通）', () => {
    const map = mapFromAscii(['##########', '#A..D...B#', '##########']);
    const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 60 });
    const destroyed = r.events.find((e) => e.type === 'mound_destroyed');
    assert(destroyed, '应有 mound_destroyed 事件');
    assert(r.events.some((e) => e.type === 'hit' && e.t > destroyed.t), '摧毁后子弹应能命中敌人');
    return `t=${destroyed.t} 土堆摧毁，之后子弹直达命中`;
  });

  add('土堆不挡坦克（可走上土堆格）', () => {
    const map = mapFromAscii(['#####', '#ADB#', '#####']);
    const A = (api) => api.moveTo({ x: 2, y: 1 });
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 2 });
    const moves = r.events.filter((e) => e.type === 'move' && e.who === 0);
    assert(moves.length >= 1 && moves[0].x === 2 && moves[0].y === 1, '应走上土堆格 (2,1)');
    return '成功走上土堆格 (2,1)';
  });

  add('冰面滑行（slide 事件、一步滑到离冰才停）', () => {
    const map = mapFromAscii(['########', '#A==..B#', '#......#', '########']);
    let moved = false;
    const A = (api) => { if (!moved) { moved = true; return api.moveTo({ x: 2, y: 1 }); } return null; };
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 2 });
    const slides = r.events.filter((e) => e.type === 'slide' && e.who === 0);
    assert(slides.length === 2, `slide 事件应 2 条，实际 ${slides.length}`);
    assert(slides.at(-1).x === 4, `滑行终点应 x=4，实际 ${slides.at(-1)?.x}`);
    return '踏冰续滑 2 格（move 1 格 + slide 2 格），离冰即停';
  });

  add('水域挡车不挡弹（隔河可射不可渡）', () => {
    const mk = () => mapFromAscii(['#######', '#A.~.B#', '#..~..#', '#######']);
    const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
    const r = runMatch({ seed: 1, map: mk(), botA: A, botB: idle, maxTicks: 6 });
    assert(r.events.some((e) => e.type === 'hit' && e.who === 0), '子弹应飞越水域命中');
    const xs = [];
    const M = (api) => { xs.push(api.me().x); return api.moveTo({ x: 5, y: 1 }); };
    runMatch({ seed: 1, map: mk(), botA: M, botB: idle, maxTicks: 10 });
    assert(xs.every((x) => x <= 2), '水域应完全隔断坦克通行');
    return '子弹越水命中；坦克无法渡河';
  });

  add('草丛远距隐身（距离>1 不可见）', () => {
    const map = mapFromAscii(['##########', '#A......b#', '##########']);
    const vis = [];
    const A = (api) => { vis.push(api.enemyVisible()); return null; };
    runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 5 });
    assert(vis.length >= 3 && vis.every((v) => v === false), `vis=${JSON.stringify(vis)}`);
    return `5 拍全部不可见`;
  });

  add('草丛贴脸可见（距离≤1 现形）+ 无草丛对照可见', () => {
    const near = mapFromAscii(['####', '#Ab#', '####']);
    const visNear = [];
    runMatch({ seed: 1, map: near, botA: (api) => { visNear.push(api.enemyVisible()); return null; }, botB: idle, maxTicks: 3 });
    assert(visNear.every((v) => v === true), '贴脸应可见');
    const open = mapFromAscii(['##########', '#A......B#', '##########']);
    const visOpen = [];
    runMatch({ seed: 1, map: open, botA: (api) => { visOpen.push(api.enemyVisible()); return null; }, botB: idle, maxTicks: 5 });
    assert(visOpen.every((v) => v === true), '空地应可见');
    return '贴脸草丛可见 + 空地对照可见';
  });

  add('星星拾取并计数（star 事件 + stars 统计）', () => {
    const map = mapFromAscii(['#####', '#A*.#', '#..B#', '#####']);
    const A = (api) => { const s = api.nearestStar(); return s ? api.moveTo(s) : null; };
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 6 });
    const stars = r.events.filter((e) => e.type === 'star');
    assert(stars.length === 1 && stars[0].who === 0 && stars[0].total === 1, JSON.stringify(stars));
    assert(r.stars[0] === 1 && r.stars[1] === 0, `stars=${JSON.stringify(r.stars)}`);
    return 'star 事件 who=0 total=1，r.stars=[1,0]';
  });

  add('隐身技能 + 冷却（生效期不可见、到期恢复、开火打破）', () => {
    const map = mapFromAscii(['#######', '#A...B#', '#.....#', '#######']);
    const vis = [];
    let used = false; const readyLog = [];
    const A = (api) => {
      readyLog.push(api.ready('cloak'));
      if (!used && api.ready('cloak')) { used = true; return api.cloak(); }
      return null;
    };
    const B = (api) => { vis.push(api.enemyVisible()); return null; };
    runMatch({ seed: 1, map, botA: A, botB: B, skillA: 'cloak', maxTicks: 40 });
    assert(vis[0] === true && vis[10] === false && vis[30] === true, `vis[0,10,30]=${vis[0]},${vis[10]},${vis[30]}`);
    assert(readyLog[0] === true && readyLog[1] === false, '使用后应进入冷却');
    // 开火打破隐身
    const vis2 = []; let st = 0;
    const A2 = (api) => {
      if (st === 0) { st = 1; return api.cloak(); }
      if (st === 1 && api.canFire()) { st = 2; return api.fireAt(api.enemy()); }
      return null;
    };
    runMatch({ seed: 1, map: mapFromAscii(['#######', '#A...B#', '#.....#', '#######']), botA: A2, botB: (api) => { vis2.push(api.enemyVisible()); return null; }, skillA: 'cloak', maxTicks: 8 });
    assert(vis2.includes(false) && vis2.at(-1) === true, `开火应打破隐身 vis2=${JSON.stringify(vis2)}`);
    return '隐身生效/到期恢复/冷却/开火打破 全通过';
  });

  add('传送技能 + 冷却（立即生效、冷却锁定、非法目标重定向、当拍暴露）', () => {
    const map = () => mapFromAscii(['#######', '#A...B#', '#.....#', '#######']);
    const readyLog = []; const meLog = []; let used = false;
    const A = (api) => {
      readyLog.push(api.ready('teleport')); meLog.push(api.me());
      if (!used && api.ready('teleport')) { used = true; return api.teleport({ x: 1, y: 2 }); }
      return null;
    };
    const r = runMatch({ seed: 1, map: map(), botA: A, botB: idle, skillA: 'teleport', maxTicks: 5 });
    assert(readyLog[0] === true && readyLog[1] === false, '传送后应进入冷却');
    assert(meLog[1].x === 1 && meLog[1].y === 2, '传送应立即生效');
    assert(r.events.some((e) => e.type === 'skill' && e.name === 'teleport' && e.who === 0), '应有 skill 事件');
    assert(r.events.some((e) => e.type === 'teleport_reveal' && e.who === 0), '传送当拍应有 teleport_reveal 暴露事件');
    // 非法目标（墙格）→ 重定向到最近合法格，照常消耗冷却
    const readyLog2 = []; const meLog2 = [];
    const A2 = (api) => { readyLog2.push(api.ready('teleport')); meLog2.push(api.me()); return api.teleport({ x: 0, y: 0 }); };
    const r2 = runMatch({ seed: 1, map: map(), botA: A2, botB: idle, skillA: 'teleport', maxTicks: 4 });
    assert(readyLog2[0] === true && readyLog2[1] === false, '非法目标重定向后应照常消耗冷却');
    assert(r2.events.some((e) => e.type === 'skill' && e.name === 'teleport'), '重定向传送应产生事件');
    const dest = meLog2.at(-1);
    assert(dest.x >= 1 && dest.y >= 1, `重定向落点应为合法格，实际 (${dest.x},${dest.y})`);
    return '传送立即生效 + 冷却 + teleport_reveal + 非法目标重定向消耗冷却';
  });

  add('冻结技能（freeze_hit、目标 8 拍不能动、冷却锁定）', () => {
    const map = mapFromAscii(['######', '#A.B.#', '######']);
    const readyLog = [];
    const A = (api) => { readyLog.push(api.ready()); return api.ready() ? api.useSkill() : null; };
    const B = (api) => api.moveTo({ x: 4, y: 1 });
    const r = runMatch({ seed: 1, map, botA: A, botB: B, skillA: 'freeze', maxTicks: 14 });
    const fh = r.events.find((e) => e.type === 'freeze_hit' && e.target === 1);
    assert(fh, '应有 freeze_hit 事件');
    assert(readyLog[0] === true && readyLog[1] === false, '冻结应进入冷却');
    const movesB = r.events.filter((e) => e.type === 'move' && e.who === 1);
    assert(movesB.length >= 1 && movesB[0].t >= fh.t + 8, `首次移动 t=${movesB[0]?.t}，应 ≥ ${fh.t + 8}`);
    return `freeze_hit@t${fh.t}，目标至 t=${movesB[0].t} 才恢复移动，冷却锁定`;
  });

  add('眩晕技能（stun_hit duration=6、操作随机化而非禁止行动）', () => {
    const map = mapFromAscii(['########', '#A....B#', '#......#', '########']);
    const A = (api) => (api.ready() ? api.useSkill() : null);
    const B = (api) => api.moveTo({ x: 1, y: 2 });
    const r = runMatch({ seed: 3, map, botA: A, botB: B, skillA: 'stun', maxTicks: 12 });
    const sh = r.events.find((e) => e.type === 'stun_hit' && e.target === 1);
    assert(sh, '应有 stun_hit 事件');
    assert(sh.duration === 6, `duration=${sh.duration}，应为 6`);
    const acts = r.events.filter((e) => (e.type === 'move' || e.type === 'turn') && e.who === 1 && e.t > sh.t && e.t <= sh.t + 6);
    assert(acts.length >= 1, '眩晕期间仍应有动作（随机化，非冻结）');
    return `stun_hit@t${sh.t}，眩晕期间动作 ${acts.length} 条（随机化生效，非禁止行动）`;
  });

  add('开火冷却（射后 5 拍 canFire=false）', () => {
    const map = mapFromAscii(['########', '#A....B#', '########']);
    const canLog = [];
    const A = (api) => { canLog.push(api.canFire()); return api.canFire() ? api.fireAt(api.enemy()) : null; };
    runMatch({ seed: 1, map, botA: A, botB: idle });
    assert(canLog[0] === true && canLog[1] === false && canLog[4] === false && canLog[5] === true,
      `canFire 序列=${JSON.stringify(canLog.slice(0, 6))}`);
    return 'canFire: t0=true → t1..t4=false → t5=true';
  });

  add('击杀即胜（winner + reason=kill + death 事件，早于超时）', () => {
    const map = mapFromAscii(['########', '#A....B#', '########']);
    const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
    const r = runMatch({ seed: 1, map, botA: A, botB: idle });
    assert(r.winner === 0 && r.reason === 'kill', `winner=${r.winner} reason=${r.reason}`);
    assert(r.events.some((e) => e.type === 'death' && e.who === 1), '应有 death 事件');
    assert(r.ticks < 900, '应早于超时');
    return `kill 胜于 tick ${r.ticks}`;
  });

  add('超时比星（无击杀星多者胜 reason=stars）', () => {
    const map = mapFromAscii(['#####', '#A*.#', '#..B#', '#####']);
    const A = (api) => { const s = api.nearestStar(); return s ? api.moveTo(s) : null; };
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 6 });
    assert(r.winner === 0 && r.reason === 'stars', `winner=${r.winner} reason=${r.reason}`);
    const end = r.events.at(-1);
    assert(end.type === 'end' && end.reason === 'stars', 'end 事件 reason 应为 stars');
    return '超时后星多者胜，end.reason=stars';
  });

  add('平局（无击杀且星数相同 winner=null reason=draw）', () => {
    const map = mapFromAscii(['#####', '#A.B#', '#####']);
    const r = runMatch({ seed: 1, map, botA: idle, botB: idle, maxTicks: 10 });
    assert(r.winner === null && r.reason === 'draw', `winner=${r.winner} reason=${r.reason}`);
    return 'winner=null reason=draw';
  });

  add('单发在飞（在飞期间 canFire=false、me().bulletInFlight=true）', () => {
    const map = mapFromAscii(['############', '#A........B#', '############']);
    const log = [];
    const A = (api) => {
      log.push({ can: api.canFire(), inFlight: api.me().bulletInFlight });
      return api.canFire() ? api.fireAt(api.enemy()) : null;
    };
    runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 4 });
    assert(log[0].can === true && log[0].inFlight === false, 't0 应可开火且无在飞');
    const inFlightTick = log.findIndex((x) => x.inFlight === true);
    assert(inFlightTick >= 1, '开火后应出现在飞状态');
    assert(log[inFlightTick].can === false, '在飞期间 canFire 应为 false');
    return `t${inFlightTick} 在飞（bulletInFlight=true、canFire=false）`;
  });

  add('子弹查询（myBullet 在飞可查；enemyBullet 视锥内可见）', () => {
    const map = mapFromAscii(['############', '#A........B#', '############']);
    const myLog = []; const enemyLog = [];
    const A = (api) => { myLog.push(api.myBullet()); return api.canFire() ? api.fireAt(api.enemy()) : null; };
    const B = (api) => { enemyLog.push(api.enemyBullet()); return api.canFire() ? api.fireAt(api.enemy()) : null; };
    runMatch({ seed: 1, map, botA: A, botB: B, maxTicks: 6 });
    assert(myLog[0] === null, 't0 应无在飞子弹');
    assert(myLog.some((b) => b && typeof b.x === 'number' && typeof b.dx === 'number'), 'myBullet 在飞应可查 {x,y,dx,dy}');
    assert(enemyLog.some((b) => b !== null), '面向来弹方向应能看见敌方子弹（90° 视锥）');
    return 'myBullet 在飞可查；enemyBullet 视锥内可见';
  });

  add('炸弹（bomb_place → 10 拍引信 bomb_explode，十字爆区）', () => {
    const map = mapFromAscii(['#######', '#A...B#', '#.....#', '#######']);
    let thrown = false;
    const A = (api) => { if (!thrown && api.ready('bomb')) { thrown = true; return api.throwBomb(); } return null; };
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 20 });
    const place = r.events.find((e) => e.type === 'bomb_place' && e.who === 0);
    const boom = r.events.find((e) => e.type === 'bomb_explode');
    assert(place, '应有 bomb_place 事件');
    assert(boom, '应有 bomb_explode 事件');
    assert(boom.t - place.t === 10, `引信应 10 拍，实际 ${boom.t - place.t}`);
    assert(Array.isArray(boom.cells) && boom.cells.length >= 1, '爆炸应有 cells 爆区');
    assert(Array.isArray(boom.hits) && boom.hits.some((h) => h.who === 0), '原地不动应被自己炸到（自伤保留）');
    return `bomb_place@t${place.t} → bomb_explode@t${boom.t}，爆区 ${boom.cells.length} 格，自伤命中`;
  });

  add('单星（吃星后 15 拍 star_spawn 重生）', () => {
    const r = runMatch({ seed: 5, botA: bots.starGrabber, botB: idle, maxTicks: 200 });
    const eat = r.events.find((e) => e.type === 'star');
    assert(eat, '应有吃星事件');
    const spawn = r.events.find((e) => e.type === 'star_spawn' && e.t > eat.t);
    assert(spawn, '吃星后应有 star_spawn 重生');
    assert(spawn.t - eat.t === 15, `重生间隔应 15 拍，实际 ${spawn.t - eat.t}`);
    return `t${eat.t} 吃星 → t${spawn.t} 重生（间隔 15）`;
  });

  add('技能 8 选 1（runMatch skillA 生效、未装备旧入口安全 no-op）', () => {
    const map = mapFromAscii(['#######', '#A...B#', '#.....#', '#######']);
    let used = false;
    const A = (api) => { if (!used && api.ready()) { used = true; return api.useSkill(); } return null; };
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, skillA: 'shield', maxTicks: 5 });
    assert(Array.isArray(r.skills) && r.skills[0] === 'shield', `skills=${JSON.stringify(r.skills)}`);
    assert(r.events.some((e) => e.type === 'skill' && e.name === 'shield' && e.who === 0), '应有 shield skill 事件');
    const r2 = runMatch({ seed: 1, map, botA: (api) => api.cloak(), botB: idle, skillA: 'shield', maxTicks: 3 });
    assert(!r2.events.some((e) => e.type === 'skill'), '未装备 cloak 的旧入口调用应为安全 no-op');
    return 'shield 装备生效；未装备旧入口 no-op 不炸';
  });

  const max = 40;
  const per = max / checks.length;
  const score = round2(checks.filter((c) => c.pass).length * per);
  return { name: '机制覆盖', max, score, checks };
}

// ---------- Section 2: 确定性重放 15 ----------
function sectionDeterminism() {
  const checks = [];
  const pairs = [
    [42, bots.starGrabber, bots.brawler, '抢星流 vs 贴脸流'],
    [7, bots.camper, bots.stealth, '蹲草流 vs 隐身偷袭流'],
    [101, bots.stealth, bots.baseline, '隐身偷袭流 vs 基线'],
    [20260805, bots.brawler, bots.camper, '贴脸流 vs 蹲草流'],
  ];
  for (const [seed, a, b, label] of pairs) {
    const r1 = runMatch({ seed, botA: a, botB: b });
    const r2 = runMatch({ seed, botA: a, botB: b });
    const s1 = JSON.stringify(r1.events);
    const s2 = JSON.stringify(r2.events);
    const pass = s1 === s2 && r1.winner === r2.winner && r1.reason === r2.reason;
    checks.push({
      name: `同 seed=${seed} 两次重放逐字节相等（${label}）`,
      pass,
      detail: pass ? `events ${r1.events.length} 条，序列化 ${s1.length} 字节，逐字节相等` : '两次运行结果不一致',
    });
  }
  {
    const r1 = runMatch({ seed: 42, botA: bots.starGrabber, botB: bots.brawler });
    const r2 = runMatch({ seed: 43, botA: bots.starGrabber, botB: bots.brawler });
    const pass = JSON.stringify(r1.events) !== JSON.stringify(r2.events);
    checks.push({ name: '异 seed（42 vs 43）事件流必不同', pass, detail: pass ? '两个 seed 的事件流不同' : '异 seed 事件流竟然相同' });
  }
  const max = 15;
  const per = max / checks.length;
  return { name: '确定性重放', max, score: round2(checks.filter((c) => c.pass).length * per), checks };
}

// ---------- Section 3: 流派区分度 15 ----------
const SEEDS = [11, 22, 33, 44, 55];
function series(f, g) {
  let score = 0;
  for (const seed of SEEDS) {
    for (const flip of [false, true]) {
      const r = runMatch({ seed, botA: flip ? g : f, botB: flip ? f : g });
      if (r.winner === null) score += 0.5;
      else if ((r.winner === 0) !== flip) score += 1;
    }
  }
  return score; // 满分 10
}

function sectionStyles() {
  const checks = [];
  const roster = [
    ['蹲草流', bots.camper],
    ['抢星流', bots.starGrabber],
    ['贴脸流', bots.brawler],
    ['隐身偷袭流', bots.stealth],
  ];
  for (const [name, bot] of roster) {
    const s = series(bot, bots.baseline);
    checks.push({ name: `${name} vs 随机基线胜率 ≥6.5/10`, pass: s >= 6.5, detail: `固定 seeds ${JSON.stringify(SEEDS)} 双边共 10 局，得分 ${s}/10` });
  }
  const scores = [];
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      scores.push({ pair: `${roster[i][0]} vs ${roster[j][0]}`, s: series(roster[i][1], roster[j][1]) });
    }
  }
  const skewed = scores.filter((x) => Math.abs(x.s - 5) >= 1.5);
  checks.push({
    name: '流派间存在明显非 50% 对局（|得分-5|≥1.5）',
    pass: skewed.length >= 1,
    detail: `循环赛 ${scores.map((x) => `${x.pair}=${x.s}/10`).join('；')}；偏离对局数=${skewed.length}`,
  });
  const max = 15;
  const per = max / checks.length;
  return { name: '流派区分度', max, score: round2(checks.filter((c) => c.pass).length * per), checks };
}

// ---------- Section 4/6: 回放器 / UI（检查真实产物，不存在记 0） ----------
function uiArtifactStatus() {
  const candidates = ['web/index.html', 'src/ui', 'public/index.html', 'ui/index.html'];
  const found = candidates.filter((p) => existsSync(join(ROOT, p)));
  return { found, exists: found.length > 0 };
}

function sectionReplay(ui) {
  const checks = [{
    name: '存在网页回放器产物（web/index.html 或 src/ui/ 等）并能消费事件数组',
    pass: ui.exists,
    detail: ui.exists ? `发现产物：${ui.found.join(', ')}` : `检查路径 web/index.html、src/ui/、public/index.html、ui/index.html 均不存在`,
  }];
  const s = { name: '回放正确', max: 10, score: ui.exists ? 10 : 0, checks };
  if (!ui.exists) s.reason = 'UI 未实现';
  return s;
}

function sectionUi(ui) {
  const checks = [{
    name: '网页 UI 可用（与回放器同口径检查真实产物）',
    pass: ui.exists,
    detail: ui.exists ? `发现产物：${ui.found.join(', ')}` : 'docs/mockups/ 仅为效果稿，不算产品 UI；无可加载的真实 UI 产物',
  }];
  const s = { name: 'UI 可用', max: 10, score: ui.exists ? 10 : 0, checks };
  if (!ui.exists) s.reason = 'UI 未实现';
  return s;
}

// ---------- Section 5: 性能 10 ----------
function sectionPerf() {
  const N = 100;
  const matchups = [
    [bots.camper, bots.starGrabber],
    [bots.brawler, bots.stealth],
    [bots.starGrabber, bots.brawler],
    [bots.stealth, bots.baseline],
  ];
  // 预热，避免首局 JIT 抖动计入
  runMatch({ seed: 999, botA: bots.brawler, botB: bots.camper });
  const seeds = Array.from({ length: N }, () => Math.floor(Math.random() * 2 ** 31));
  const t0 = performance.now();
  let totalTicks = 0;
  for (let i = 0; i < N; i++) {
    const [a, b] = matchups[i % matchups.length];
    const r = runMatch({ seed: seeds[i], botA: a, botB: b });
    totalTicks += r.ticks;
  }
  const elapsed = performance.now() - t0;
  const avg = elapsed / N;
  // 口径：avg ≤ 50ms 满分 10；超出后线性降级，avg=100ms 得 0 分。
  const score = round2(Math.max(0, Math.min(10, 10 * (2 - avg / 50))));
  const checks = [{
    name: `${N} 局（随机 seeds、四组对阵轮换、默认地图）平均单局 <50ms`,
    pass: avg < 50,
    detail: `总耗时 ${round2(elapsed)}ms，平均 ${round2(avg)}ms/局，共 ${totalTicks} ticks`,
  }];
  return { name: '性能', max: 10, score, checks };
}

// ---------- 引擎自带测试摘要（node --test） ----------
function engineTestSummary() {
  try {
    const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] ?? NaN);
    return { pass: num('pass'), fail: num('fail'), tests: num('tests'), ok: num('fail') === 0 };
  } catch (e) {
    const out = String(e.stdout ?? '');
    const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] ?? NaN);
    return { pass: num('pass'), fail: num('fail'), tests: num('tests'), ok: false };
  }
}

// ---------- main ----------
const ui = uiArtifactStatus();
const sections = [
  sectionMechanics(),
  sectionDeterminism(),
  sectionStyles(),
  sectionReplay(ui),
  sectionPerf(),
  sectionUi(ui),
];
const total = round2(sections.reduce((s, x) => s + x.score, 0));
const scorecard = {
  total,
  sections,
  generatedAt: new Date().toISOString(),
  engineTestSummary: engineTestSummary(),
};
writeFileSync(join(__dirname, 'scorecard.json'), JSON.stringify(scorecard, null, 2) + '\n');

console.log(`AgenTank 评分：${total}/100`);
for (const s of sections) {
  console.log(`  ${s.name}: ${s.score}/${s.max}${s.reason ? `（${s.reason}）` : ''}`);
  for (const c of s.checks) console.log(`    [${c.pass ? '✓' : '✗'}] ${c.name} — ${c.detail}`);
}
console.log(`引擎测试: pass=${scorecard.engineTestSummary.pass} fail=${scorecard.engineTestSummary.fail}`);
console.log('已写入 eval/scorecard.json');
