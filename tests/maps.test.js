import test from 'node:test';
import assert from 'node:assert/strict';
import { runMatch, PRESET_MAPS, presetMap, isWalkable, TILE } from '../src/engine/index.js';

const idle = () => null;

// BFS 连通性（走地：非墙即可通行）
function reachable(map, from) {
  const seen = new Set([`${from.x},${from.y}`]);
  const q = [from];
  while (q.length) {
    const { x, y } = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const k = `${nx},${ny}`;
      if (!seen.has(k) && isWalkable(map, nx, ny)) { seen.add(k); q.push({ x: nx, y: ny }); }
    }
  }
  return seen;
}

test('预置地图库：恰好 10 张，id/名称唯一', () => {
  assert.equal(PRESET_MAPS.length, 10);
  assert.equal(new Set(PRESET_MAPS.map((m) => m.id)).size, 10);
  assert.equal(new Set(PRESET_MAPS.map((m) => m.name)).size, 10);
  for (const m of PRESET_MAPS) {
    assert.ok(m.id && m.name && m.desc, `${m.id}: 需有 id/name/desc`);
  }
});

test('每张图：17x17、四周封墙、A/B 出生点齐全', () => {
  for (const { id } of PRESET_MAPS) {
    const map = presetMap(id);
    assert.equal(map.width, 17, `${id}: 宽应 17`);
    assert.equal(map.height, 17, `${id}: 高应 17`);
    for (let x = 0; x < 17; x++) {
      assert.equal(map.tiles[0][x], TILE.WALL, `${id}: 顶边 (${x},0) 应为墙`);
      assert.equal(map.tiles[16][x], TILE.WALL, `${id}: 底边 (${x},16) 应为墙`);
    }
    for (let y = 0; y < 17; y++) {
      assert.equal(map.tiles[y][0], TILE.WALL, `${id}: 左边 (0,${y}) 应为墙`);
      assert.equal(map.tiles[y][16], TILE.WALL, `${id}: 右边 (16,${y}) 应为墙`);
    }
    assert.ok(map.spawns[0] && map.spawns[1], `${id}: 需有 A/B 出生点`);
    const [a, b] = map.spawns;
    assert.ok(a.x + b.x === 16 && a.y + b.y === 16, `${id}: 出生点应点对称（公平）`);
  }
});

test('每张图：A→B、A→每颗星全部连通，星 ≥3 且落在可走格、不压出生点', () => {
  for (const { id } of PRESET_MAPS) {
    const map = presetMap(id);
    const seen = reachable(map, map.spawns[0]);
    assert.ok(seen.has(`${map.spawns[1].x},${map.spawns[1].y}`), `${id}: A→B 应连通`);
    assert.ok(map.stars.length >= 3, `${id}: 星应 ≥3，实际 ${map.stars.length}`);
    for (const s of map.stars) {
      assert.ok(isWalkable(map, s.x, s.y), `${id}: 星 (${s.x},${s.y}) 应在可走格`);
      assert.ok(seen.has(`${s.x},${s.y}`), `${id}: 星 (${s.x},${s.y}) 应可达`);
      assert.ok(
        !map.spawns.some((p) => p.x === s.x && p.y === s.y),
        `${id}: 星 (${s.x},${s.y}) 不应压出生点`,
      );
    }
  }
});

test('presetMap 每次返回新对象（引擎摧毁土堆不污染模板）；未知 id 返回 null', () => {
  const a = presetMap(PRESET_MAPS[0].id);
  const b = presetMap(PRESET_MAPS[0].id);
  assert.notEqual(a, b);
  a.tiles[1][1] = TILE.WALL;
  assert.notEqual(b.tiles[1][1], TILE.WALL, '模板不应被上一次取图的改动污染');
  assert.equal(presetMap('no-such-map'), null);
});

test('每张图跑一局冒烟 + 确定性重放（同 seed 同图逐字节一致）', () => {
  const A = (api) => (api.enemyVisible() && api.canFire() ? api.fireAt(api.enemy()) : api.patrol());
  const B = (api) => { const s = api.nearestStar(); return s ? api.moveTo(s) : api.patrol(); };
  for (const { id } of PRESET_MAPS) {
    const r1 = runMatch({ seed: 7, map: presetMap(id), botA: A, botB: B, maxTicks: 150 });
    const r2 = runMatch({ seed: 7, map: presetMap(id), botA: A, botB: B, maxTicks: 150 });
    assert.equal(JSON.stringify(r1), JSON.stringify(r2), `${id}: 同 seed 同图应逐字节一致`);
    assert.ok(r1.ticks > 0 && Array.isArray(r1.events), `${id}: 对局应正常产出`);
  }
});
