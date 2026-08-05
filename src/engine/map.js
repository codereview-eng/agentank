// 地图：格子地形。
// wall  墙   —— 挡子弹 + 挡坦克
// dirt  土堆 —— 挡子弹，坦克可通行
// grass 草丛 —— 站入后对距离>1 的敌人隐身，不挡弹不挡身
// empty 空地
import { randInt } from './rng.js';

export const TILE = { EMPTY: 'empty', WALL: 'wall', DIRT: 'dirt', GRASS: 'grass' };

export function inBounds(map, x, y) {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function tileAt(map, x, y) {
  return map.tiles[y][x];
}

export function isWalkable(map, x, y) {
  return inBounds(map, x, y) && map.tiles[y][x] !== TILE.WALL;
}

export function blocksBullet(tile) {
  return tile === TILE.WALL || tile === TILE.DIRT;
}

export function cloneMap(m) {
  return {
    width: m.width,
    height: m.height,
    tiles: m.tiles.map((row) => row.slice()),
    spawns: m.spawns.map((s) => ({ x: s.x, y: s.y })),
    stars: m.stars.map((s) => ({ x: s.x, y: s.y })),
  };
}

// ASCII 建图（测试/自定义用）：
// '#'=墙 'D'=土堆 'g'=草丛 '*'=星星 'A'/'B'=出生点 'a'/'b'=草丛上的出生点 '.'或' '=空地
export function mapFromAscii(rows) {
  const height = rows.length;
  const width = rows[0].length;
  const tiles = [];
  const stars = [];
  const spawns = [null, null];
  for (let y = 0; y < height; y++) {
    const row = [];
    for (let x = 0; x < width; x++) {
      const c = rows[y][x];
      let tile = TILE.EMPTY;
      if (c === '#') tile = TILE.WALL;
      else if (c === 'D') tile = TILE.DIRT;
      else if (c === 'g') tile = TILE.GRASS;
      else if (c === '*') stars.push({ x, y });
      else if (c === 'A') spawns[0] = { x, y };
      else if (c === 'B') spawns[1] = { x, y };
      else if (c === 'a') { spawns[0] = { x, y }; tile = TILE.GRASS; }
      else if (c === 'b') { spawns[1] = { x, y }; tile = TILE.GRASS; }
      row.push(tile);
    }
    tiles.push(row);
  }
  if (!spawns[0] || !spawns[1]) throw new Error('mapFromAscii: 需要 A/B 出生点');
  return { width, height, tiles, spawns, stars };
}

function connected(map, from, targets) {
  const { width: W, height: H } = map;
  const seen = new Uint8Array(W * H);
  const q = [from.y * W + from.x];
  seen[q[0]] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    const cx = c % W;
    const cy = (c - cx) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(map, nx, ny)) continue;
      const nc = ny * W + nx;
      if (!seen[nc]) { seen[nc] = 1; q.push(nc); }
    }
  }
  return targets.every((t) => seen[t.y * W + t.x] === 1);
}

// 点对称随机地图：公平（两侧地形镜像），带连通性校验，失败重试，最终退化为空旷图。
export function generateMap(rng, { width = 17, height = 17, starCount = 6 } = {}) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const tiles = Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) =>
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ? TILE.WALL : null,
      ),
    );
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        if (tiles[y][x] !== null) continue;
        const r = rng();
        const tile = r < 0.08 ? TILE.WALL : r < 0.16 ? TILE.DIRT : r < 0.28 ? TILE.GRASS : TILE.EMPTY;
        tiles[y][x] = tile;
        const my = height - 1 - y;
        const mx = width - 1 - x;
        if (tiles[my][mx] === null) tiles[my][mx] = tile;
      }
    }
    const spawns = [{ x: 1, y: 1 }, { x: width - 2, y: height - 2 }];
    for (const s of spawns) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = s.x + dx;
          const ny = s.y + dy;
          if (nx >= 1 && ny >= 1 && nx <= width - 2 && ny <= height - 2) tiles[ny][nx] = TILE.EMPTY;
        }
      }
    }
    const map = { width, height, tiles, spawns, stars: [] };
    const half = Math.floor(starCount / 2);
    let guard = 0;
    while (map.stars.length < half * 2 && guard++ < 500) {
      const x = 1 + randInt(rng, width - 2);
      const y = 1 + randInt(rng, height - 2);
      const mx = width - 1 - x;
      const my = height - 1 - y;
      if (x === mx && y === my) continue;
      if (tiles[y][x] === TILE.WALL || tiles[my][mx] === TILE.WALL) continue;
      const nearSpawn = spawns.some((s) => Math.abs(s.x - x) + Math.abs(s.y - y) <= 2 || Math.abs(s.x - mx) + Math.abs(s.y - my) <= 2);
      if (nearSpawn) continue;
      if (map.stars.some((s) => (s.x === x && s.y === y) || (s.x === mx && s.y === my))) continue;
      map.stars.push({ x, y }, { x: mx, y: my });
    }
    if (map.stars.length === half * 2 && connected(map, spawns[0], [spawns[1], ...map.stars])) {
      return map;
    }
  }
  // 退化兜底：空旷图 + 固定对称星星（仍确定性）
  const tiles = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) =>
      x === 0 || y === 0 || x === width - 1 || y === height - 1 ? TILE.WALL : TILE.EMPTY,
    ),
  );
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  const stars = [
    { x: cx - 3, y: cy }, { x: cx + 3, y: cy },
    { x: cx, y: cy - 3 }, { x: cx, y: cy + 3 },
    { x: cx - 5, y: cy - 5 }, { x: cx + 5, y: cy + 5 },
  ].filter((s) => s.x >= 1 && s.y >= 1 && s.x <= width - 2 && s.y <= height - 2);
  return { width, height, tiles, spawns: [{ x: 1, y: 1 }, { x: width - 2, y: height - 2 }], stars };
}
