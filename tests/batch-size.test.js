// 基线局数可选（默认 50）：种子集要能按局数生成，且样本量必须进对比口径
//
// 为什么默认从 12 提到 50：12 局里赢输一局 = 8.3 个百分点，胜率噪声比多数战术改动的真实效果还大，
// 「提升」经常只是抖动。50 局把一局的权重降到 2 个百分点，且全在浏览器本地算，不上传、不花钱。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BATCH_SIZES, BATCH_N_DEFAULT, batchSeeds, normalizeBatchN, BATCH_SEEDS } from '../src/engine/index.js';
import { setupKeyOf, batchEtaMs } from '../web/play.js';

test('默认局数是 50，且在可选档里', () => {
  assert.equal(BATCH_N_DEFAULT, 50);
  assert.ok(BATCH_SIZES.includes(50));
  assert.ok(BATCH_SIZES.every((n) => Number.isInteger(n) && n > 0));
});

test('种子集按局数生成：数量对、无重复', () => {
  for (const n of BATCH_SIZES) {
    const s = batchSeeds('train', n);
    assert.equal(s.length, n, `${n} 局应生成 ${n} 个种子`);
    assert.equal(new Set(s).size, n, `${n} 局的种子不许重复（重复=同一局算两次）`);
  }
});

test('训练组与留出组零交集（留出组一旦沾上训练种子，验收就失效）', () => {
  for (const n of BATCH_SIZES) {
    const tr = new Set(batchSeeds('train', n));
    const ho = batchSeeds('holdout', n);
    assert.ok(ho.every((s) => !tr.has(s)), `${n} 局时两组种子重叠了`);
  }
});

test('50 档的前 12 个与 12 档逐字一致（老基线仍可对照，不是换了一套世界）', () => {
  assert.deepEqual(batchSeeds('train', 50).slice(0, 12), batchSeeds('train', 12));
  assert.equal(batchSeeds('train', 12)[0], 'tr01');
  assert.equal(batchSeeds('holdout', 12)[11], 'ho12');
});

test('非法局数夹到最近的合法档，绝不产出 0 局或天文数字', () => {
  assert.equal(normalizeBatchN(0), 12);
  assert.equal(normalizeBatchN(-5), 12);
  assert.equal(normalizeBatchN(999999), 100);
  assert.equal(normalizeBatchN('50'), 50);
  assert.equal(normalizeBatchN(null), BATCH_N_DEFAULT);
  assert.equal(normalizeBatchN(undefined), BATCH_N_DEFAULT);
  assert.equal(normalizeBatchN(NaN), BATCH_N_DEFAULT);
  assert.equal(normalizeBatchN(40), 50, '落在两档之间就取最近的一档');
  assert.equal(batchSeeds('train', 0).length, 12, '生成器也走同一套归一化');
});

test('默认导出的种子集就是默认档（50 局）', () => {
  assert.equal(BATCH_SEEDS.train.length, BATCH_N_DEFAULT);
  assert.equal(BATCH_SEEDS.holdout.length, BATCH_N_DEFAULT);
});

// ---------- 样本量必须进对比口径 ----------
test('对局设置 key 含局数：12 局基线与 50 局候选不是同一套口径，不许并排比', () => {
  const base = { opponent: '哨戒流', skill: 'shield', mapKey: '迷宫回廊', tank: 'tankbase v6' };
  const k12 = setupKeyOf({ ...base, n: 12 });
  const k50 = setupKeyOf({ ...base, n: 50 });
  assert.notEqual(k12, k50, '换了局数还判成同一套设置，就会拿 12 局的胜率跟 50 局的比');
  assert.equal(setupKeyOf({ ...base, n: 50 }), k50, '同样输入必须稳定');
});

test('对局设置 key：任一维度变了就换 key（对手/技能/地图/坦克/局数）', () => {
  const base = { opponent: 'a', skill: 'shield', mapKey: 'm', tank: 't', n: 50 };
  const k = setupKeyOf(base);
  for (const [field, val] of [['opponent', 'b'], ['skill', 'cloak'], ['mapKey', 'm2'], ['tank', 't2'], ['n', 12]]) {
    assert.notEqual(setupKeyOf({ ...base, [field]: val }), k, `${field} 变了必须换 key`);
  }
});

test('对局设置 key：局数走同一套归一化（非法值不会分裂出第二个 key）', () => {
  const base = { opponent: 'a', skill: 'shield', mapKey: 'm', tank: 't' };
  assert.equal(setupKeyOf({ ...base, n: 40 }), setupKeyOf({ ...base, n: 50 }));
  assert.equal(setupKeyOf({ ...base, n: null }), setupKeyOf({ ...base, n: BATCH_N_DEFAULT }));
});

// ---------- 预计耗时：先保守，跑过一次后按本机实测自校准 ----------
test('预计耗时：没有实测样本时用保守常量，且算的是两组', () => {
  assert.equal(batchEtaMs({ n: 50, fallbackPerMatchMs: 260 }), 26000);
  assert.equal(batchEtaMs({ n: 12, fallbackPerMatchMs: 260 }), 6240);
});

test('预计耗时：有实测样本就按本机真实速度推（常量高估 3 倍会让人不再信进度提示）', () => {
  // 实测：50 局用了 3800ms → 76ms/局 → 两组 100 局约 7.6s
  assert.equal(batchEtaMs({ n: 50, sampleGames: 50, sampleMs: 3800 }), 7600);
  assert.equal(batchEtaMs({ n: 100, sampleGames: 50, sampleMs: 3800 }), 15200, '换大档要按同一速度线性外推');
});

test('预计耗时：样本不合法时退回常量，绝不给出 0 秒', () => {
  assert.ok(batchEtaMs({ n: 50, sampleGames: 0, sampleMs: 3800 }) > 0);
  assert.ok(batchEtaMs({ n: 50, sampleGames: 50, sampleMs: 0 }) > 0);
  assert.ok(batchEtaMs({ n: 0 }) > 0);
});
