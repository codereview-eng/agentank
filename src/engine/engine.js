// AgenTank 核心：tick 制确定性模拟。
// 每 tick：计时器递减 → 星星补刷 → 视野更新 → 双方基于同一快照 decide → 按 0、1 顺序裁决动作。
// 击杀即胜；到达 maxTicks 比吃星数；再平则平局。
import { mulberry32, randInt } from './rng.js';
import { generateMap, cloneMap, inBounds, isWalkable, tileAt, blocksBullet, TILE } from './map.js';

export const RULES = {
  maxTicks: 900,
  hp: 100,
  damage: 20,
  fireRange: 7,
  fireCd: 5,
  cloakDur: 25,
  cloakCd: 90,
  teleportCd: 100,
  stunRange: 3,
  stunDur: 8,
  stunCd: 60,
  starRespawn: 60,
  maxFieldStars: 3,
};

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

// 目标相对坦克的主轴四向（|dx|>=|dy| 取水平，平手时水平优先，保证确定性）
function cardinalTo(T, tx, ty) {
  const dx = tx - T.x;
  const dy = ty - T.y;
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return [dx > 0 ? 1 : -1, 0];
  return [0, dy > 0 ? 1 : -1];
}

// 视野规则：敌方隐身技能生效 ⇒ 不可见；敌方在草丛且曼哈顿距离>1 ⇒ 不可见；其余可见。
function visibleTo(state, viewer) {
  const T = state.tanks[viewer];
  const E = state.tanks[1 - viewer];
  if (E.cloak > 0) return false;
  if (tileAt(state.map, E.x, E.y) === TILE.GRASS && manhattan(T, E) > 1) return false;
  return true;
}

// BFS 单步寻路：从目标反向做距离场，取严格更近的相邻格；敌方所在格视为不可穿越。
function nextStep(state, T, E, tx, ty) {
  const m = state.map;
  if (T.x === tx && T.y === ty) return null;
  if (!isWalkable(m, tx, ty)) return null;
  const W = m.width;
  const H = m.height;
  const dist = new Int32Array(W * H).fill(-1);
  const q = [ty * W + tx];
  dist[q[0]] = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    const cx = c % W;
    const cy = (c - cx) / W;
    const d = dist[c];
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!isWalkable(m, nx, ny)) continue;
      if (nx === E.x && ny === E.y) continue;
      const nc = ny * W + nx;
      if (dist[nc] !== -1) continue;
      dist[nc] = d + 1;
      q.push(nc);
    }
  }
  const cur = dist[T.y * W + T.x];
  if (cur === -1) return null;
  let best = null;
  let bd = cur;
  for (const [dx, dy] of DIRS) {
    const nx = T.x + dx;
    const ny = T.y + dy;
    if (!isWalkable(m, nx, ny)) continue;
    if (nx === E.x && ny === E.y) continue;
    const d = dist[ny * W + nx];
    if (d !== -1 && d < bd) { bd = d; best = { x: nx, y: ny }; }
  }
  return best;
}

function nearestOf(T, cells) {
  let best = null;
  let bd = Infinity;
  for (const c of cells) {
    const d = Math.abs(T.x - c.x) + Math.abs(T.y - c.y);
    if (d < bd) { bd = d; best = c; }
  }
  return best ? { x: best.x, y: best.y } : null;
}

function makeApi(state, i) {
  const R = state.R;
  const T = state.tanks[i];
  const E = state.tanks[1 - i];
  const visible = visibleTo(state, i);
  return {
    // 状态查询
    me: () => ({ x: T.x, y: T.y, hp: T.hp, stars: T.stars, cloaked: T.cloak > 0, stunned: T.stun > 0, facing: { dx: T.facing[0], dy: T.facing[1] } }),
    enemy: () => ({ x: T.lastSeen.x, y: T.lastSeen.y, visible }),
    enemyVisible: () => visible,
    canFire: () => T.cd.fire <= 0,
    ready: (name) => (T.cd[name] ?? Infinity) <= 0,
    tick: () => state.t,
    rules: () => ({ ...R }),
    mapSize: () => ({ width: state.map.width, height: state.map.height }),
    inGrass: () => tileAt(state.map, T.x, T.y) === TILE.GRASS,
    distTo: (p) => (p ? Math.abs(T.x - p.x) + Math.abs(T.y - p.y) : Infinity),
    rand: () => T.rng(),
    // 寻路目标查询
    nearestStar: () => nearestOf(T, state.stars),
    nearestGrass: () => {
      const cells = [];
      for (let y = 1; y < state.map.height - 1; y++) {
        for (let x = 1; x < state.map.width - 1; x++) {
          if (state.map.tiles[y][x] === TILE.GRASS) cells.push({ x, y });
        }
      }
      return nearestOf(T, cells);
    },
    safestCorner: () => {
      const m = state.map;
      const corners = [
        { x: 1, y: 1 }, { x: m.width - 2, y: 1 },
        { x: 1, y: m.height - 2 }, { x: m.width - 2, y: m.height - 2 },
      ].filter((c) => isWalkable(m, c.x, c.y) && !(c.x === E.x && c.y === E.y));
      let best = null;
      let bd = -1;
      for (const c of corners) {
        const d = Math.abs(c.x - T.lastSeen.x) + Math.abs(c.y - T.lastSeen.y);
        if (d > bd) { bd = d; best = c; }
      }
      return best ? { x: best.x, y: best.y } : null;
    },
    // 动作构造（返回值交回引擎裁决合法性）
    fireAt: (p) => (p ? { type: 'fire', x: p.x | 0, y: p.y | 0 } : null),
    moveTo: (p) => (p ? { type: 'move', x: p.x | 0, y: p.y | 0 } : null),
    patrol: () => ({ type: 'patrol' }),
    teleport: (p) => (p ? { type: 'teleport', x: p.x | 0, y: p.y | 0 } : null),
    cloak: () => ({ type: 'cloak' }),
    stun: () => ({ type: 'stun' }),
  };
}

function pickupStar(state, i, ev) {
  const T = state.tanks[i];
  const idx = state.stars.findIndex((s) => s.x === T.x && s.y === T.y);
  if (idx === -1) return;
  const s = state.stars.splice(idx, 1)[0];
  T.stars += 1;
  ev({ t: state.t, type: 'star', who: i, x: s.x, y: s.y, total: T.stars });
}

function maybeGoal(state, i, tx, ty, ev) {
  const T = state.tanks[i];
  const k = tx + ',' + ty;
  if (T.goalKey === k) return;
  T.goalKey = k;
  let tag = 'pos';
  if (state.stars.some((s) => s.x === tx && s.y === ty)) tag = 'star';
  else if (T.lastSeen.x === tx && T.lastSeen.y === ty) tag = 'enemy';
  ev({ t: state.t, type: 'goal', who: i, x: tx, y: ty, tag });
}

function fireBullet(state, i, dx, dy, ev) {
  const R = state.R;
  const T = state.tanks[i];
  const E = state.tanks[1 - i];
  const t = state.t;
  // 炮弹只沿炮口方向直线飞行（水平/垂直），至射程上限
  let x = T.x;
  let y = T.y;
  let traveled = 0;
  while (traveled < R.fireRange) {
    x += dx;
    y += dy;
    traveled++;
    if (!inBounds(state.map, x, y)) { ev({ t, type: 'bullet_end', who: i, x, y, cause: 'range' }); return; }
    const tile = tileAt(state.map, x, y);
    if (blocksBullet(tile)) { ev({ t, type: 'bullet_end', who: i, x, y, cause: tile }); return; }
    if (E.hp > 0 && E.x === x && E.y === y) {
      E.hp -= R.damage;
      ev({ t, type: 'hit', who: i, target: 1 - i, dmg: R.damage, hp: E.hp, x, y });
      ev({ t, type: 'bullet_end', who: i, x, y, cause: 'hit' });
      return;
    }
  }
  ev({ t, type: 'bullet_end', who: i, x, y, cause: 'range' });
}

function applyAction(state, i, a, ev) {
  const R = state.R;
  const T = state.tanks[i];
  const E = state.tanks[1 - i];
  const t = state.t;
  if (T.hp <= 0) return;
  if (T.stun > 0) return; // 眩晕中：动作作废
  if (!a || typeof a !== 'object' || typeof a.type !== 'string') return; // 空/非法动作 = 待机
  switch (a.type) {
    case 'move': {
      const tx = a.x | 0;
      const ty = a.y | 0;
      maybeGoal(state, i, tx, ty, ev);
      const step = nextStep(state, T, E, tx, ty);
      if (step) {
        T.facing = [step.x - T.x, step.y - T.y]; // 车体带动炮口转向行进方向
        T.x = step.x;
        T.y = step.y;
        ev({ t, type: 'move', who: i, x: T.x, y: T.y });
        pickupStar(state, i, ev);
      }
      break;
    }
    case 'patrol': {
      const opts = [];
      for (const [dx, dy] of DIRS) {
        const nx = T.x + dx;
        const ny = T.y + dy;
        if (!isWalkable(state.map, nx, ny)) continue;
        if (nx === E.x && ny === E.y) continue;
        opts.push({ x: nx, y: ny });
      }
      if (opts.length) {
        const p = opts[randInt(T.rng, opts.length)];
        T.facing = [p.x - T.x, p.y - T.y];
        T.x = p.x;
        T.y = p.y;
        ev({ t, type: 'move', who: i, x: T.x, y: T.y });
        pickupStar(state, i, ev);
      }
      break;
    }
    case 'fire': {
      if (T.cd.fire > 0) break;
      const tx = a.x | 0;
      const ty = a.y | 0;
      const dir = cardinalTo(T, tx, ty);
      if (!dir) break; // 朝自己开火视为非法
      // 炮口硬规则：只能沿水平/垂直方向开炮；炮口未对准时本拍先转向，下一拍才能射击
      if (T.facing[0] !== dir[0] || T.facing[1] !== dir[1]) {
        T.facing = dir;
        ev({ t, type: 'turn', who: i, dx: dir[0], dy: dir[1] });
        break;
      }
      T.cd.fire = R.fireCd;
      if (T.cloak > 0) T.cloak = 0; // 开火打破隐身
      ev({ t, type: 'fire', who: i, x: T.x, y: T.y, dx: dir[0], dy: dir[1] });
      E.lastSeen = { x: T.x, y: T.y }; // 开火暴露自身位置
      fireBullet(state, i, dir[0], dir[1], ev);
      break;
    }
    case 'teleport': {
      if (T.cd.teleport > 0) break;
      const tx = a.x | 0;
      const ty = a.y | 0;
      if (!isWalkable(state.map, tx, ty)) break;
      if (E.x === tx && E.y === ty) break;
      T.cd.teleport = R.teleportCd;
      T.x = tx;
      T.y = ty;
      ev({ t, type: 'skill', who: i, name: 'teleport', x: tx, y: ty });
      pickupStar(state, i, ev);
      break;
    }
    case 'cloak': {
      if (T.cd.cloak > 0) break;
      T.cd.cloak = R.cloakCd;
      T.cloak = R.cloakDur;
      ev({ t, type: 'skill', who: i, name: 'cloak', duration: R.cloakDur });
      break;
    }
    case 'stun': {
      if (T.cd.stun > 0) break;
      const cheb = Math.max(Math.abs(T.x - E.x), Math.abs(T.y - E.y));
      if (cheb > R.stunRange) break; // 不在范围内：不生效也不进冷却
      T.cd.stun = R.stunCd;
      E.stun = R.stunDur;
      ev({ t, type: 'skill', who: i, name: 'stun' });
      ev({ t, type: 'stun_hit', who: i, target: 1 - i, duration: R.stunDur });
      break;
    }
    default:
      break;
  }
}

function randomFreeCell(state) {
  const m = state.map;
  for (let tries = 0; tries < 50; tries++) {
    const x = 1 + randInt(state.rng, m.width - 2);
    const y = 1 + randInt(state.rng, m.height - 2);
    if (!isWalkable(m, x, y)) continue;
    if (state.tanks.some((T) => T.x === x && T.y === y)) continue;
    if (state.stars.some((s) => s.x === x && s.y === y)) continue;
    return { x, y };
  }
  return null;
}

export function runMatch(opts = {}) {
  const { seed = 1, botA, botB, map = null } = opts;
  const R = { ...RULES, ...(opts.rules || {}) };
  if (opts.maxTicks != null) R.maxTicks = opts.maxTicks;
  const rng = mulberry32(seed >>> 0);
  const m = map ? cloneMap(map) : generateMap(rng);
  const state = {
    R,
    rng,
    map: m,
    t: 0,
    stars: m.stars.map((s) => ({ x: s.x, y: s.y })),
    events: [],
    bots: [botA, botB],
    tanks: m.spawns.map((s, i) => ({
      i,
      x: s.x,
      y: s.y,
      hp: R.hp,
      stars: 0,
      facing: i === 0 ? [1, 0] : [-1, 0], // 炮口四向朝向：P1 朝右、P2 朝左
      cd: { fire: 0, teleport: 0, cloak: 0, stun: 0 },
      cloak: 0,
      stun: 0,
      lastSeen: { x: m.spawns[1 - i].x, y: m.spawns[1 - i].y },
      goalKey: null,
      rng: mulberry32((seed + 0x9e3779b9 * (i + 1)) >>> 0),
    })),
  };
  const ev = (e) => state.events.push(e);
  ev({ t: 0, type: 'start', seed, width: m.width, height: m.height });

  let ended = null;
  for (let t = 0; t < R.maxTicks && !ended; t++) {
    state.t = t;
    // 1. 计时器
    for (const T of state.tanks) {
      for (const k of Object.keys(T.cd)) if (T.cd[k] > 0) T.cd[k]--;
      if (T.cloak > 0) T.cloak--;
      if (T.stun > 0) T.stun--;
    }
    // 2. 星星补刷
    if (t > 0 && t % R.starRespawn === 0 && state.stars.length < R.maxFieldStars) {
      const p = randomFreeCell(state);
      if (p) { state.stars.push(p); ev({ t, type: 'star_spawn', x: p.x, y: p.y }); }
    }
    // 3. 视野与最后目击位置
    for (const i of [0, 1]) {
      if (visibleTo(state, i)) {
        const E = state.tanks[1 - i];
        state.tanks[i].lastSeen = { x: E.x, y: E.y };
      }
    }
    // 4. 双方基于同一快照决策（决策阶段不改状态）
    const actions = [0, 1].map((i) => {
      try {
        return state.bots[i](makeApi(state, i));
      } catch {
        return null; // 策略脚本抛错 = 本拍待机
      }
    });
    // 5. 按固定顺序裁决
    for (const i of [0, 1]) {
      if (ended) break;
      applyAction(state, i, actions[i], ev);
      const dead = state.tanks.find((T) => T.hp <= 0);
      if (dead) {
        ev({ t, type: 'death', who: dead.i });
        ended = { winner: 1 - dead.i, reason: 'kill' };
      }
    }
  }

  const [a, b] = state.tanks;
  if (!ended) {
    ended = a.stars === b.stars
      ? { winner: null, reason: 'draw' }
      : { winner: a.stars > b.stars ? 0 : 1, reason: 'stars' };
  }
  ev({
    t: state.t,
    type: 'end',
    winner: ended.winner,
    reason: ended.reason,
    stars: [a.stars, b.stars],
    hp: [a.hp, b.hp],
  });
  return {
    events: state.events,
    winner: ended.winner,
    reason: ended.reason,
    stars: [a.stars, b.stars],
    ticks: state.t + 1,
    seed,
  };
}
