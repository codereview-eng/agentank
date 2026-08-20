#!/usr/bin/env node
// 复盘闭环的胜率实测：node scripts/measure-review.mjs
//
// 回答一个问题：「照着批量战报里标出的毛病改战术，同关卡同对手同技能、只换种子，胜率会不会真涨」。
// 纪律：AI 只看**训练组**的战报；胜率是否真涨以**留出组**（同一套改动、AI 没见过的 12 个种子）为准。
// 本脚本不联网、不调模型——它只负责把「改前 / 改后」两套脚本在两组种子上跑出确定性数字。
import { runMatch, presetMap, summarizeGame, aggregateBatch, renderBatchText, BATCH_SEEDS } from '../src/engine/index.js';
import { bots } from '../bots/index.js';

const seedFromString = (s) => { // 与网页端同口径（web/app.js）
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

const MAP_ID = 'crossFort';
const OPP = { key: 'stealth', fn: bots.stealth, style: '隐身偷袭流' };
const SKILL = 'teleport';

// ── 改前：只会「看到就打、追着打」，不管星、不管缩圈、不管冷却（典型新手战术）
const BASELINE_STRATEGY = '看到敌人就开火，一直追着他打；血量低于 40 去找急救包。';
function baseline(api) {
  const me = api.me();
  const e = api.enemy();
  if (api.canFire() && api.enemyVisible()) return api.fireAt(e);
  if (me.hp < 40) {
    const kit = api.nearestItem('medkit');
    if (kit) return api.moveTo(kit);
  }
  return api.moveTo(e);
}

// ── 改后：逐条对着战报标出的可疑时刻改（缩圈优先 / 近星必吃 / 冷却期避战 / 血低硬中断 / 别对着掩体开火）
const IMPROVED_STRATEGY = [
  '缩圈预警一出现就立刻进安全区，宁可放弃当前目标。',
  '血量低于 40 立即去最近的急救包，这条是硬中断，追击逻辑不得压过它。',
  '4 格内有星必须先吃，星数判定不能落后。',
  '位移技能在冷却时不要在 3~6 格中距离对射，先退到草丛或安全角。',
  '只在与敌同行同列时开火，避免对着墙和土堆白开炮。',
].join('\n');
function improved(api) {
  const me = api.me();
  const e = api.enemy();
  const z = api.zone();

  if (z && !api.inZone()) { // 1 缩圈优先
    const cx = Math.round((z.x0 + z.x1) / 2);
    const cy = Math.round((z.y0 + z.y1) / 2);
    return api.moveTo({ x: cx, y: cy });
  }
  if (me.hp < 40) { // 2 血低硬中断
    const kit = api.nearestItem('medkit');
    if (kit) return api.moveTo(kit);
  }
  const star = api.nearestStar(); // 3 近星必吃
  if (star && api.distTo(star) <= 4) return api.moveTo(star);

  const d = api.distTo(e);
  if (!api.ready() && d >= 3 && d <= 6) { // 4 冷却期避战
    const cover = api.nearestGrass() || api.safestCorner();
    if (cover) return api.moveTo(cover);
  }
  const aligned = api.enemyVisible() && (me.x === e.x || me.y === e.y); // 5 对齐才开火
  if (api.canFire() && aligned) return api.fireAt(e);
  if (api.ready() && d <= 2 && me.hp > e.hp) return api.useSkill(e);
  return api.moveTo(star || e);
}

// ── 改后 v2：**只改战报里有证据的那两条**（挨打不动 ×18、白开炮 ×16），不加战报没支持的花招。
// v1 里的「冷却期退草丛避战」就是没有证据支撑的自作主张——留出组把它拦下了（见输出）。
const MINIMAL_STRATEGY = [
  '挨过一发之后立刻换一格，别站在原地被锁定弹道。',
  '只在与敌同行同列时开火，避免对着墙和土堆白开炮。',
  '血量低于 40 立即去最近的急救包，追击逻辑不得压过它。',
].join('\n');
function minimalFix(api) {
  const me = api.me();
  const e = api.enemy();
  if (me.hp < 40) { // 血低硬中断（原战术写了却被追击压掉）
    const kit = api.nearestItem('medkit');
    if (kit) return api.moveTo(kit);
  }
  const aligned = api.enemyVisible() && (me.x === e.x || me.y === e.y);
  if (api.canFire() && aligned) return api.fireAt(e); // 对齐才开火：治「白开炮」
  const eb = api.enemyBullet();
  if (eb && (eb.x === me.x || eb.y === me.y)) { // 弹道上就侧移：治「挨打不动」
    const side = (eb.x === me.x) ? { x: me.x + 1, y: me.y } : { x: me.x, y: me.y + 1 };
    const alt = (eb.x === me.x) ? { x: me.x - 1, y: me.y } : { x: me.x, y: me.y - 1 };
    if (api.walkable(side)) return api.moveTo(side);
    if (api.walkable(alt)) return api.moveTo(alt);
  }
  return api.moveTo(e);
}

function runSet(setName, fn, strategy) {
  const seeds = BATCH_SEEDS[setName];
  const games = [];
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    const seed = seedFromString(s);
    const map = presetMap(MAP_ID);
    const who = i % 2; // 先后手各 6 局
    const mine = (api) => fn(api);
    mine.skill = SKILL;
    const result = runMatch({
      seed,
      map,
      botA: who === 0 ? mine : OPP.fn,
      botB: who === 0 ? OPP.fn : mine,
    });
    games.push(summarizeGame({ map, result, who, seed: s, strategy }));
  }
  return {
    games,
    agg: aggregateBatch(games),
    setup: { opponent: OPP.style, skill: SKILL, mapKey: MAP_ID, tank: '被测坦克', seedSet: setName, seeds },
    at: '（实测）',
  };
}

const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

const before = { train: runSet('train', baseline, BASELINE_STRATEGY), holdout: runSet('holdout', baseline, BASELINE_STRATEGY) };
const after = { train: runSet('train', improved, IMPROVED_STRATEGY), holdout: runSet('holdout', improved, IMPROVED_STRATEGY) };

console.log('===== 改前：训练组的人读批量报告（AI 看到的就是这份） =====');
console.log(renderBatchText(before.train).join('\n'));

console.log('===== 四个数字（同关卡 crossFort · 同对手 隐身偷袭流 · 同技能 传送 · 只换种子） =====');
const row = (label, b, a) => {
  const delta = Math.round((a.agg.winRate - b.agg.winRate) * 100);
  console.log(`${label}  改前 ${pct(b.agg.winRate)}（${b.agg.wins}/${b.agg.games}） → 改后 ${pct(a.agg.winRate)}（${a.agg.wins}/${a.agg.games}）  ${delta >= 0 ? '+' : ''}${delta} 点`);
};
console.log('— 改法 v1：战报里的 5 条一起改（含「冷却期退草丛避战」这条战报没有证据支撑的自作主张）');
row('  训练组（AI 看过战报）', before.train, after.train);
row('  留出组（AI 没见过）  ', before.holdout, after.holdout);

const min = { train: runSet('train', minimalFix, MINIMAL_STRATEGY), holdout: runSet('holdout', minimalFix, MINIMAL_STRATEGY) };
console.log('— 改法 v2：只改战报里有证据的两条（挨打不动 / 白开炮）+ 血低硬中断');
row('  训练组（AI 看过战报）', before.train, min.train);
row('  留出组（AI 没见过）  ', before.holdout, min.holdout);

const verdict = (label, b, a) => {
  const up = a.agg.winRate > b.agg.winRate;
  console.log(`${label}：留出组 ${pct(b.agg.winRate)} → ${pct(a.agg.winRate)} —— ${up ? '真的变强（不是记住了训练那 12 个种子）' : '不成立，训练组涨了也不算'}`);
};
console.log('===== 结论（只认留出组） =====');
verdict('v1', before.holdout, after.holdout);
verdict('v2', before.holdout, min.holdout);
