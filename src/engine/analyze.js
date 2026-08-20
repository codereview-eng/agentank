// 战报分析：把一局（或一批）对战的结构化事件，变成「AI 能批得动」的事实。
//
// 设计口径（老板 2026-08-20 定）：
//   单局战报的用途 = 玩家看完回放后，让 AI 指出「战术在这一局哪几处表现不合理」，据此调方案。
//   所以「不合理」必须是**引擎事件推导出的确定性判定**（下面 8 条规则），AI 只负责解释这些时刻
//   意味着什么、战术该怎么改。绝不把「哪里不合理」交给模型自由发挥——那样它只会说空话，
//   也无法复现、无法测试。
//
// 分工：
//   replayStates   事件 → 每 tick 状态（位置/血量/冷却/毒圈/星/道具），单一权威重建口径
//   buildMetrics   事件 → 单局指标（命中率、伤害收支、首星、技能命中…）
//   detectMoments  状态+事件 → 可疑时刻（带触发时的快照与人话原因）
//   buildBattleReport  单局 JSON（喂 AI 的那份，**不含人读文字**）
//   aggregateBatch / renderBatchText  批量胜率聚合 + 人读文字报告（界面直接展示的那份）
import { RULES } from './engine.js';

const azMan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const azR4 = (n) => Math.round(n * 10000) / 10000;

// 攻击型技能 → 它的命中事件（用于判定「技能空放」）
const AZ_ATTACK_SKILL_HIT = { freeze: 'freeze_hit', stun: 'stun_hit', poison: 'poison_hit' };

// ---------- 敏感串打码（单一定义点：web/play.js 从这里导入，勿另写一份） ----------
export function redactSecrets(text) {
  return String(text == null ? '' : text)
    .replace(/\b(Bearer)\s+[A-Za-z0-9._-]+/gi, '$1 «redacted»')
    .replace(/\b(ak1|gt1|sk|pk)_[A-Za-z0-9._-]{6,}/g, '$1_«redacted»')
    .replace(/("?(?:access_)?token"?\s*[:=]\s*")([^"]{6,})(")/gi, '$1«redacted»$3')
    .replace(/([?&](?:token|key|secret)=)[^&\s]{6,}/gi, '$1«redacted»');
}

// ---------- 批量试跑的两组固定种子（单一定义点：网页端与测量脚本都从这里取） ----------
// 训练组 = AI 能看到战报的那 12 个；留出组 = AI 从没见过的另 12 个，验收只认它。
// 分两组的原因：只看训练组会把「战术调成只赢这几个种子」误判成「变强了」。
export const BATCH_SEEDS = {
  train: ['tr01', 'tr02', 'tr03', 'tr04', 'tr05', 'tr06', 'tr07', 'tr08', 'tr09', 'tr10', 'tr11', 'tr12'],
  holdout: ['ho01', 'ho02', 'ho03', 'ho04', 'ho05', 'ho06', 'ho07', 'ho08', 'ho09', 'ho10', 'ho11', 'ho12'],
};

// ---------- 可疑时刻规则清单（顺序即 id 顺序，测试锁死） ----------
export const MOMENT_RULES = [
  { id: 'star-ignored', severity: 'high', label: '该吃的星没吃' },
  { id: 'zone-outward', severity: 'high', label: '缩圈了还不进圈' },
  { id: 'cooldown-brawl', severity: 'mid', label: '冷却期硬拼' },
  { id: 'heal-ignored', severity: 'high', label: '该回血没回' },
  { id: 'wasted-shots', severity: 'mid', label: '白开炮' },
  { id: 'skill-whiff', severity: 'mid', label: '技能空放' },
  { id: 'static-under-fire', severity: 'mid', label: '挨打不动' },
  { id: 'losing-melee', severity: 'high', label: '无谓贴身' },
];
const AZ_RULE_BY_ID = Object.fromEntries(MOMENT_RULES.map((r) => [r.id, r]));

// 判定阈值集中在此，便于按实测调整（改这里就是改规则，测试会跟着红）
export const MOMENT_TUNING = {
  starNear: 3,        // 「近星」判定：曼哈顿距离 ≤ 3
  zoneRun: 4,         // 缩圈后连续多少拍仍在圈外才算不合理
  brawlRun: 4,        // 冷却期处于中距离连续多少拍算硬拼
  brawlBand: [3, 6],  // 「中距离」区间
  healReach: 8,       // 急救包可达距离
  healGrace: 12,      // 多少拍内真去捡了就不算
  healDefault: 40,    // 战术里读不到阈值时的默认血线
  wastedStreak: 3,    // 连续几发被挡算白开炮
  whiffWindow: 3,     // 技能施放后多少拍内没命中算空放
  staticGap: 15,      // 两次挨弹间隔在此之内才算「同一段挨打」
  meleeGap: 20,       // 血量落后多少算劣势
  meleeDist: 2,       // 贴身距离
  maxMoments: 12,     // 单局最多留几条（喂 AI 的预算上限）
};

// 从玩家自己写的战术文字里读出血线：写了就按他写的，读不到用默认值。
// 为什么必须解析：「该回血没回」的价值在于**指出行为与他自己写的战术不符**。
export function healThresholdFrom(strategy) {
  const s = String(strategy || '');
  const m = s.match(/(?:血|hp|HP)[^0-9%]{0,12}?(\d{1,3})\s*(?:%|以下|以内)?/);
  if (m) {
    const n = Number(m[1]);
    if (n > 0 && n <= RULES.hp) return n;
  }
  return MOMENT_TUNING.healDefault;
}

function azSkillCdOf(name, pack) {
  const entries = pack && Array.isArray(pack.entries) ? pack.entries : null;
  const p = entries ? entries.find((e) => e.type === 'skill' && e.id === name) : null;
  if (p && Number(p.cd) > 0) return Number(p.cd);
  const built = RULES.skills[name];
  return built && built.cd ? built.cd : 60;
}

function azZoneOf(map, ring, e) {
  if (e && e.x0 != null) return { x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 };
  return { x0: 1 + ring, y0: 1 + ring, x1: map.width - 2 - ring, y1: map.height - 2 - ring };
}
const azInZone = (z, p) => !z || (p.x >= z.x0 && p.x <= z.x1 && p.y >= z.y0 && p.y <= z.y1);
const azZoneCenter = (z) => ({ x: (z.x0 + z.x1) / 2, y: (z.y0 + z.y1) / 2 });

// ---------- 事件 → 每 tick 状态 ----------
export function replayStates(map, result) {
  const ticks = Number(result.ticks) || 0;
  const byTick = Array.from({ length: ticks }, () => []);
  for (const e of result.events || []) if (e.t >= 0 && e.t < ticks) byTick[e.t].push(e);

  const pos = map.spawns.map((s) => ({ x: s.x, y: s.y }));
  const hp = [RULES.hp, RULES.hp];
  const held = [0, 0];
  const cd = [{ fire: 0, skill: 0, bomb: 0 }, { fire: 0, skill: 0, bomb: 0 }];
  const dead = [false, false];
  const skills = Array.isArray(result.skills) ? result.skills.slice() : [];
  let field = map.stars.slice(0, RULES.maxFieldStars ?? map.stars.length).map((s) => ({ x: s.x, y: s.y }));
  let items = [];
  let ring = 0;
  let zone = null;
  const states = [];

  for (let t = 0; t < ticks; t++) {
    for (const i of [0, 1]) for (const k of ['fire', 'skill', 'bomb']) if (cd[i][k] > 0) cd[i][k]--;
    for (const e of byTick[t]) {
      switch (e.type) {
        case 'move':
        case 'slide':
          pos[e.who] = { x: e.x, y: e.y };
          break;
        case 'star':
          field = field.filter((s) => !(s.x === e.x && s.y === e.y));
          held[e.who] = e.total;
          break;
        case 'star_spawn': field = field.concat([{ x: e.x, y: e.y }]); break;
        case 'star_gone': field = field.filter((s) => !(s.x === e.x && s.y === e.y)); break;
        case 'item_spawn': items = items.concat([{ x: e.x, y: e.y, kind: e.kind }]); break;
        case 'item_pick':
          items = items.filter((s) => !(s.x === e.x && s.y === e.y));
          if (e.kind === 'medkit' && e.hp != null) hp[e.who] = e.hp;
          break;
        case 'item_gone': items = items.filter((s) => !(s.x === e.x && s.y === e.y)); break;
        case 'zone_shrink':
          ring = e.ring;
          zone = azZoneOf(map, ring, e);
          break;
        case 'zone_hit': hp[e.target] = e.hp; break;
        case 'poison_tick': if (e.hp != null) hp[e.target] = e.hp; break;
        case 'hit': hp[e.target] = e.hp; break;
        case 'fire': cd[e.who].fire = RULES.fireCd; break;
        case 'bomb_place': cd[e.who].bomb = RULES.bombCd; break;
        case 'bomb_explode':
          for (const h of e.hits || []) hp[h.who] -= h.dmg;
          break;
        case 'skill':
          cd[e.who].skill = azSkillCdOf(e.name, result.content);
          if (e.name === 'teleport' && e.x != null) pos[e.who] = { x: e.x, y: e.y };
          break;
        case 'death': dead[e.who] = true; break;
        default: break;
      }
    }
    states.push({
      t,
      pos: pos.map((p) => ({ ...p })),
      hp: [...hp],
      held: [...held],
      cd: cd.map((c) => ({ ...c })),
      ring,
      zone: zone ? { ...zone } : null,
      field: field.map((s) => ({ ...s })),
      items: items.map((i) => ({ ...i })),
      dead: [...dead],
      skills,
    });
  }
  return states;
}

// ---------- 单局指标 ----------
export function buildMetrics(map, result, who = 0) {
  const foe = 1 - who;
  let fires = 0; let hits = 0; let blocked = 0;
  let dealt = 0; let taken = 0; let zoneDmg = 0;
  let skillCasts = 0; let skillHits = 0;
  let firstStarTick = null; let enemyFirstStarTick = null; let deathTick = null;
  const bombOwner = new Map();
  const poisonDmg = (RULES.skills.poison && RULES.skills.poison.dmg) || 2;

  for (const e of result.events || []) {
    switch (e.type) {
      case 'fire': if (e.who === who) fires++; break;
      case 'hit':
        if (e.who === who) { hits++; dealt += e.dmg; }
        if (e.target === who) taken += e.dmg;
        break;
      case 'bullet_end':
        if (e.who === who && (e.reason === 'wall' || e.reason === 'mound')) blocked++;
        break;
      case 'zone_hit':
        if (e.target === who) { taken += e.dmg; zoneDmg += e.dmg; }
        break;
      case 'poison_tick':
        if (e.target === who) taken += (e.dmg ?? poisonDmg);
        break;
      case 'bomb_place': bombOwner.set(`${e.x},${e.y}`, e.who); break;
      case 'bomb_explode': {
        const owner = bombOwner.get(`${e.x},${e.y}`);
        for (const h of e.hits || []) {
          if (h.who === who) taken += h.dmg;
          if (owner === who && h.who !== who) dealt += h.dmg;
        }
        break;
      }
      case 'skill': if (e.who === who) skillCasts++; break;
      case 'freeze_hit':
      case 'stun_hit':
      case 'poison_hit':
        if (e.target === foe) skillHits++;
        break;
      case 'shield_block': if (e.who === who) skillHits++; break;
      case 'star':
        if (e.who === who) { if (firstStarTick == null) firstStarTick = e.t; }
        else if (enemyFirstStarTick == null) enemyFirstStarTick = e.t;
        break;
      case 'death': if (e.who === who) deathTick = e.t; break;
      default: break;
    }
  }
  return {
    fires,
    hits,
    accuracy: fires ? azR4(hits / fires) : 0,
    shotsBlocked: blocked,
    dmgDealt: dealt,
    dmgTaken: taken,
    zoneDmg,
    skillCasts,
    skillHits,
    firstStarTick,
    enemyFirstStarTick,
    deathTick,
    ticks: Number(result.ticks) || 0,
    stars: Array.isArray(result.stars) ? result.stars.slice() : [0, 0],
  };
}

// ---------- 可疑时刻 ----------
function azMkMoment(ruleId, t, snapshot, why) {
  const r = AZ_RULE_BY_ID[ruleId];
  return { t, rule: ruleId, label: r.label, severity: r.severity, why, snapshot };
}

export function detectMoments(map, result, opts = {}) {
  const who = opts.who ?? 0;
  const foe = 1 - who;
  const max = opts.max ?? MOMENT_TUNING.maxMoments;
  const strategy = opts.strategy || '';
  const states = opts.states || replayStates(map, result);
  const ticks = states.length;
  if (!ticks) return [];
  const byTick = Array.from({ length: ticks }, () => []);
  for (const e of result.events || []) if (e.t >= 0 && e.t < ticks) byTick[e.t].push(e);
  const out = [];
  const T = MOMENT_TUNING;

  // 1 star-ignored：近处有星却奔向别处
  let lastStarFlag = -99;
  for (let t = 0; t < ticks; t++) {
    for (const e of byTick[t]) {
      if (e.type !== 'goal' || e.who !== who || e.tag === 'star') continue;
      const st = states[t];
      if (st.dead[who]) continue;
      let near = null;
      for (const s of st.field) {
        const d = azMan(st.pos[who], s);
        if (!near || d < near.dist) near = { x: s.x, y: s.y, dist: d };
      }
      if (!near || near.dist > T.starNear || t - lastStarFlag < 10) continue;
      lastStarFlag = t;
      out.push(azMkMoment('star-ignored', t, {
        star: near,
        chose: { x: e.x, y: e.y, tag: e.tag || 'move' },
        pos: { ...st.pos[who] },
      }, `${near.dist} 格内就有星，你却奔向 (${e.x},${e.y})——星数是判定链第二顺位，白送落后`));
    }
  }

  // 2 zone-outward：缩圈后连续留在圈外且没往里走
  let runStart = -1; let runBestDist = Infinity; let flaggedRing = -1;
  for (let t = 0; t < ticks; t++) {
    const st = states[t];
    if (!st.zone || st.ring <= 0 || st.dead[who]) { runStart = -1; runBestDist = Infinity; continue; }
    const outside = !azInZone(st.zone, st.pos[who]);
    const d = azMan(st.pos[who], azZoneCenter(st.zone));
    if (!outside) { runStart = -1; runBestDist = Infinity; continue; }
    if (runStart < 0) { runStart = t; runBestDist = d; }
    const closing = d < runBestDist - 0.5;
    if (closing) { runStart = t; runBestDist = d; continue; } // 确实在往里走，不算
    if (t - runStart + 1 >= T.zoneRun && st.ring !== flaggedRing) {
      flaggedRing = st.ring;
      out.push(azMkMoment('zone-outward', t, {
        ring: st.ring,
        zone: { ...st.zone },
        pos: { ...st.pos[who] },
        stuckTicks: t - runStart + 1,
      }, `毒圈第 ${st.ring} 圈已收，你在圈外待了 ${t - runStart + 1} 拍还没往里走——毒圈伤害逐圈递增，纯白给`));
    }
  }

  // 3 cooldown-brawl：保命/位移技能冷却中，仍在中距离对射
  let brawlStart = -1; let brawlFired = false; let lastBrawlFlag = -99;
  for (let t = 0; t < ticks; t++) {
    const st = states[t];
    const dist = azMan(st.pos[who], st.pos[foe]);
    const inBand = dist >= T.brawlBand[0] && dist <= T.brawlBand[1];
    const cooling = st.cd[who].skill > 0;
    if (st.dead[who] || st.dead[foe] || !inBand || !cooling) { brawlStart = -1; brawlFired = false; continue; }
    if (brawlStart < 0) { brawlStart = t; brawlFired = false; }
    if (byTick[t].some((e) => e.type === 'fire' && e.who === who)) brawlFired = true;
    if (brawlFired && t - brawlStart + 1 >= T.brawlRun && t - lastBrawlFlag >= 20) {
      lastBrawlFlag = t;
      out.push(azMkMoment('cooldown-brawl', t, {
        cdLeft: st.cd[who].skill,
        dist,
        skill: st.skills[who] ?? null,
        pos: { ...st.pos[who] },
      }, `${st.skills[who] ?? '技能'}还在冷却（剩 ${st.cd[who].skill} 拍），你在 ${dist} 格中距离硬对射——没有脱战手段时对射期望为负`));
    }
  }

  // 4 heal-ignored：血低于「你自己写的」阈值，可达急救包却不去
  const thr = healThresholdFrom(strategy);
  let lastHealFlag = -99;
  for (let t = 0; t < ticks; t++) {
    const st = states[t];
    if (st.dead[who] || st.hp[who] <= 0 || st.hp[who] >= thr) continue;
    if (t - lastHealFlag < 30) continue;
    let kit = null;
    for (const it of st.items) {
      if (it.kind !== 'medkit') continue;
      const d = azMan(st.pos[who], it);
      if (!kit || d < kit.dist) kit = { x: it.x, y: it.y, dist: d };
    }
    if (!kit || kit.dist > T.healReach) continue;
    let picked = false;
    for (let k = t; k < Math.min(ticks, t + T.healGrace + 1); k++) {
      if (byTick[k].some((e) => e.type === 'item_pick' && e.who === who && e.kind === 'medkit')) { picked = true; break; }
    }
    if (picked) continue;
    lastHealFlag = t;
    out.push(azMkMoment('heal-ignored', t, {
      hp: st.hp[who],
      threshold: thr,
      medkit: kit,
      pos: { ...st.pos[who] },
    }, `血只剩 ${st.hp[who]}，${kit.dist} 格外就有急救包却没去——你的战术写了血量低于 ${thr} 要回血，实际行为与战术不符`));
  }

  // 5 wasted-shots：连续被墙/土堆挡下
  let streak = 0;
  for (let t = 0; t < ticks; t++) {
    for (const e of byTick[t]) {
      if (e.type === 'hit' && e.who === who) { streak = 0; continue; }
      if (e.type !== 'bullet_end' || e.who !== who) continue;
      if (e.reason === 'wall' || e.reason === 'mound') {
        streak++;
        if (streak >= T.wastedStreak) {
          out.push(azMkMoment('wasted-shots', t, {
            streak,
            reason: e.reason,
            pos: { ...states[t].pos[who] },
          }, `连续 ${streak} 发子弹被${e.reason === 'wall' ? '墙' : '土堆'}挡下——暴露位置又白等冷却`));
          streak = 0;
        }
      } else if (e.reason === 'hit') streak = 0;
    }
  }

  // 6 skill-whiff：攻击型技能放空
  for (let t = 0; t < ticks; t++) {
    for (const e of byTick[t]) {
      if (e.type !== 'skill' || e.who !== who) continue;
      const hitType = AZ_ATTACK_SKILL_HIT[e.name];
      if (!hitType) continue;
      let landed = false;
      for (let k = t; k < Math.min(ticks, t + T.whiffWindow + 1); k++) {
        if (byTick[k].some((x) => x.type === hitType && x.target === foe)) { landed = true; break; }
      }
      if (landed) continue;
      out.push(azMkMoment('skill-whiff', t, {
        skill: e.name,
        dist: azMan(states[t].pos[who], states[t].pos[foe]),
        pos: { ...states[t].pos[who] },
      }, `${e.name} 放出去没打到人——关键技能空放，等于少一条命`));
    }
  }

  // 7 static-under-fire：连挨两发还站原地
  let prevHit = null;
  for (let t = 0; t < ticks; t++) {
    for (const e of byTick[t]) {
      if (e.type !== 'hit' || e.target !== who) continue;
      const p = states[t].pos[who];
      if (prevHit && t - prevHit.t <= T.staticGap && prevHit.pos.x === p.x && prevHit.pos.y === p.y) {
        out.push(azMkMoment('static-under-fire', t, {
          since: prevHit.t,
          pos: { ...p },
          hp: states[t].hp[who],
        }, `第 ${prevHit.t} 拍挨过一发，到第 ${t} 拍还站在同一格又挨一发——对手已经锁定弹道`));
        prevHit = null;
        continue;
      }
      prevHit = { t, pos: { ...p } };
    }
  }

  // 8 losing-melee：血量劣势还主动贴身
  let lastMeleeFlag = -99;
  for (let t = 0; t < ticks; t++) {
    for (const e of byTick[t]) {
      const moved = (e.type === 'move' || e.type === 'slide' || (e.type === 'skill' && e.name === 'teleport'));
      if (!moved || e.who !== who) continue;
      const st = states[t];
      const dist = azMan(st.pos[who], st.pos[foe]);
      if (dist > T.meleeDist) continue;
      if (st.hp[who] >= st.hp[foe] - T.meleeGap) continue;
      if (t - lastMeleeFlag < 15) continue;
      lastMeleeFlag = t;
      out.push(azMkMoment('losing-melee', t, {
        hp: st.hp[who],
        enemyHp: st.hp[foe],
        dist,
        pos: { ...st.pos[who] },
      }, `你 ${st.hp[who]} 血、对手 ${st.hp[foe]} 血，还主动贴到 ${dist} 格——劣势方贴身等于加速结算`));
    }
  }

  // 预算上限：先按「严重程度 → 时间」挑，再按时间排回去（读起来是一条时间线）
  const rank = { high: 0, mid: 1 };
  const kept = out
    .slice()
    .sort((a, b) => (rank[a.severity] - rank[b.severity]) || (a.t - b.t))
    .slice(0, max)
    .sort((a, b) => a.t - b.t);
  return kept;
}

// ---------- 单局 JSON（喂 AI 的那份；不含人读文字，老板定的口径） ----------
export function buildBattleReport(o) {
  const map = o.map;
  const result = o.result;
  const who = o.who ?? 0;
  const setup = o.setup || {};
  const states = replayStates(map, result);
  const metrics = buildMetrics(map, result, who);
  const moments = detectMoments(map, result, { who, strategy: setup.strategy || '', states, max: o.max });
  return {
    kind: 'agentank-battle',
    schema: 1,
    at: o.at || new Date().toISOString(),
    setup: {
      seed: String(setup.seed ?? ''),
      mapKey: String(setup.mapKey ?? ''),
      opponent: String(setup.opponent ?? ''),
      tank: String(setup.tank ?? ''),
      skills: Array.isArray(result.skills) ? result.skills.slice() : [],
      strategy: redactSecrets(setup.strategy || ''),
      codeHash: String(setup.codeHash ?? ''),
      who,
    },
    result: {
      win: result.winner === who,
      winner: result.winner,
      reason: result.reason,
      ticks: result.ticks,
      stars: Array.isArray(result.stars) ? result.stars.slice() : [0, 0],
    },
    metrics,
    moments,
    events: result.events || [],
  };
}

// 批量试跑里「一局 → 一行摘要」的单一权威口径：
// 沙箱 Worker（线上禁 eval 时）与主线程（本地）都必须调它，否则两条路会给出不同的胜率口径。
// 只回摘要不回全量事件：12 局的完整事件几 MB，postMessage 回主线程既慢又没人看。
export function summarizeGame(o) {
  const map = o.map;
  const result = o.result;
  const who = o.who ?? 0;
  const states = replayStates(map, result);
  return {
    seed: String(o.seed ?? result.seed ?? ''),
    win: result.winner === who,
    reason: result.reason,
    ticks: result.ticks,
    metrics: buildMetrics(map, result, who),
    moments: detectMoments(map, result, { who, strategy: o.strategy || '', states, max: o.max ?? 6 }),
  };
}

const azPad2 = (n) => String(n).padStart(2, '0');
function azStamp(now) {
  const d = now instanceof Date ? now : new Date(now || Date.now());
  return `${d.getFullYear()}${azPad2(d.getMonth() + 1)}${azPad2(d.getDate())}-${azPad2(d.getHours())}${azPad2(d.getMinutes())}${azPad2(d.getSeconds())}`;
}
const azSafeSeed = (s) => String(s || 'seed').replace(/[^A-Za-z0-9_-]+/g, '') || 'seed';

export function battleReportFilename(now, seed) {
  return `agentank-battle-${azSafeSeed(seed)}-${azStamp(now)}.json`;
}
export function batchReportFilename(now, ext = 'txt') {
  return `agentank-report-${azStamp(now)}.${ext}`;
}

// ---------- 批量聚合 ----------
// games[i] = { seed, win, reason, ticks, metrics, moments? }
export function aggregateBatch(games) {
  const list = Array.isArray(games) ? games : [];
  const n = list.length;
  if (!n) {
    return { games: 0, wins: 0, losses: 0, winRate: null, lossBuckets: {}, avg: {}, topMomentRules: [] };
  }
  const wins = list.filter((g) => g.win).length;
  const lossBuckets = {};
  for (const g of list) if (!g.win) lossBuckets[g.reason] = (lossBuckets[g.reason] || 0) + 1;
  const keys = ['accuracy', 'dmgDealt', 'dmgTaken', 'zoneDmg', 'skillCasts', 'skillHits', 'shotsBlocked'];
  const avg = {};
  for (const k of keys) {
    let sum = 0; let cnt = 0;
    for (const g of list) { const v = g.metrics && g.metrics[k]; if (typeof v === 'number') { sum += v; cnt++; } }
    avg[k] = cnt ? azR4(sum / cnt) : null;
  }
  for (const k of ['firstStarTick', 'enemyFirstStarTick', 'ticks']) {
    let sum = 0; let cnt = 0;
    for (const g of list) {
      const v = k === 'ticks' ? g.ticks : (g.metrics && g.metrics[k]);
      if (typeof v === 'number') { sum += v; cnt++; }
    }
    avg[k] = cnt ? Math.round(sum / cnt) : null;
  }
  const ruleCount = {};
  for (const g of list) for (const m of g.moments || []) ruleCount[m.rule] = (ruleCount[m.rule] || 0) + 1;
  const topMomentRules = Object.entries(ruleCount)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([rule, count]) => ({ rule, count, label: (AZ_RULE_BY_ID[rule] || {}).label || rule }));
  // winRate 不做四舍五入：它是对比「改前/改后」的比值，展示层再格式化（早期取整会把 1/12 的差异抹平）
  return { games: n, wins, losses: n - wins, winRate: wins / n, lossBuckets, avg, topMomentRules };
}

// ---------- 人读批量报告（界面直接展示的那份；下载文字版与它一字不差） ----------
const AZ_REASON_CN = { kill: '被打死', stars: '星数少', hp: '血量判定', damage: '输出判定', center: '圈心判定', coin: '种子掷签', zone: '毒圈拖死' };
const AZ_SEEDSET_CN = { train: '训练组', holdout: '留出组' };
const azPct = (x) => `${Math.round(x * 1000) / 10}%`;

export function renderBatchText(batch) {
  const b = batch || {};
  const s = b.setup || {};
  const games = Array.isArray(b.games) ? b.games : [];
  const agg = aggregateBatch(games);
  const at = String(b.at || '').replace('T', ' ').slice(0, 16);
  const setName = AZ_SEEDSET_CN[s.seedSet] || s.seedSet || '自定义';
  const lines = [];
  lines.push(`AgenTank 批量战报 · ${setName} ${games.length} 局`);
  lines.push(`生成 ${at} · 坦克 ${s.tank || '—'} · 对手 ${s.opponent || '—'} · 技能 ${s.skill || '—'} · 地图 ${s.mapKey || '—'}`);
  lines.push('');

  lines.push('总览');
  if (!agg.games) {
    lines.push('  本次没有跑出任何一局（沙箱失败或被中断）——没有数据可看，不拿旧结果冒充。');
    lines.push('');
    return lines;
  }
  lines.push(`  胜率 ${azPct(agg.winRate)}（${agg.wins} 胜 ${agg.losses} 负）  平均时长 ${agg.avg.ticks} 拍`);
  lines.push(`  命中率 ${azPct(agg.avg.accuracy || 0)}  伤害 打出 ${agg.avg.dmgDealt} / 挨了 ${agg.avg.dmgTaken}  平均首星 第 ${agg.avg.firstStarTick ?? '—'} 拍（对手 ${agg.avg.enemyFirstStarTick ?? '—'}）`);
  lines.push('');

  lines.push(`输在哪（${agg.losses} 负）`);
  if (!agg.losses) lines.push('  本组全胜。');
  else {
    for (const [reason, count] of Object.entries(agg.lossBuckets).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${AZ_REASON_CN[reason] || reason} ${count} 局`);
    }
  }
  if (agg.topMomentRules.length) {
    lines.push('  最常见的不合理操作：' + agg.topMomentRules.slice(0, 3).map((r) => `${r.label} ×${r.count}`).join('、'));
  }
  lines.push('');

  lines.push('逐局');
  for (const g of games) {
    const m = g.metrics || {};
    lines.push(
      `  seed ${g.seed}  ${g.win ? '胜' : '负'}  ${AZ_REASON_CN[g.reason] || g.reason}`
      + `  命中 ${azPct(m.accuracy || 0)}  打${m.dmgDealt ?? '—'}/挨${m.dmgTaken ?? '—'}`
      + `  星${(m.stars || [0, 0])[0]}:${(m.stars || [0, 0])[1]}`,
    );
  }
  lines.push('');

  const worst = games.filter((g) => !g.win && (g.moments || []).length)
    .sort((a, b) => (b.moments.length - a.moments.length))
    .slice(0, 3);
  if (worst.length) {
    lines.push('最值得看的 3 局（转折点）');
    for (const g of worst) {
      lines.push(`  seed ${g.seed}`);
      for (const m of g.moments.slice(0, 4)) lines.push(`    t=${String(m.t).padStart(3, '0')} ${m.label}：${m.why}`);
    }
    lines.push('');
  }
  return lines;
}
