import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch } from '../src/engine/index.js';
import { bots } from '../bots/index.js';

const SEEDS = [11, 22, 33, 44, 55];

// f 视角得分：胜 1 分、平 0.5 分；每对打 SEEDS×双边 = 10 局
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

const roster = [
  ['蹲草流', bots.camper],
  ['抢星流', bots.starGrabber],
  ['贴脸流', bots.brawler],
  ['隐身偷袭流', bots.stealth],
];

test('四流派 bot 对随机乱走基线胜率显著高（≥65%）', () => {
  for (const [name, bot] of roster) {
    const s = series(bot, bots.baseline);
    assert.ok(s >= 6.5, `${name} 对基线得分 ${s}/10，应 ≥ 6.5`);
  }
});

test('流派间胜率非全 50%：存在明显强弱分化的对局', () => {
  const scores = [];
  for (let i = 0; i < roster.length; i++) {
    for (let j = i + 1; j < roster.length; j++) {
      const s = series(roster[i][1], roster[j][1]);
      scores.push({ pair: `${roster[i][0]} vs ${roster[j][0]}`, s });
    }
  }
  const skewed = scores.filter((x) => Math.abs(x.s - 5) >= 1.5);
  assert.ok(
    skewed.length >= 1,
    `应存在偏离 50% 的对局，实际：${JSON.stringify(scores)}`,
  );
});
