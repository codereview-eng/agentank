// AgenTank i18n：zh/en 双语字典 + 模板工具。
// 纪律：zh/en 叶子键位必须完全同构（tests/i18n.test.js 锁死）；zh 地图词条与
// src/engine/maps.js 逐字同源；en 叶子禁止出现中文。模板占位符用 {token}。
// 引擎侧 report.js（battle.log 确定性文本日志）保持中文不动，i18n 只覆盖网页呈现层。

export const LANGS = ['zh', 'en'];

// 语言解析优先级：?lang= > localStorage > 浏览器语言 > 默认 zh；非法值逐级回落。
export function resolveLang(query, stored, navLang) {
  if (query && LANGS.includes(query)) return query;
  if (stored && LANGS.includes(stored)) return stored;
  if (navLang) return String(navLang).toLowerCase().startsWith('zh') ? 'zh' : 'en';
  return 'zh';
}

// 模板替换：未提供的占位符原样保留（便于发现漏参）
export function fmt(tpl, vars) {
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? String(vars[k]) : m));
}

export const LOCALES = {
  zh: {
    skill: {
      shield: '护盾', freeze: '冰冻', stun: '眩晕', overload: '超载',
      cloak: '隐身', poison: '剧毒', teleport: '传送', boost: '疾驰',
    },
    item: {
      medkit: '急救包', rapid: '双发弹', pierce: '穿甲弹',
      helmet: '头盔', clock: '时钟', boots: '疾行靴',
    },
    reason: {
      kill: '击杀', stars: '星数', hp: '血量判定',
      damage: '输出判定', center: '圈心判定', coin: '种子掷签',
    },
    maps: {
      crossFort: { name: '十字要塞', desc: '中央十字工事，四条突破口' },
      openPlains: { name: '开阔平原', desc: '稀疏掩体，远距离对狙' },
      mazeCorridor: { name: '迷宫回廊', desc: '宽走廊迷宫，卡位与绕后' },
      grassSea: { name: '草海伏击', desc: '大片草丛，隐身流天堂' },
      dirtCheckers: { name: '土堆棋盘', desc: '满场可摧毁掩体，越打越开阔' },
      twinBridges: { name: '双桥对峙', desc: '城河分割南北，土桥是唯一通路' },
      arena: { name: '竞技场', desc: '环形立柱围出中央斗兽场' },
      serpentine: { name: '蛇形走廊', desc: 'S 形长墙，追逐与反打' },
      honeycomb: { name: '蜂巢', desc: '成对方块阵列，遍地掩体' },
      quadrants: { name: '四象限', desc: '十字分区，抢中路控图' },
      frozenLake: { name: '冰湖', desc: '中央大冰湖，走一步滑到底' },
      riverCrossing: { name: '冰河渡口', desc: '大河拦路，冰桥是唯一渡口' },
      tundra: { name: '冻原', desc: '冰带与水塘混杂，走位与弹道分离' },
    },
    bots: {
      stealth: { tank: '幽灵-7', style: '隐身偷袭' },
      starGrabber: { tank: '采星者', style: '抢星' },
      camper: { tank: '草垛王', style: '蹲草' },
      brawler: { tank: '铁头娃', style: '贴脸' },
    },
    ui: {
      title: 'AgenTank — AI 脚本坦克对战',
      tagline: 'AI 脚本坦克对战 · 你当教练，AI 开炮',
      season: '赛季 S1',
      editorTitle: '策略脚本 · {name}',
      myTank: '我的坦克',
      opponent: '对手',
      mySkill: '我的技能',
      map: '地图',
      mapRandom: '随机（按种子生成）',
      mapOption: '{name}（{desc}）',
      seed: '种子',
      battle: '开 战',
      save: '保存为新版本（当前 v{v} · 共 {n} 版）',
      liveLog: '实时战报',
      ladder: '天梯 · 内置流派',
      thTank: '坦克', thStyle: '流派', thElo: 'ELO', thWin: '胜率',
      skillOption: '{skill}（8 选 1）',
      langLabel: '语言',
      waiting: '等待开战…',
      eloCalc: '★ ELO 计算中…',
      ladderIdle: '空闲时计算循环赛中…',
      ladderHintBoot: '固定 seeds 循环赛 · 页面空闲时实算',
      jumpStart: '跳到开局',
      jumpEnd: '跳到终局',
      footEngine: '引擎',
      footSeedAuto: 'deterministic · seed=每局自动生成',
      footSeedReplay: 'deterministic · seed={seed}（回放）',
      footLogPre: '战报仅文字记录',
      footLogPost: '，回放由前端渲染',
      footSandboxPre: '沙箱',
      footSandbox: 'new Function 编译 · 受限 API · 脚本报错=本拍待机',
    },
    verdict: {
      notStarted: '尚未开战',
      editHint: '编辑左侧脚本，点「开战」开始对局',
      draw: '◐ 平局',
      drawWord: '平局',
      sub: '{how} @ t={t} · 星 {a}:{b} · 用时 {sec}s',
      ref: '回放 · 战报 #{id}',
    },
    ladder: {
      userStyle: '自定义',
      styleTag: '{style}流',
      oppOptionBoot: '{style}流 (内置 · 技能：{skill})',
      oppOption: '{style}流 (内置 · 技能：{skill} · ELO {elo})',
      rankChip: '★ {name} · ELO {elo}（#{rank}/{total}）',
      updated: '★ 天梯已更新',
      hint: '固定 seeds {seeds} 双边循环赛 · 共 {n} 局实算',
      cloakTag: ' 隐身中…',
    },
    log: {
      start: '对战开始 · 地图 {w}×{h}',
      startSeed: ' · 种子 <span class="sk">{seed}</span>（自动生成，回放用）',
      startSkills: ' · 技能 {n0}=<span class="sk">{s0}</span> {n1}=<span class="sk">{s1}</span>',
      moveStar: '{who} 直奔星星 ({x},{y})',
      moveEnemy: '{who} 扑向敌人 ({x},{y})',
      moveTo: '{who} 移动到 ({x},{y})',
      turn: '{who} 转炮口{arrow}',
      fire: '{who} 开火',
      hit: '{who} 命中 {target} <span class="dmg">-{dmg}</span>（剩 {hp}）',
      bulletWall: '{who} 的子弹被墙挡下',
      bulletMound: '{who} 的子弹打在土堆上',
      bulletOut: '{who} 的子弹飞出场外',
      moundCrack: '({x},{y}) 的土堆被打出裂缝',
      moundDestroyed: '({x},{y}) 的土堆<span class="dmg">被摧毁</span>',
      bombPlace: '{who} 在 ({x},{y}) 放下<span class="sk">炸弹</span>',
      bombExplode: '({x},{y}) <span class="dmg">炸弹爆炸</span>（波及 {cells} 格{hits}）',
      shieldBlockBomb: '{who} 的<span class="sk">护盾</span>挡下了炸弹',
      shieldBlockBullet: '{who} 的<span class="sk">护盾</span>挡下了子弹',
      freezeHit: '{target} 被<span class="sk">冰冻</span> {dur} 拍',
      poisonHit: '{target} <span class="sk">中毒</span>，{dur} 拍内持续掉血',
      star: '{who} <span class="st">吃星 ★ {a}:{b}</span>',
      starSpawn: '<span class="st">新星星</span>出现在 ({x},{y})',
      starGone: '({x},{y}) 的星星被<span class="dmg">毒圈</span>吞没',
      itemSpawn: '道具 <span class="sk">{item}</span> 出现在 ({x},{y})',
      itemPickMedkit: '{who} 拾取<span class="sk">{item}</span>，回血至 {hp}',
      itemPickClock: '{who} 拾取<span class="sk">{item}</span>，冻住了对手',
      itemPick: '{who} 拾取<span class="sk">{item}</span>',
      itemGone: '({x},{y}) 的{item}被<span class="dmg">毒圈</span>吞没',
      zoneShrink: '<span class="dmg">毒圈收缩</span>（第 {ring} 圈），安全区 ({x0},{y0})~({x1},{y1})',
      zoneHit: '{target} 在<span class="dmg">毒圈</span>中 -{dmg}（剩 {hp}）',
      slide: '{who} 在<span class="sk">冰面</span>滑到 ({x},{y})',
      skillCast: '{who} 施放<span class="sk">{skill}</span>',
      stunHit: '{target} 被<span class="sk">眩晕</span> {dur} 拍',
      death: '{who} <span class="dmg">被击毁</span>',
      endDraw: '平局（星 {a}:{b}）',
      endWin: '{who} <span class="win2">获胜</span>（{reason}，星 {a}:{b}）',
    },
    err: {
      compileFail: '脚本编译失败：{msg}',
      runtime: '脚本运行时报错 {n} 次（该拍已按待机处理）：{msg}',
      noEntry: '未找到入口函数 {entry}(api)，请定义 function decide(api) {...}',
      noDecide: '脚本未提供 decide(api) 函数',
      cspEval: '线上托管版受 CSP 限制（禁 eval），暂不支持编译改动后的脚本；默认脚本可直接开战。要自定义脚本，请把本页另存为 .html 在本地打开。',
      cspNote: '线上托管版：宿主 CSP 禁 eval，默认脚本以内置等价策略运行；编辑自定义脚本请把本页另存为 .html 在本地打开。',
    },
    script: {
      default: `// 你的战术：优先吃星，残血传送跑路
export default function decide(api) {
  const me = api.me();
  const star = api.nearestStar();

  // 看得见敌人就开炮
  if (api.enemyVisible() && api.canFire())
    return api.fireAt(api.enemy());

  // 残血：传送去安全角落
  if (me.hp < 30 && api.ready('teleport'))
    return api.teleport(api.safestCorner());

  // 默认：抢最近的星
  return star ? api.moveTo(star)
              : api.patrol();
}`,
    },
  },
  en: {
    skill: {
      shield: 'Shield', freeze: 'Freeze', stun: 'Stun', overload: 'Overload',
      cloak: 'Cloak', poison: 'Poison', teleport: 'Teleport', boost: 'Boost',
    },
    item: {
      medkit: 'Medkit', rapid: 'Double Shot', pierce: 'AP Shell',
      helmet: 'Helmet', clock: 'Clock', boots: 'Speed Boots',
    },
    reason: {
      kill: 'kill', stars: 'stars', hp: 'HP tiebreak',
      damage: 'damage tiebreak', center: 'center tiebreak', coin: 'seeded coin toss',
    },
    maps: {
      crossFort: { name: 'Cross Fort', desc: 'central cross works, four breaches' },
      openPlains: { name: 'Open Plains', desc: 'sparse cover, long-range duels' },
      mazeCorridor: { name: 'Maze Corridor', desc: 'wide-corridor maze, hold and flank' },
      grassSea: { name: 'Grass Sea', desc: 'vast grass, a cloaker paradise' },
      dirtCheckers: { name: 'Dirt Checkers', desc: 'destructible cover everywhere, opens up as you shoot' },
      twinBridges: { name: 'Twin Bridges', desc: 'a moat splits the field, dirt bridges are the only way' },
      arena: { name: 'Arena', desc: 'ring of pillars around a central pit' },
      serpentine: { name: 'Serpentine', desc: 'S-shaped walls, chase and counter' },
      honeycomb: { name: 'Honeycomb', desc: 'paired block arrays, cover everywhere' },
      quadrants: { name: 'Quadrants', desc: 'cross-divided zones, fight for mid' },
      frozenLake: { name: 'Frozen Lake', desc: 'one big central ice lake, one step slides you across' },
      riverCrossing: { name: 'River Crossing', desc: 'a river blocks the way, the ice bridge is the only ford' },
      tundra: { name: 'Tundra', desc: 'ice belts mixed with ponds, footwork splits from ballistics' },
    },
    bots: {
      stealth: { tank: 'Ghost-7', style: 'Stealth Ambush' },
      starGrabber: { tank: 'Star Reaper', style: 'Star Rush' },
      camper: { tank: 'Haystack King', style: 'Grass Camper' },
      brawler: { tank: 'Iron Head', style: 'Brawler' },
    },
    ui: {
      title: 'AgenTank — AI Script Tank Battle',
      tagline: 'AI script tank battle · you coach, AI fires',
      season: 'Season S1',
      editorTitle: 'Strategy Script · {name}',
      myTank: 'My Tank',
      opponent: 'Opponent',
      mySkill: 'My Skill',
      map: 'Map',
      mapRandom: 'Random (seeded)',
      mapOption: '{name} ({desc})',
      seed: 'Seed',
      battle: 'BATTLE',
      save: 'Save as new version (v{v} · {n} total)',
      liveLog: 'Live Battle Log',
      ladder: 'Ladder · Built-in Styles',
      thTank: 'Tank', thStyle: 'Style', thElo: 'ELO', thWin: 'Win%',
      skillOption: '{skill} (pick 1 of 8)',
      langLabel: 'Lang',
      waiting: 'waiting for battle…',
      eloCalc: '★ ELO computing…',
      ladderIdle: 'round-robin computed when idle…',
      ladderHintBoot: 'fixed-seed round-robin · computed when the page is idle',
      jumpStart: 'jump to start',
      jumpEnd: 'jump to end',
      footEngine: 'engine',
      footSeedAuto: 'deterministic · seed=auto per battle',
      footSeedReplay: 'deterministic · seed={seed} (replay)',
      footLogPre: 'text-only battle log',
      footLogPost: ', replay rendered client-side',
      footSandboxPre: 'sandbox',
      footSandbox: 'new Function compile · limited API · script error = idle that tick',
    },
    verdict: {
      notStarted: 'Not started',
      editHint: 'Edit the script on the left, press BATTLE to start',
      draw: '◐ Draw',
      drawWord: 'draw',
      sub: '{how} @ t={t} · stars {a}:{b} · {sec}s',
      ref: 'Replay · Report #{id}',
    },
    ladder: {
      userStyle: 'Custom',
      styleTag: '{style}',
      oppOptionBoot: '{style} (built-in · skill: {skill})',
      oppOption: '{style} (built-in · skill: {skill} · ELO {elo})',
      rankChip: '★ {name} · ELO {elo} (#{rank}/{total})',
      updated: '★ Ladder updated',
      hint: 'fixed seeds {seeds} double round-robin · {n} matches computed',
      cloakTag: ' cloaked…',
    },
    log: {
      start: 'Battle start · map {w}×{h}',
      startSeed: ' · seed <span class="sk">{seed}</span> (auto-generated, for replay)',
      startSkills: ' · skills {n0}=<span class="sk">{s0}</span> {n1}=<span class="sk">{s1}</span>',
      moveStar: '{who} rushes the star ({x},{y})',
      moveEnemy: '{who} charges the enemy ({x},{y})',
      moveTo: '{who} moves to ({x},{y})',
      turn: '{who} turns turret {arrow}',
      fire: '{who} fires',
      hit: '{who} hits {target} <span class="dmg">-{dmg}</span> (left {hp})',
      bulletWall: "{who}'s shell is blocked by a wall",
      bulletMound: "{who}'s shell hits a dirt mound",
      bulletOut: "{who}'s shell flies off the field",
      moundCrack: 'dirt mound at ({x},{y}) cracks',
      moundDestroyed: 'dirt mound at ({x},{y}) is <span class="dmg">destroyed</span>',
      bombPlace: '{who} drops a <span class="sk">bomb</span> at ({x},{y})',
      bombExplode: '<span class="dmg">bomb explodes</span> at ({x},{y}) ({cells} cells{hits})',
      shieldBlockBomb: "{who}'s <span class=\"sk\">shield</span> blocks the bomb",
      shieldBlockBullet: "{who}'s <span class=\"sk\">shield</span> blocks the shell",
      freezeHit: '{target} is <span class="sk">frozen</span> for {dur} ticks',
      poisonHit: '{target} is <span class="sk">poisoned</span>, bleeding for {dur} ticks',
      star: '{who} <span class="st">grabs a star ★ {a}:{b}</span>',
      starSpawn: '<span class="st">new star</span> appears at ({x},{y})',
      starGone: 'star at ({x},{y}) swallowed by the <span class="dmg">zone</span>',
      itemSpawn: 'item <span class="sk">{item}</span> appears at ({x},{y})',
      itemPickMedkit: '{who} picks up <span class="sk">{item}</span>, heals to {hp}',
      itemPickClock: '{who} picks up <span class="sk">{item}</span>, freezing the enemy',
      itemPick: '{who} picks up <span class="sk">{item}</span>',
      itemGone: '{item} at ({x},{y}) swallowed by the <span class="dmg">zone</span>',
      zoneShrink: '<span class="dmg">zone shrinks</span> (ring {ring}), safe area ({x0},{y0})~({x1},{y1})',
      zoneHit: '{target} takes -{dmg} in the <span class="dmg">zone</span> (left {hp})',
      slide: '{who} slides on <span class="sk">ice</span> to ({x},{y})',
      skillCast: '{who} casts <span class="sk">{skill}</span>',
      stunHit: '{target} is <span class="sk">stunned</span> for {dur} ticks',
      death: '{who} is <span class="dmg">destroyed</span>',
      endDraw: 'draw (stars {a}:{b})',
      endWin: '{who} <span class="win2">wins</span> ({reason}, stars {a}:{b})',
    },
    err: {
      compileFail: 'Script compile failed: {msg}',
      runtime: 'Script threw {n} time(s) (idled those ticks): {msg}',
      noEntry: 'Entry function {entry}(api) not found; define function decide(api) {...}',
      noDecide: 'Script does not provide a decide(api) function',
      cspEval: 'Hosted build is CSP-restricted (no eval): edited scripts cannot be compiled online; the default script works out of the box. To customize, save this page as .html and open it locally.',
      cspNote: 'Hosted build: host CSP forbids eval, the default script runs via a built-in equivalent strategy; to edit custom scripts save this page as .html and open locally.',
    },
    script: {
      default: `// Your tactics: grab stars first, teleport away when low
export default function decide(api) {
  const me = api.me();
  const star = api.nearestStar();

  // fire whenever the enemy is visible
  if (api.enemyVisible() && api.canFire())
    return api.fireAt(api.enemy());

  // low HP: teleport to the safest corner
  if (me.hp < 30 && api.ready('teleport'))
    return api.teleport(api.safestCorner());

  // default: chase the nearest star
  return star ? api.moveTo(star)
              : api.patrol();
}`,
    },
  },
};
