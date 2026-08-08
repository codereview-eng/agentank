// AgenTank 核心：tick 制确定性模拟。
// 每 tick 结算顺序（测试锁死）：
//   1 计时器递减 → 2 星星重生 → 2.5 缩圈（吞没圈外星星/道具）→ 2.6 道具刷新 → 3 推进已有子弹 → 4 超载自动补射
//   → 5 视野更新 → 6 双方基于同一快照 decide → 7 按 0、1 顺序裁决动作
//   → 8 持续效果（炸弹引信/中毒/毒圈伤害）
// 终局判定链（超时与同拍双亡通用，杜绝平局）：
//   击杀 → 星数 → 剩余 HP → 累计输出伤害 → 距圈心近者 → 种子掷签（coin，确定性）。
import { mulberry32, randInt } from './rng.js';
import { generateMap, cloneMap, inBounds, isWalkable, tileAt, TILE } from './map.js';

// ===== RULES 常量表（全部数值集中于此） =====
export const RULES = {
  maxTicks: 900,
  hp: 100,
  damage: 20,          // 子弹伤害
  bulletSpeed: 2,      // 子弹飞行速度（格/tick）
  fireRange: 7,        // bot 交火参考距离（子弹实际飞行不受此限制）
  fireCd: 5,           // 开火冷却
  bombFuse: 10,        // 炸弹引信（放置后多少 tick 爆炸）
  bombRange: 2,        // 十字冲击波半径
  bombDamage: 45,      // 炸弹伤害（含自伤）
  bombCd: 30,          // 炸弹冷却
  moundHp: 2,          // 土堆被子弹摧毁所需命中数（炸弹一击摧毁）
  starRespawn: 15,     // 星星被吃后重生间隔
  maxFieldStars: 1,    // 场上同时最多星星数
  zone: {              // 缩圈（每局必有）：根治超时平局的核心机制
    start: 240,        // 首次收圈 tick
    every: 30,         // 之后每多少 tick 再收一圈（收到中心 1 格封顶）
    dmg: 5,            // 毒圈基础伤害/tick（无视护盾）
    dmgStep: 1,        // 每多收一圈，毒圈伤害递增量
  },
  items: {             // 场上道具：周期性刷新，开车压过即拾取（先到先得）；缩圈吞没圈外道具
    start: 40,         // 首个道具刷新 tick
    every: 45,         // 之后每多少 tick 再尝试刷一个
    max: 2,            // 场上同时最多道具数
    kinds: ['medkit', 'rapid', 'pierce', 'helmet', 'clock', 'boots'],
    medkit: { heal: 30 },            // 急救包：+30 HP（封顶 hp 上限）
    rapid:  { shots: 3 },            // 双发弹：接下来 3 次开火自动 2 连发（同向补射）
    pierce: { shots: 3, bonus: 10 }, // 穿甲弹：接下来 3 发子弹伤害 +10 且一击摧毁土堆
    helmet: {},                      // 头盔：挡下一次子弹/炸弹伤害（与护盾同槽，消耗即失效）
    clock:  { dur: 6 },              // 时钟：拾取当拍冻结敌人 6 拍
    boots:  { dur: 10 },             // 疾行靴：10 拍内移动每拍 2 格
  },
  skills: {
    shield:   { cd: 60 },                    // 挡下一次子弹/炸弹伤害，消耗即失效
    freeze:   { cd: 90, dur: 8 },            // 冻结：完全不能动/转/开火
    stun:     { cd: 80, dur: 6 },            // 眩晕：移动/转向方向被种子 RNG 随机反转
    overload: { cd: 70 },                    // 下一次开火 2 连发（间隔 1 tick 同向补射）
    cloak:    { cd: 90, dur: 25 },           // 隐身
    poison:   { cd: 80, dur: 10, dmg: 2 },   // 中毒：每 tick -2 HP
    teleport: { cd: 100 },                   // 传送：非法落点重定向到最近合法格
    boost:    { cd: 90, dur: 10 },           // 疾驰：移动动作每拍走 2 格
  },
};
export const SKILLS = Object.keys(RULES.skills);

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ===== 缩圈（安全区） =====
// ring r 的安全区矩形：[1+r, w-2-r] x [1+r, h-2-r]；收到中心 1 格封顶
function zoneRect(state) {
  const m = state.map;
  const r = state.zoneRing;
  return { x0: 1 + r, y0: 1 + r, x1: m.width - 2 - r, y1: m.height - 2 - r };
}

function maxZoneRing(m) {
  return Math.max(0, Math.min(Math.floor((m.width - 3) / 2), Math.floor((m.height - 3) / 2)));
}

function inZone(state, x, y) {
  const z = zoneRect(state);
  return x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
}

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

function bulletsOf(state, i) {
  return state.bullets.filter((b) => b.owner === i);
}

function makeApi(state, i) {
  const R = state.R;
  const T = state.tanks[i];
  const E = state.tanks[1 - i];
  const visible = visibleTo(state, i);
  const inFlight = () => bulletsOf(state, i).length > 0 || !!T.pendingShot;
  return {
    // 状态查询
    me: () => ({
      x: T.x, y: T.y, hp: T.hp, stars: T.stars,
      skill: T.skill,
      cloaked: T.cloak > 0,
      stunned: T.stun > 0,
      frozen: T.freeze > 0,
      poisoned: T.poison > 0,
      boosted: T.boost > 0,
      shielded: T.shield > 0,
      bulletInFlight: inFlight(),
      rapidShots: T.rapidShots,   // 双发弹剩余充能
      pierceShots: T.pierceShots, // 穿甲弹剩余充能
      facing: { dx: T.facing[0], dy: T.facing[1] },
    }),
    enemy: () => ({ x: T.lastSeen.x, y: T.lastSeen.y, visible }),
    enemyVisible: () => visible,
    canFire: () => T.cd.fire <= 0 && !inFlight(),
    // ready()：无参 = 所装备技能；'bomb' = 炸弹；'fire' = 开火；技能名需与装备一致
    ready: (name) => {
      if (name == null || name === T.skill) return T.cd.skill <= 0;
      if (name === 'bomb') return T.cd.bomb <= 0;
      if (name === 'fire') return T.cd.fire <= 0;
      return false;
    },
    skill: () => T.skill,
    tick: () => state.t,
    // 缩圈查询：当前安全区矩形 + 已收圈数 + 下次收圈 tick（收满为 null）
    zone: () => {
      const z = zoneRect(state);
      const nxt = state.zoneRing < maxZoneRing(state.map)
        ? state.R.zone.start + state.zoneRing * state.R.zone.every
        : null;
      return { ring: state.zoneRing, x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1, next: nxt };
    },
    inZone: (p) => (p ? inZone(state, p.x | 0, p.y | 0) : inZone(state, T.x, T.y)),
    rules: () => JSON.parse(JSON.stringify(R)),
    mapSize: () => ({ width: state.map.width, height: state.map.height }),
    inGrass: () => tileAt(state.map, T.x, T.y) === TILE.GRASS,
    walkable: (p) => !!p && isWalkable(state.map, p.x | 0, p.y | 0),
    distTo: (p) => (p ? Math.abs(T.x - p.x) + Math.abs(T.y - p.y) : Infinity),
    rand: () => T.rng(),
    // 子弹查询：自己的子弹始终可查；敌方子弹仅当处于我方炮口 90° 视锥内可见
    myBullet: () => {
      const b = bulletsOf(state, i)[0];
      return b ? { x: b.x, y: b.y, dx: b.dx, dy: b.dy } : null;
    },
    enemyBullet: () => {
      for (const b of state.bullets) {
        if (b.owner === i) continue;
        const rx = b.x - T.x;
        const ry = b.y - T.y;
        const along = rx * T.facing[0] + ry * T.facing[1];
        const perp = Math.abs(rx * T.facing[1] - ry * T.facing[0]);
        if (along > 0 && along >= perp) return { x: b.x, y: b.y, dx: b.dx, dy: b.dy };
      }
      return null;
    },
    // 炸弹查询：场上所有炸弹对双方可见（含草丛中的）
    bombs: () => state.bombs.map((b) => ({
      x: b.x, y: b.y,
      fuse: Math.max(0, b.placedAt + R.bombFuse - state.t),
      mine: b.owner === i,
    })),
    // 寻路目标查询
    nearestStar: () => nearestOf(T, state.stars),
    // 道具查询：场上道具对双方全程可见（含草丛中的）
    items: () => state.items.map((s) => ({ x: s.x, y: s.y, kind: s.kind })),
    nearestItem: (kind) => nearestOf(T, kind ? state.items.filter((s) => s.kind === kind) : state.items),
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
      const z = zoneRect(state); // 只在安全区四角里挑，避免把人送进毒圈
      const corners = [
        { x: z.x0, y: z.y0 }, { x: z.x1, y: z.y0 },
        { x: z.x0, y: z.y1 }, { x: z.x1, y: z.y1 },
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
    useSkill: (p) => (p && typeof p.x === 'number' ? { type: 'skill', x: p.x | 0, y: p.y | 0 } : { type: 'skill' }),
    throwBomb: () => ({ type: 'bomb' }),
    // 旧入口：映射到所装备技能，未装备 = 非法动作 no-op
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
  if (state.stars.length === 0) state.starRespawnAt = state.t + state.R.starRespawn;
}

// ===== 场上道具 =====
// 开车压过即拾取（先到先得），效果立即生效；kind 语义见 RULES.items 注释。
function pickupItem(state, i, ev) {
  const T = state.tanks[i];
  const idx = state.items.findIndex((s) => s.x === T.x && s.y === T.y);
  if (idx === -1) return;
  const R = state.R;
  const it = state.items.splice(idx, 1)[0];
  // 注册表分发：内置道具与内容包道具同一条路——按效果原语（kind）+ 注册表参数结算
  const def = state.itemDefs[it.kind];
  const e = { t: state.t, type: 'item_pick', who: i, kind: it.kind, x: it.x, y: it.y };
  switch (def.kind) {
    case 'heal':
      T.hp = Math.min(R.hp, T.hp + def.heal);
      e.hp = T.hp;
      break;
    case 'rapid':
      T.rapidShots += def.shots;
      break;
    case 'pierce':
      T.pierceShots += def.shots;
      T.pierceBonus = def.bonus; // 自定义穿甲道具可改伤害加成
      break;
    case 'shield':
      T.shield = 1; // 与护盾技能同槽：挡下一次伤害，消耗即失效
      break;
    case 'freeze': { // 拾取当拍冻结敌人（复用 freeze 渲染/战报口径，source 标记来源道具）
      const E = state.tanks[1 - i];
      E.freeze = Math.max(E.freeze, def.dur);
      ev(e);
      ev({ t: state.t, type: 'freeze_hit', who: i, target: E.i, duration: def.dur, source: it.kind });
      return;
    }
    case 'boost':
      T.boost = Math.max(T.boost, def.dur);
      break;
    default:
      break;
  }
  ev(e);
}

// 道具落点合法性：可走格 + 安全区内 + 不叠星星/道具（随机刷新另避坦克，定点投放允许压在车位上→当拍即拾取）
function legalItemCell(state, x, y) {
  return isWalkable(state.map, x, y) && inZone(state, x, y)
    && !state.stars.some((s) => s.x === x && s.y === y)
    && !state.items.some((s) => s.x === x && s.y === y);
}

function spawnItem(state, ev) {
  const R = state.R;
  let p = null;
  if (R.items.forceAt) { // 定点投放（测试/调试用）：非法落点按曼哈顿距离重定向到最近合法空格
    const fx = R.items.forceAt.x | 0;
    const fy = R.items.forceAt.y | 0;
    if (legalItemCell(state, fx, fy)) p = { x: fx, y: fy };
    else {
      let best = null;
      let bd = Infinity;
      for (let y = 1; y < state.map.height - 1; y++) {
        for (let x = 1; x < state.map.width - 1; x++) {
          if (!legalItemCell(state, x, y)) continue;
          if (state.tanks.some((T) => T.x === x && T.y === y)) continue;
          const d = Math.abs(x - fx) + Math.abs(y - fy);
          if (d < bd) { bd = d; best = { x, y }; }
        }
      }
      p = best;
    }
  } else {
    p = randomFreeCell(state);
  }
  if (!p) return;
  const kind = R.items.kinds[randInt(state.rng, R.items.kinds.length)];
  state.items.push({ x: p.x, y: p.y, kind });
  ev({ t: state.t, type: 'item_spawn', kind, x: p.x, y: p.y });
  for (const T of state.tanks) if (T.hp > 0) pickupItem(state, T.i, ev); // 投放可能正落在车位：当拍即拾取
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

// 眩晕：移动/转向方向有 50% 概率被反转（走受害者自己的种子 RNG）
function maybeInvertDir(T, dir) {
  if (T.stun > 0 && T.rng() < 0.5) return [-dir[0], -dir[1]];
  return dir;
}

// 出膛：生成飞行子弹实体 + fire 事件；开火打破隐身并暴露位置
// 穿甲弹充能时：本发子弹带 pierce 标记与伤害加成（一击摧毁土堆）
function spawnBullet(state, i, dx, dy, ev) {
  const T = state.tanks[i];
  const E = state.tanks[1 - i];
  if (T.cloak > 0) T.cloak = 0;
  const b = { owner: i, x: T.x, y: T.y, dx, dy };
  if (T.pierceShots > 0) {
    T.pierceShots--;
    b.pierce = true;
    b.dmg = state.R.damage + (T.pierceBonus ?? state.R.items.pierce.bonus);
  }
  state.bullets.push(b);
  ev({ t: state.t, type: 'fire', who: i, x: T.x, y: T.y, dx, dy });
  E.lastSeen = { x: T.x, y: T.y };
}

// 子弹伤害入口（护盾优先消耗）；穿甲弹带伤害加成
function damageByBullet(state, b, K, ev) {
  const R = state.R;
  if (K.shield > 0) {
    K.shield = 0;
    ev({ t: state.t, type: 'shield_block', who: K.i, source: 'bullet' });
    return;
  }
  const dmg = b.dmg ?? R.damage;
  K.hp -= dmg;
  state.tanks[b.owner].dmgDealt += dmg;
  ev({ t: state.t, type: 'hit', who: b.owner, target: K.i, dmg, hp: K.hp, x: K.x, y: K.y });
}

// 子弹进入某格的结算；返回 true 表示子弹终结
function resolveBulletCell(state, b, ev) {
  const t = state.t;
  const m = state.map;
  if (!inBounds(m, b.x, b.y)) {
    ev({ t, type: 'bullet_end', who: b.owner, x: b.x, y: b.y, reason: 'out' });
    return true;
  }
  const tile = tileAt(m, b.x, b.y);
  if (tile === TILE.WALL) {
    ev({ t, type: 'bullet_end', who: b.owner, x: b.x, y: b.y, reason: 'wall' });
    return true;
  }
  if (tile === TILE.DIRT) {
    const key = b.x + ',' + b.y;
    const hp = b.pierce ? 0 : (state.moundHp.get(key) ?? state.R.moundHp) - 1; // 穿甲弹一击摧毁土堆
    ev({ t, type: 'mound_hit', x: b.x, y: b.y, hp: Math.max(0, hp) });
    if (hp <= 0) {
      state.moundHp.delete(key);
      m.tiles[b.y][b.x] = TILE.EMPTY;
      ev({ t, type: 'mound_destroyed', x: b.x, y: b.y });
    } else {
      state.moundHp.set(key, hp);
    }
    ev({ t, type: 'bullet_end', who: b.owner, x: b.x, y: b.y, reason: 'mound' });
    return true;
  }
  // 子弹不伤及发射者本人（穿过自身）：避免“超载补射 + 同向前进”走进自己弹道的退化自伤
  const K = state.tanks.find((T) => T.i !== b.owner && T.hp > 0 && T.x === b.x && T.y === b.y);
  if (K) {
    damageByBullet(state, b, K, ev);
    ev({ t, type: 'bullet_end', who: b.owner, x: b.x, y: b.y, reason: 'hit' });
    return true;
  }
  return false;
}

// 每 tick 推进所有在飞子弹（先于双方动作）
function advanceBullets(state, ev) {
  const R = state.R;
  const remaining = [];
  for (const b of state.bullets) {
    let ended = false;
    for (let s = 0; s < R.bulletSpeed && !ended; s++) {
      b.x += b.dx;
      b.y += b.dy;
      ended = resolveBulletCell(state, b, ev);
    }
    if (!ended) remaining.push(b);
  }
  state.bullets = remaining;
}

// 十字冲击波：墙截断传播；土堆被一击摧毁且截断其后传播
function explodeBomb(state, bomb, ev) {
  const R = state.R;
  const m = state.map;
  const t = state.t;
  const cells = [{ x: bomb.x, y: bomb.y }];
  for (const [dx, dy] of DIRS) {
    for (let r = 1; r <= R.bombRange; r++) {
      const x = bomb.x + dx * r;
      const y = bomb.y + dy * r;
      if (!inBounds(m, x, y)) break;
      const tile = tileAt(m, x, y);
      if (tile === TILE.WALL) break;
      cells.push({ x, y });
      if (tile === TILE.DIRT) {
        state.moundHp.delete(x + ',' + y);
        m.tiles[y][x] = TILE.EMPTY;
        ev({ t, type: 'mound_destroyed', x, y });
        break;
      }
    }
  }
  const hits = [];
  for (const K of state.tanks) {
    if (K.hp <= 0) continue;
    if (!cells.some((c) => c.x === K.x && c.y === K.y)) continue;
    if (K.shield > 0) {
      K.shield = 0;
      ev({ t, type: 'shield_block', who: K.i, source: 'bomb' });
      continue;
    }
    K.hp -= R.bombDamage;
    if (K.i !== bomb.owner) state.tanks[bomb.owner].dmgDealt += R.bombDamage; // 自伤不计输出
    hits.push({ who: K.i, dmg: R.bombDamage });
  }
  ev({ t, type: 'bomb_explode', who: bomb.owner, x: bomb.x, y: bomb.y, cells, hits });
}

// 传送落点合法性：非墙/土堆/水域/星星格/敌人所在格；非法则重定向到（曼哈顿）最近合法格，确定性扫描
function teleportDest(state, i, tx, ty) {
  const m = state.map;
  tx = Math.max(0, Math.min(m.width - 1, tx));
  ty = Math.max(0, Math.min(m.height - 1, ty));
  const E = state.tanks[1 - i];
  const legal = (x, y) => inBounds(m, x, y)
    && tileAt(m, x, y) !== TILE.WALL && tileAt(m, x, y) !== TILE.DIRT && tileAt(m, x, y) !== TILE.WATER
    && inZone(state, x, y) // 传送不能落在毒圈里
    && !state.stars.some((s) => s.x === x && s.y === y)
    && !(E.x === x && E.y === y);
  if (legal(tx, ty)) return { x: tx, y: ty };
  const maxD = m.width + m.height;
  for (let d = 1; d <= maxD; d++) {
    for (let dy = -d; dy <= d; dy++) {
      const rem = d - Math.abs(dy);
      for (const dx of rem === 0 ? [0] : [-rem, rem]) {
        const x = tx + dx;
        const y = ty + dy;
        if (legal(x, y)) return { x, y };
      }
    }
  }
  return null;
}

// 统一技能施放（useSkill 与旧入口都汇到这里）
function castSkill(state, i, arg, ev) {
  const R = state.R;
  const T = state.tanks[i];
  const E = state.tanks[1 - i];
  const t = state.t;
  const name = T.skill;
  // 注册表分发：内置技能与内容包技能同一条路——cd/dur/dmg 全部来自注册表定义
  const def = state.skillDefs[name];
  const S = { cd: def.cd, ...def.effect };
  if (T.cd.skill > 0) return;
  switch (def.effect.kind) {
    case 'shield': {
      if (T.shield > 0) return;
      T.cd.skill = S.cd;
      T.shield = 1;
      ev({ t, type: 'skill', who: i, name });
      break;
    }
    case 'freeze': {
      if (!visibleTo(state, i)) return;
      T.cd.skill = S.cd;
      E.freeze = S.dur;
      ev({ t, type: 'skill', who: i, name });
      ev({ t, type: 'freeze_hit', who: i, target: 1 - i, duration: S.dur });
      break;
    }
    case 'stun': {
      if (!visibleTo(state, i)) return;
      T.cd.skill = S.cd;
      E.stun = S.dur;
      ev({ t, type: 'skill', who: i, name });
      ev({ t, type: 'stun_hit', who: i, target: 1 - i, duration: S.dur });
      break;
    }
    case 'overload': {
      if (T.overloadArmed) return;
      T.cd.skill = S.cd;
      T.overloadArmed = true;
      ev({ t, type: 'skill', who: i, name });
      break;
    }
    case 'cloak': {
      T.cd.skill = S.cd;
      T.cloak = S.dur;
      ev({ t, type: 'skill', who: i, name, duration: S.dur });
      break;
    }
    case 'poison': {
      if (!visibleTo(state, i)) return;
      T.cd.skill = S.cd;
      E.poison = S.dur;
      E.poisonDmg = S.dmg; // 自定义 poison 技能可改每拍伤害
      E.poisonFrom = i;
      ev({ t, type: 'skill', who: i, name });
      ev({ t, type: 'poison_hit', who: i, target: 1 - i, duration: S.dur });
      break;
    }
    case 'teleport': {
      if (!arg) return;
      const dest = teleportDest(state, i, arg.x | 0, arg.y | 0);
      if (!dest) return;
      T.cd.skill = S.cd;
      T.x = dest.x;
      T.y = dest.y; // 炮口朝向不变
      ev({ t, type: 'skill', who: i, name, x: dest.x, y: dest.y });
      ev({ t, type: 'teleport_reveal', who: i, x: dest.x, y: dest.y });
      E.lastSeen = { x: dest.x, y: dest.y };
      break;
    }
    case 'boost': {
      T.cd.skill = S.cd;
      T.boost = S.dur;
      ev({ t, type: 'skill', who: i, name, duration: S.dur });
      break;
    }
    default:
      break;
  }
}

// 冰面惯性：踏上冰面后沿原方向续滑，直到离开冰面/撞墙/撞水/撞敌才停（滑行途中照常吃星）
function slideOnIce(state, i, dir, ev) {
  const T = state.tanks[i];
  const E = state.tanks[1 - i];
  let guard = state.map.width + state.map.height;
  while (guard-- > 0 && T.hp > 0 && tileAt(state.map, T.x, T.y) === TILE.ICE) {
    const nx = T.x + dir[0];
    const ny = T.y + dir[1];
    if (!isWalkable(state.map, nx, ny) || (nx === E.x && ny === E.y)) break;
    T.x = nx;
    T.y = ny;
    ev({ t: state.t, type: 'slide', who: i, x: nx, y: ny });
    pickupStar(state, i, ev);
    pickupItem(state, i, ev);
  }
}

// 单步移动（含眩晕反转与吃星）；返回是否真的移动了
function moveStep(state, i, tx, ty, ev) {
  const T = state.tanks[i];
  const E = state.tanks[1 - i];
  const step = nextStep(state, T, E, tx, ty);
  if (!step) return false;
  const dir = maybeInvertDir(T, [step.x - T.x, step.y - T.y]);
  T.facing = dir;
  const nx = T.x + dir[0];
  const ny = T.y + dir[1];
  if (!isWalkable(state.map, nx, ny) || (nx === E.x && ny === E.y)) return false; // 反转后撞墙/撞敌：只转向不动
  T.x = nx;
  T.y = ny;
  ev({ t: state.t, type: 'move', who: i, x: T.x, y: T.y });
  pickupStar(state, i, ev);
  pickupItem(state, i, ev);
  slideOnIce(state, i, dir, ev);
  return true;
}

function applyAction(state, i, a, ev) {
  const R = state.R;
  const T = state.tanks[i];
  const E = state.tanks[1 - i];
  const t = state.t;
  if (T.hp <= 0) return;
  if (T.freeze > 0) return; // 冻结中：动作作废（眩晕仍可行动，只是方向被随机反转）
  if (!a || typeof a !== 'object' || typeof a.type !== 'string') return; // 空/非法动作 = 待机
  switch (a.type) {
    case 'move': {
      const tx = a.x | 0;
      const ty = a.y | 0;
      maybeGoal(state, i, tx, ty, ev);
      const steps = T.boost > 0 ? 2 : 1; // 疾驰：每拍 2 格
      for (let s = 0; s < steps; s++) {
        if (!moveStep(state, i, tx, ty, ev)) break;
      }
      break;
    }
    case 'patrol': {
      const steps = T.boost > 0 ? 2 : 1;
      for (let s = 0; s < steps; s++) {
        const opts = [];
        for (const [dx, dy] of DIRS) {
          const nx = T.x + dx;
          const ny = T.y + dy;
          if (!isWalkable(state.map, nx, ny)) continue;
          if (nx === E.x && ny === E.y) continue;
          opts.push({ x: nx, y: ny });
        }
        if (!opts.length) break;
        const p = opts[randInt(T.rng, opts.length)];
        const dir = maybeInvertDir(T, [p.x - T.x, p.y - T.y]);
        T.facing = dir;
        const nx = T.x + dir[0];
        const ny = T.y + dir[1];
        if (!isWalkable(state.map, nx, ny) || (nx === E.x && ny === E.y)) break;
        T.x = nx;
        T.y = ny;
        ev({ t, type: 'move', who: i, x: T.x, y: T.y });
        pickupStar(state, i, ev);
        pickupItem(state, i, ev);
        slideOnIce(state, i, dir, ev);
      }
      break;
    }
    case 'fire': {
      if (T.cd.fire > 0) break;
      if (bulletsOf(state, i).length > 0 || T.pendingShot) break; // 单发在飞：再 fire = 非法动作 no-op
      const dir = cardinalTo(T, a.x | 0, a.y | 0);
      if (!dir) break; // 朝自己开火视为非法
      // 炮口硬规则：只能沿水平/垂直方向开炮；炮口未对准时本拍先转向，下一拍才能射击
      if (T.facing[0] !== dir[0] || T.facing[1] !== dir[1]) {
        const d2 = maybeInvertDir(T, dir);
        T.facing = d2;
        ev({ t, type: 'turn', who: i, dx: d2[0], dy: d2[1] });
        break;
      }
      T.cd.fire = R.fireCd;
      spawnBullet(state, i, dir[0], dir[1], ev);
      if (T.overloadArmed) { // 超载：登记 1 拍后的同向自动补射
        T.overloadArmed = false;
        T.pendingShot = { dx: dir[0], dy: dir[1], delay: 1 };
      } else if (T.rapidShots > 0) { // 双发弹：每次手动开火消耗 1 充能，自动补射第二发
        T.rapidShots--;
        T.pendingShot = { dx: dir[0], dy: dir[1], delay: 1 };
      }
      break;
    }
    case 'bomb': {
      if (T.cd.bomb > 0) break;
      if (state.bombs.some((b) => b.owner === i)) break; // 同时最多 1 枚自己的炸弹
      T.cd.bomb = R.bombCd;
      state.bombs.push({ owner: i, x: T.x, y: T.y, placedAt: t });
      ev({ t, type: 'bomb_place', who: i, x: T.x, y: T.y });
      break;
    }
    case 'skill':
      castSkill(state, i, typeof a.x === 'number' ? { x: a.x, y: a.y } : null, ev);
      break;
    // 旧入口映射：仅当装备对应技能时生效，否则 no-op
    case 'teleport':
      if (T.skill === 'teleport') castSkill(state, i, { x: a.x | 0, y: a.y | 0 }, ev);
      break;
    case 'cloak':
      if (T.skill === 'cloak') castSkill(state, i, null, ev);
      break;
    case 'stun':
      if (T.skill === 'stun') castSkill(state, i, null, ev);
      break;
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
    if (!inZone(state, x, y)) continue; // 星星只在安全区内重生
    if (state.tanks.some((T) => T.x === x && T.y === y)) continue;
    if (state.stars.some((s) => s.x === x && s.y === y)) continue;
    if (state.items.some((s) => s.x === x && s.y === y)) continue;
    return { x, y };
  }
  return null;
}

// 终局判定链（超时与同拍双亡通用）：星数 → 剩余 HP → 累计输出伤害 → 距圈心近者 → 种子掷签。
// 链条末端必出胜负——平局被根治，winner 永不为 null。
function resolveEnd(state) {
  const [a, b] = state.tanks;
  if (a.stars !== b.stars) return { winner: a.stars > b.stars ? 0 : 1, reason: 'stars' };
  if (a.hp !== b.hp) return { winner: a.hp > b.hp ? 0 : 1, reason: 'hp' };
  if (a.dmgDealt !== b.dmgDealt) return { winner: a.dmgDealt > b.dmgDealt ? 0 : 1, reason: 'damage' };
  const cx = (state.map.width - 1) / 2;
  const cy = (state.map.height - 1) / 2;
  const da = Math.abs(a.x - cx) + Math.abs(a.y - cy);
  const db = Math.abs(b.x - cx) + Math.abs(b.y - cy);
  if (da !== db) return { winner: da < db ? 0 : 1, reason: 'center' };
  return { winner: state.rng() < 0.5 ? 0 : 1, reason: 'coin' }; // 完全镜像局：种子掷签，确定性
}

// 阵亡判定：单亡 = 对方胜；同拍双亡 = 走终局判定链（不再有平局）
function checkDeath(state, ev) {
  for (const T of state.tanks) {
    if (T.hp <= 0 && !T.deadAnnounced) {
      T.deadAnnounced = true;
      ev({ t: state.t, type: 'death', who: T.i });
    }
  }
  const alive = state.tanks.filter((T) => T.hp > 0);
  if (alive.length === 2) return null;
  if (alive.length === 1) return { winner: alive[0].i, reason: 'kill' };
  return resolveEnd(state);
}

export function runMatch(opts = {}) {
  const { seed = 1, botA, botB, map = null } = opts;
  const R = {
    ...RULES,
    ...(opts.rules || {}),
    skills: { ...RULES.skills, ...((opts.rules || {}).skills || {}) },
    zone: { ...RULES.zone, ...((opts.rules || {}).zone || {}) },
    items: { ...RULES.items, ...((opts.rules || {}).items || {}) },
  };
  if (opts.maxTicks != null) R.maxTicks = opts.maxTicks;
  // ===== UGC 内容包（阶段2 分享/重现凭据）：技能/道具注册表 = 内置 + 内容包条目 =====
  const pack = opts.content ?? null;
  const packOf = (type) => (pack?.entries || []).filter((e) => e.type === type);
  const skillDefs = {};
  for (const [id, S] of Object.entries(R.skills)) skillDefs[id] = { cd: S.cd, effect: { kind: id, dur: S.dur, dmg: S.dmg } };
  for (const d of packOf('skill')) skillDefs[d.id] = { cd: d.cd, effect: { ...d.effect } };
  const itemDefs = {
    medkit: { kind: 'heal', heal: R.items.medkit.heal },
    rapid: { kind: 'rapid', shots: R.items.rapid.shots },
    pierce: { kind: 'pierce', shots: R.items.pierce.shots, bonus: R.items.pierce.bonus },
    helmet: { kind: 'shield' },
    clock: { kind: 'freeze', dur: R.items.clock.dur },
    boots: { kind: 'boost', dur: R.items.boots.dur },
  };
  const packItems = packOf('item');
  for (const d of packItems) itemDefs[d.id] = { ...d.effect };
  // 内容包道具默认并入刷新池（显式传 rules.items.kinds 时以显式为准）
  if (packItems.length && !((opts.rules || {}).items || {}).kinds) {
    R.items = { ...R.items, kinds: [...R.items.kinds, ...packItems.map((d) => d.id)] };
  }
  for (const k of R.items.kinds) {
    if (!itemDefs[k]) throw new Error(`未知道具: ${k}（内置或经内容包注册后方可进刷新池）`);
  }
  // 技能 8 选 1（内容包可扩池）：显式参数 > bot 自带偏好（bot.skill）> 默认 A=teleport、B=cloak
  const skillA = opts.skillA ?? botA?.skill ?? 'teleport';
  const skillB = opts.skillB ?? botB?.skill ?? 'cloak';
  for (const s of [skillA, skillB]) {
    if (!skillDefs[s]) throw new Error(`未知技能: ${s}（内置：${SKILLS.join('/')}，或经内容包注册）`);
  }
  const rng = mulberry32(seed >>> 0);
  const m = map ? cloneMap(map) : generateMap(rng);
  const state = {
    R,
    skillDefs,
    itemDefs,
    rng,
    map: m,
    t: 0,
    stars: m.stars.slice(0, R.maxFieldStars).map((s) => ({ x: s.x, y: s.y })), // 单星：初始截断
    starRespawnAt: null,
    items: [],
    itemSpawnAt: R.items.start,
    zoneRing: 0,
    bullets: [],
    bombs: [],
    moundHp: new Map(),
    events: [],
    bots: [botA, botB],
    tanks: m.spawns.map((s, i) => ({
      i,
      x: s.x,
      y: s.y,
      hp: R.hp,
      stars: 0,
      dmgDealt: 0,
      poisonFrom: null,
      skill: i === 0 ? skillA : skillB,
      facing: i === 0 ? [1, 0] : [-1, 0], // 炮口四向朝向：P1 朝右、P2 朝左
      cd: { fire: 0, skill: 0, bomb: 0 },
      cloak: 0,
      freeze: 0,
      stun: 0,
      poison: 0,
      boost: 0,
      shield: 0,
      rapidShots: 0,
      pierceShots: 0,
      overloadArmed: false,
      pendingShot: null,
      deadAnnounced: false,
      lastSeen: { x: m.spawns[1 - i].x, y: m.spawns[1 - i].y },
      goalKey: null,
      rng: mulberry32((seed + 0x9e3779b9 * (i + 1)) >>> 0),
    })),
  };
  const ev = (e) => state.events.push(e);
  ev({ t: 0, type: 'start', seed, width: m.width, height: m.height, skills: [skillA, skillB] });

  let ended = null;
  for (let t = 0; t < R.maxTicks && !ended; t++) {
    state.t = t;
    // 1. 计时器
    for (const T of state.tanks) {
      for (const k of Object.keys(T.cd)) if (T.cd[k] > 0) T.cd[k]--;
      if (T.cloak > 0) T.cloak--;
      if (T.freeze > 0) T.freeze--;
      if (T.stun > 0) T.stun--;
      if (T.boost > 0) T.boost--;
    }
    // 2. 星星重生（单星：被吃后 starRespawn tick 在种子 RNG 合法格重生）
    if (state.starRespawnAt != null && t >= state.starRespawnAt) {
      if (state.stars.length < R.maxFieldStars) {
        const p = randomFreeCell(state);
        if (p) { state.stars.push(p); ev({ t, type: 'star_spawn', x: p.x, y: p.y }); }
      }
      state.starRespawnAt = null;
    }
    // 2.5 缩圈：t≥zone.start 起每 zone.every 拍收一圈（至中心 1 格封顶）；圈外星星被吞没并择期在圈内重生
    if (state.zoneRing < maxZoneRing(m) && t >= R.zone.start + state.zoneRing * R.zone.every) {
      state.zoneRing++;
      const z = zoneRect(state);
      ev({ t, type: 'zone_shrink', ring: state.zoneRing, x0: z.x0, y0: z.y0, x1: z.x1, y1: z.y1 });
      const kept = [];
      for (const s of state.stars) {
        if (inZone(state, s.x, s.y)) { kept.push(s); continue; }
        ev({ t, type: 'star_gone', x: s.x, y: s.y });
        if (state.starRespawnAt == null) state.starRespawnAt = t + R.starRespawn;
      }
      state.stars = kept;
      const keptItems = [];
      for (const s of state.items) {
        if (inZone(state, s.x, s.y)) { keptItems.push(s); continue; }
        ev({ t, type: 'item_gone', x: s.x, y: s.y, kind: s.kind }); // 圈外道具被毒圈吞没，不补偿重生
      }
      state.items = keptItems;
    }
    // 2.6 道具刷新：t≥items.start 起每 items.every 拍尝试刷一个（场上封顶 items.max）
    if (t >= state.itemSpawnAt) {
      if (state.items.length < R.items.max) spawnItem(state, ev);
      state.itemSpawnAt = t + R.items.every;
    }
    // 3. 推进已有子弹（先于双方动作）
    advanceBullets(state, ev);
    ended = checkDeath(state, ev);
    if (ended) break;
    // 4. 超载自动补射（不占本人手动动作）
    for (const T of state.tanks) {
      if (T.hp <= 0 || !T.pendingShot) continue;
      T.pendingShot.delay--;
      if (T.pendingShot.delay <= 0) {
        const { dx, dy } = T.pendingShot;
        T.pendingShot = null;
        spawnBullet(state, T.i, dx, dy, ev);
      }
    }
    // 5. 视野与最后目击位置
    for (const i of [0, 1]) {
      if (visibleTo(state, i)) {
        const E = state.tanks[1 - i];
        state.tanks[i].lastSeen = { x: E.x, y: E.y };
      }
    }
    // 6. 双方基于同一快照决策（决策阶段不改状态）
    const actions = [0, 1].map((i) => {
      try {
        return state.bots[i](makeApi(state, i));
      } catch {
        return null; // 策略脚本抛错 = 本拍待机
      }
    });
    // 7. 按固定顺序裁决
    for (const i of [0, 1]) {
      if (ended) break;
      applyAction(state, i, actions[i], ev);
      ended = checkDeath(state, ev);
    }
    if (ended) break;
    // 8. 持续效果：炸弹引信 → 爆炸；中毒掉血
    const keep = [];
    for (const b of state.bombs) {
      if (t - b.placedAt >= R.bombFuse) explodeBomb(state, b, ev);
      else keep.push(b);
    }
    state.bombs = keep;
    for (const T of state.tanks) {
      if (T.hp <= 0 || T.poison <= 0) continue;
      T.poison--;
      const pdmg = T.poisonDmg ?? R.skills.poison.dmg;
      T.hp -= pdmg;
      if (T.poisonFrom != null) state.tanks[T.poisonFrom].dmgDealt += pdmg;
      ev({ t, type: 'poison_tick', target: T.i, dmg: pdmg, hp: T.hp });
    }
    // 毒圈伤害：安全区外每拍掉血，圈数越多伤害越高（无视护盾）
    if (state.zoneRing > 0) {
      const zdmg = R.zone.dmg + (state.zoneRing - 1) * R.zone.dmgStep;
      if (zdmg > 0) {
        for (const T of state.tanks) {
          if (T.hp <= 0 || inZone(state, T.x, T.y)) continue;
          T.hp -= zdmg;
          ev({ t, type: 'zone_hit', target: T.i, dmg: zdmg, hp: T.hp });
        }
      }
    }
    ended = checkDeath(state, ev);
  }

  const [a, b] = state.tanks;
  if (!ended) ended = resolveEnd(state); // 超时：终局判定链，必出胜负
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
    skills: [skillA, skillB],
    ticks: state.t + 1,
    seed,
    ...(pack ? { content: pack } : {}), // 战报自带内容包：阶段2 分享后任何人可确定性重现
  };
}
