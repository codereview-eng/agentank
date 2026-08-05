import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, renderText } from '../src/engine/index.js';
import { bots } from '../bots/index.js';

test('确定性：同种子+同脚本 ⇒ 战报深度相等且逐字节相同（抢星流 vs 贴脸流）', () => {
  const opts = { seed: 42, botA: bots.starGrabber, botB: bots.brawler };
  const r1 = runMatch(opts);
  const r2 = runMatch(opts);
  assert.deepEqual(r1.events, r2.events);
  assert.equal(JSON.stringify(r1.events), JSON.stringify(r2.events));
  assert.deepEqual(
    renderText(r1, ['抢星流', '贴脸流']),
    renderText(r2, ['抢星流', '贴脸流']),
  );
  assert.equal(r1.winner, r2.winner);
  assert.equal(r1.reason, r2.reason);
});

test('确定性：同种子+同脚本 ⇒ 战报逐字节相同（蹲草流 vs 隐身偷袭流）', () => {
  const opts = { seed: 7, botA: bots.camper, botB: bots.stealth };
  const r1 = runMatch(opts);
  const r2 = runMatch(opts);
  assert.equal(JSON.stringify(r1.events), JSON.stringify(r2.events));
});

test('不同种子 ⇒ 战报不同', () => {
  const r1 = runMatch({ seed: 42, botA: bots.starGrabber, botB: bots.brawler });
  const r2 = runMatch({ seed: 43, botA: bots.starGrabber, botB: bots.brawler });
  assert.notEqual(JSON.stringify(r1.events), JSON.stringify(r2.events));
});
