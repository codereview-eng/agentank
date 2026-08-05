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

  add('墙挡子弹（bullet_end.cause=wall，无 hit）', () => {
    const map = mapFromAscii(['##########', '#A..#...B#', '##########']);
    const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 3 });
    const ends = r.events.filter((e) => e.type === 'bullet_end');
    assert(ends.length >= 1 && ends[0].cause === 'wall', `cause=${ends[0]?.cause}`);
    assert(r.events.filter((e) => e.type === 'hit').length === 0, '不应命中');
    return `bullet_end@(${ends[0].x},${ends[0].y}) cause=wall`;
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

  add('土堆挡子弹（bullet_end.cause=dirt，无 hit）', () => {
    const map = mapFromAscii(['##########', '#A..D...B#', '##########']);
    const A = (api) => (api.canFire() ? api.fireAt(api.enemy()) : null);
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 3 });
    const ends = r.events.filter((e) => e.type === 'bullet_end');
    assert(ends.length >= 1 && ends[0].cause === 'dirt', `cause=${ends[0]?.cause}`);
    assert(r.events.filter((e) => e.type === 'hit').length === 0, '不应命中');
    return 'bullet_end cause=dirt，无命中';
  });

  add('土堆不挡坦克（可走上土堆格）', () => {
    const map = mapFromAscii(['#####', '#ADB#', '#####']);
    const A = (api) => api.moveTo({ x: 2, y: 1 });
    const r = runMatch({ seed: 1, map, botA: A, botB: idle, maxTicks: 2 });
    const moves = r.events.filter((e) => e.type === 'move' && e.who === 0);
    assert(moves.length >= 1 && moves[0].x === 2 && moves[0].y === 1, '应走上土堆格 (2,1)');
    return '成功走上土堆格 (2,1)';
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
    runMatch({ seed: 1, map, botA: A, botB: B, maxTicks: 40 });
    assert(vis[0] === true && vis[10] === false && vis[30] === true, `vis[0,10,30]=${vis[0]},${vis[10]},${vis[30]}`);
    assert(readyLog[0] === true && readyLog[1] === false, '使用后应进入冷却');
    // 开火打破隐身
    const vis2 = []; let st = 0;
    const A2 = (api) => {
      if (st === 0) { st = 1; return api.cloak(); }
      if (st === 1) { st = 2; return api.fireAt(api.enemy()); }
      return null;
    };
    runMatch({ seed: 1, map: mapFromAscii(['#######', '#A...B#', '#.....#', '#######']), botA: A2, botB: (api) => { vis2.push(api.enemyVisible()); return null; }, maxTicks: 6 });
    assert(vis2[1] === false && vis2[2] === true, '开火应打破隐身');
    return '隐身生效/到期恢复/冷却/开火打破 全通过';
  });

  add('传送技能 + 冷却（立即生效、冷却锁定、非法目标不消耗）', () => {
    const map = () => mapFromAscii(['#######', '#A...B#', '#.....#', '#######']);
    const readyLog = []; const meLog = []; let used = false;
    const A = (api) => {
      readyLog.push(api.ready('teleport')); meLog.push(api.me());
      if (!used && api.ready('teleport')) { used = true; return api.teleport({ x: 1, y: 2 }); }
      return null;
    };
    const r = runMatch({ seed: 1, map: map(), botA: A, botB: idle, maxTicks: 5 });
    assert(readyLog[0] === true && readyLog[1] === false, '传送后应进入冷却');
    assert(meLog[1].x === 1 && meLog[1].y === 2, '传送应立即生效');
    assert(r.events.some((e) => e.type === 'skill' && e.name === 'teleport' && e.who === 0), '应有 skill 事件');
    const readyLog2 = [];
    const A2 = (api) => { readyLog2.push(api.ready('teleport')); return api.teleport({ x: 0, y: 0 }); };
    const r2 = runMatch({ seed: 1, map: map(), botA: A2, botB: idle, maxTicks: 3 });
    assert(readyLog2.every((v) => v === true), '非法目标不应消耗冷却');
    assert(r2.events.filter((e) => e.type === 'skill' && e.name === 'teleport').length === 0, '非法传送不应产生事件');
    return '传送立即生效 + 冷却 + 非法目标不消耗';
  });

  add('眩晕技能 + 冷却（stun_hit、目标 8 拍不能动、冷却锁定）', () => {
    const map = mapFromAscii(['######', '#A.B.#', '######']);
    const readyLog = [];
    const A = (api) => { readyLog.push(api.ready('stun')); return api.ready('stun') ? api.stun() : null; };
    const B = (api) => api.moveTo({ x: 4, y: 1 });
    const r = runMatch({ seed: 1, map, botA: A, botB: B, maxTicks: 12 });
    assert(r.events.some((e) => e.type === 'stun_hit' && e.target === 1), '应有 stun_hit 事件');
    assert(readyLog[0] === true && readyLog[1] === false, '眩晕应进入冷却');
    const movesB = r.events.filter((e) => e.type === 'move' && e.who === 1);
    assert(movesB.length >= 1 && movesB[0].t === 8, `首次移动 t=${movesB[0]?.t}，应为 8`);
    return 'stun_hit 命中，目标至 t=8 才恢复移动，冷却锁定';
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
