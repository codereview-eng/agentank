import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sdkInjectDecision,
  buildTankPayload,
  nextTankVersion,
  buildBattleResultPayload,
  summarizeChallenge,
  entityFields,
  agentKeysGate,
  agentKeyRows,
  agentKeyLimitReached,
  mapAgentKeyError,
  AGENT_KEY_MAX,
  buildWorkshopPayload,
  parseWorkshopRow,
  garageFromRows,
  migrateLocalSave,
  upsertLocalTank,
  reconcileLogin,
} from '../web/play.js';

// ============================================================
// 匿名 ↔ 登录 全流程 e2e（node --test，零依赖）
//
// 把「匿名玩 → 登录 → 换账号 → 登出」各种情况下的数据去向钉成可执行契约：
//   - 匿名数据只进本机 localStorage（agentank.save / agentank-workshop）；
//     匿名战斗结果只在页面内存，不持久化；
//   - 登录数据只进云端实体（Tank / BattleResult，owner scope + player 字段双重隔离）；
//   - 两边只在用户显式点「生成我的坦克」「回填」时交汇 → 不存在静默互相覆盖。
//
// 已确认的实现缺口集中挂在文件末尾（todo 形式：--test 会列出，不算失败），
// 等用户逐条确认是否补充。
// ============================================================

// ---------- 浏览器/云端 双仿真 ----------

// 本机 localStorage：一个实例 = 一台浏览器；换浏览器/设备 = 新实例
function makeBrowserStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}

// 云端 gamesrvd /api/db：owner scope（list 只回本人行），行形状 {id, fields:{...}} 与线上一致
function makeCloud() {
  let auto = 0;
  const tables = { Tank: [], BattleResult: [] };
  const bind = (owner, name) => ({
    list: async () => tables[name]
      .filter((r) => r.owner === owner)
      .map((r) => ({ id: r.id, fields: r.fields })),
    create: async (fields) => {
      const row = { owner, id: `e${++auto}`, fields };
      tables[name].push(row);
      return { id: row.id, fields };
    },
  });
  return {
    asUser: (owner) => ({ Tank: bind(owner, 'Tank'), BattleResult: bind(owner, 'BattleResult') }),
    tables,
  };
}

// app.js 本地存档契约（web/app.js 车库存储同款：agentank.save = {tanks:[{name,code,skill,v}],cur}，
// 旧单份 {code,v,n} 由 migrateLocalSave 一次性迁移为「坦克1」）
const SAVE_KEY = 'agentank.save';
function anonLoad(ls) { // 当前出战坦克（车库 cur 台），无坦克返回 null
  const s = migrateLocalSave(ls.getItem(SAVE_KEY), '坦克1');
  return s.tanks.find((t) => t.name === s.cur) || null;
}
function anonSave(ls, code) { // app.js saveVersion 本地分支同款：cur 台（缺省「坦克1」）同名递增 v
  const s = migrateLocalSave(ls.getItem(SAVE_KEY), '坦克1');
  const r = upsertLocalTank(s, { name: s.cur || '坦克1', code, skill: '' });
  ls.setItem(SAVE_KEY, JSON.stringify({ tanks: r.tanks, cur: r.cur }));
  return { v: r.v };
}
// app.js 车库云端模式同款：Tank 行 → 车库，取出战坦克（is_active 标记）
async function cloudLatestTank(db) {
  return garageFromRows(await db.Tank.list()).active;
}

// ---------- 一、匿名玩家：数据都落在哪 ----------

test('e2e/匿名：打完一局，战报只在页面内存——本机 localStorage 与云端都零写入（刷新即丢）', () => {
  const ls = makeBrowserStorage();
  const cloud = makeCloud();
  // 引擎打完一局的结果就是个内存对象，匿名路径没有任何持久化调用
  const result = { winner: 0, reason: 'hp', ticks: 300, stars: [2, 0] };
  assert.equal(result.winner, 0);
  assert.deepEqual(ls.keys(), []); // 本机没写
  assert.equal(cloud.tables.Tank.length + cloud.tables.BattleResult.length, 0); // 云端没写
});

test('e2e/匿名：保存脚本只写本机 agentank.save（坦克列表，同名递增 v），云端零写入', () => {
  const ls = makeBrowserStorage();
  const cloud = makeCloud();
  const r1 = anonSave(ls, 'export default function decide(){ return null; }');
  const r2 = anonSave(ls, 'export default function decide(){ return { move: "up" }; }');
  assert.deepEqual([r1.v, r2.v], [1, 2]); // 第一存 v1，此后同名每存 +1
  const s = anonLoad(ls);
  assert.deepEqual(Object.keys(s).sort(), ['code', 'name', 'skill', 'v']);
  assert.equal(s.name, '坦克1');
  assert.match(s.code, /move/);
  assert.equal(cloud.tables.Tank.length, 0);
});

test('e2e/匿名：旧单份存量 {code,v,n} 读回即迁移为「坦克1」，代码与版本不丢', () => {
  const ls = makeBrowserStorage();
  ls.setItem(SAVE_KEY, JSON.stringify({ code: 'legacy', v: 5, n: 5 })); // 升级前版本写下的存量
  const t = anonLoad(ls);
  assert.deepEqual([t.name, t.code, t.v], ['坦克1', 'legacy', 5]);
});

test('e2e/匿名：关页重开（同浏览器）脚本还在；换浏览器/设备是全新空白', () => {
  const ls = makeBrowserStorage();
  anonSave(ls, 'my-code');
  assert.equal(anonLoad(ls).code, 'my-code'); // 同浏览器重开：loadStore 读回
  const otherDevice = makeBrowserStorage();
  assert.equal(anonLoad(otherDevice), null); // 换设备：无任何账号绑定，丢失
});

test('e2e/匿名：file:// 打开 SDK 一律不注入；http 默认只探测——匿名单机体验零回归', () => {
  assert.equal(sdkInjectDecision({ protocol: 'file:', search: '?play=1' }), 'no');
  assert.equal(sdkInjectDecision({ protocol: 'https:', search: '' }), 'probe');
  assert.equal(sdkInjectDecision({ protocol: 'https:', search: '?play=1' }), 'yes');
});

// ---------- 二、登录：云端数据从哪来、到哪去 ----------

test('e2e/登录：登录动作本身只拉云端面板（只读），不碰编辑器、不碰本地存档 → 与匿名数据不冲突', async () => {
  const ls = makeBrowserStorage();
  const cloud = makeCloud();
  const anonCode = 'anon-editor-code';
  anonSave(ls, anonCode);
  const editor = { value: anonCode };
  // 账号 alice 云端已有一版旧坦克
  await cloud.asUser('alice').Tank.create(buildTankPayload({ name: '云端旧坦克', code: 'cloud-code', skill: 'shield' }));
  // 登录 = refreshMyTank：只读 Tank.list 灌「我的坦克(云端)」面板
  const myTank = await cloudLatestTank(cloud.asUser('alice'));
  assert.equal(myTank.code, 'cloud-code'); // 面板显示云端版
  assert.equal(editor.value, anonCode); // 编辑器原样：登录不覆盖
  assert.equal(anonLoad(ls).code, anonCode); // 本地存档原样：登录不覆盖
});

test('e2e/登录：「生成我的坦克」把编辑器代码显式上云，version 在云端旧版上 +1，本地存档不动', async () => {
  const ls = makeBrowserStorage();
  const cloud = makeCloud();
  anonSave(ls, 'local-code');
  const db = cloud.asUser('alice');
  await db.Tank.create(buildTankPayload({ name: '我的坦克', code: 'old', skill: 'freeze', version: 3 }));
  const myTank = await cloudLatestTank(db);
  const payload = buildTankPayload({
    name: '我的坦克', code: 'editor-new-code', skill: 'freeze',
    version: myTank.v + 1, // app.js 车库云端保存同款：出战坦克 v+1
  });
  assert.equal(payload.version, 4); // 云端 3 → 4
  await db.Tank.create(payload);
  const latest = await cloudLatestTank(db);
  assert.equal(latest.code, 'editor-new-code');
  assert.equal(anonLoad(ls).code, 'local-code'); // 上云不回写本地
});

test('e2e/登录：「回填」把云端代码显式进编辑器；不写云端、不写本地——直到用户再点保存才落 agentank.save', async () => {
  const ls = makeBrowserStorage();
  const cloud = makeCloud();
  anonSave(ls, 'anon-code');
  const db = cloud.asUser('alice');
  await db.Tank.create(buildTankPayload({ name: 't', code: 'cloud-code', skill: 'boost' }));
  const editor = { value: 'anon-code' };
  // 用户点「回填」：只改编辑器
  editor.value = (await cloudLatestTank(db)).code;
  assert.equal(editor.value, 'cloud-code');
  assert.equal(anonLoad(ls).code, 'anon-code'); // 本地存档未动（此刻两边并存）
  assert.equal(cloud.tables.Tank.length, 1); // 云端未动
  // 用户再点「保存为新版本」：云端代码这才覆盖本地存档
  anonSave(ls, editor.value);
  assert.equal(anonLoad(ls).code, 'cloud-code');
});

test('e2e/登录：挑战赛战报逐局上云；owner scope + player 字段双重隔离，聚合只统计本人', async () => {
  const cloud = makeCloud();
  const alice = cloud.asUser('alice');
  const mkResult = (winner) => ({ winner, reason: 'hp', ticks: 200, stars: [1, 0] });
  await alice.BattleResult.create(buildBattleResultPayload({ seed: 11, map: 'ravine', opponent: 'stealth', result: mkResult(0), elo: 1216, player: 'alice' }));
  await alice.BattleResult.create(buildBattleResultPayload({ seed: 22, map: 'ravine', opponent: 'camper', result: mkResult(1), elo: 1200, player: 'alice' }));
  await cloud.asUser('mallory').BattleResult.create(buildBattleResultPayload({ seed: 33, map: 'ravine', opponent: 'stealth', result: mkResult(0), elo: 1300, player: 'mallory' }));
  // 第一重：owner scope——alice 只 list 到自己 2 条
  const mine = (await alice.BattleResult.list()).map(entityFields);
  assert.equal(mine.length, 2);
  // 第二重：即使混入他人行，player 过滤兜底
  const mixed = [...mine, { opponent: 'stealth', winner: 0, elo: 1300, player: 'mallory' }];
  const s = summarizeChallenge(mixed, 'alice');
  assert.equal(s.total, 2);
  assert.deepEqual({ w: s.wins, l: s.losses }, { w: 1, l: 1 });
});

// ---------- 三、换账号 / 登出：冲突边界 ----------

test('e2e/换账号：云端 Tank/战报按 owner 完全隔离，B 账号看不到 A 的任何云端数据', async () => {
  const cloud = makeCloud();
  await cloud.asUser('alice').Tank.create(buildTankPayload({ name: 'a', code: 'a-code', skill: 'freeze' }));
  await cloud.asUser('alice').BattleResult.create(buildBattleResultPayload({ seed: 1, map: 'm', opponent: 'o', result: { winner: 0, reason: 'hp', ticks: 100, stars: [0, 0] }, elo: 1210, player: 'alice' }));
  const bob = cloud.asUser('bob');
  assert.equal((await bob.Tank.list()).length, 0);
  assert.equal((await bob.BattleResult.list()).length, 0);
});

test('e2e/换账号：本地存档不分账号——同一浏览器里 B 登录后仍看到 A 留下的本地脚本（现状确认，见缺口2）', async () => {
  const ls = makeBrowserStorage();
  anonSave(ls, 'alice-local-code'); // A（或匿名期）留下的本地脚本
  // B 在同一浏览器登录：登录不清、不隔离本地存档
  const cloud = makeCloud();
  await cloudLatestTank(cloud.asUser('bob')); // B 的登录动作（只读云端）
  assert.equal(anonLoad(ls).code, 'alice-local-code'); // B 的编辑器启动时会灌入这份代码
});

test('e2e/登出：云端能力整体收口（面板隐藏、API 不可用），本地存档与匿名玩法原样保留', () => {
  const ls = makeBrowserStorage();
  anonSave(ls, 'keep-me');
  // 登出后 user=null → Agent Key 等云端面板 gate 关闭（display:none 零回归路径）
  const api = { create: () => {}, list: () => {}, revoke: () => {} };
  assert.equal(agentKeysGate({ user: { name: 'alice' }, api }), true);
  assert.equal(agentKeysGate({ user: null, api }), false);
  assert.equal(anonLoad(ls).code, 'keep-me'); // 本地不受登出影响
});

// ---------- 四、Agent Key（登录才有的身份物） ----------

test('e2e/AgentKey：匿名不可用；登录后限 3 把有效 key，吊销的不占额度；错误按 code 映射人话', () => {
  const keys3 = [
    { id: 'k1', status: 'active', created_at: '2026-08-01T00:00:00Z' },
    { id: 'k2', status: 'active' },
    { id: 'k3', status: 'revoked' },
  ];
  assert.equal(agentKeyLimitReached(keys3), false); // 2 active < 3
  assert.equal(agentKeyLimitReached([...keys3, { id: 'k4', status: 'active' }]), true);
  assert.equal(AGENT_KEY_MAX, 3);
  const rows = agentKeyRows(keys3);
  assert.deepEqual(rows.map((r) => r.statusKey), ['play.akStActive', 'play.akStActive', 'play.akStRevoked']);
  assert.equal(rows[2].revocable, false);
  assert.deepEqual(mapAgentKeyError({ code: 'AUTH_REQUIRED' }), { key: 'play.akErrAuth', vars: {} });
  assert.deepEqual(mapAgentKeyError({ code: 'AGENT_KEY_REVOKED' }), { key: 'play.akErrRevoked', vars: {} });
  const rate = mapAgentKeyError({ code: 'RATE_LIMITED', resetsAtMs: 10_000 }, 1_000);
  assert.deepEqual(rate, { key: 'play.akErrRate', vars: { secs: 9 } });
});

// ---------- 五、已确认的实现缺口（todo：跑 --test 会列出，不算失败；等用户逐条确认是否补） ----------

test('缺口1：匿名期打的战报，登录后不会自动补传云端——登录前战绩只在内存，一刷新就没了', { todo: true }, () => {});

test('缺口2：本地脚本存档（agentank.save）不按账号隔离——同一浏览器换账号会互相看到对方的本地脚本', { todo: true }, () => {});

test('缺口3已补（方案 v2）：登录时刻逐台按名字衔接——同名不同码检出为 conflict（二选一横幅），不再静默并存', () => {
  const local = [{ name: '坦克1', code: 'local-edit', skill: '', v: 2 }];
  const cloud = [{ id: 'e1', name: '坦克1', code: 'cloud-code', skill: 'freeze', v: 3, active: true }];
  const r = reconcileLogin(local, cloud);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual([r.conflicts[0].local.code, r.conflicts[0].cloud.v], ['local-edit', 3]);
  assert.deepEqual([r.upload, r.synced], [[], []]);
});

// ---------- 六、创作工坊：只存服务器端（缺口4 已按用户拍板改成云端 Workshop 实体） ----------

// 云端 Workshop 表仿真（owner 隔离 + update 软删，行形状与 /api/db 一致）
function makeWorkshopCloud() {
  let auto = 0;
  const rows = [];
  const bind = (owner) => ({
    list: async () => rows.filter((r) => r.owner === owner).map((r) => ({ id: r.id, fields: r.fields })),
    create: async (fields) => { const row = { owner, id: `w${++auto}`, fields }; rows.push(row); return { id: row.id, fields }; },
    update: async (id, patch) => {
      const r = rows.find((x) => x.id === id);
      if (r) r.fields = { ...r.fields, ...patch };
      return r ? { id: r.id, fields: r.fields } : null;
    },
  });
  return { asUser: bind, rows };
}

test('e2e/工坊：条目 ↔ Workshop 实体行往返无损（def 全量 JSON、stage 归一）；软删行/坏 def 解析为 null', () => {
  const entry = { type: 'map', id: 'mymap', name: '我的地图', rows: ['#########', '#A..g...#'], stage: 'private' };
  const payload = buildWorkshopPayload(entry);
  assert.deepEqual(
    [payload.type, payload.slug, payload.name, payload.stage, payload.is_active],
    ['map', 'mymap', '我的地图', 'private', true],
  );
  const back = parseWorkshopRow({ id: 'w1', fields: payload });
  assert.equal(back.rowId, 'w1');
  assert.deepEqual(back.entry, entry);
  assert.equal(parseWorkshopRow({ id: 'w2', fields: { ...payload, is_active: false } }), null); // 软删不回列表
  assert.equal(parseWorkshopRow({ id: 'w3', fields: { ...payload, def: '{bad json' } }), null); // 坏 def 静默跳过
});

test('e2e/工坊：登录后私有内容只进云端 Workshop（owner 隔离），本机 localStorage 零写入；换设备登录原样可见', async () => {
  const ls = makeBrowserStorage();
  const cloud = makeWorkshopCloud();
  const alice = cloud.asUser('alice');
  const entry = { type: 'skill', id: 'myskill', name: '我的技能', cd: 60, stage: 'private' };
  await alice.create(buildWorkshopPayload(entry)); // save 协议：无同 slug 行 → create
  assert.deepEqual(ls.keys(), []); // 本机零写入（agentank-workshop key 已废弃为只读迁移源）
  assert.equal((await cloud.asUser('bob').list()).length, 0); // owner 隔离：B 账号看不到
  // 换设备 = 新浏览器 + 同账号登录：list 重灌，内容原样
  const entries = (await alice.list()).map(parseWorkshopRow).filter(Boolean).map((p) => p.entry);
  assert.deepEqual(entries, [entry]);
});

test('e2e/工坊：同 slug 保存走 update（不长重复行）；删除 = is_active:false 软删，list 不再回', async () => {
  const cloud = makeWorkshopCloud();
  const db = cloud.asUser('alice');
  const v1 = { type: 'item', id: 'myitem', name: '道具v1', heal: 25, stage: 'private' };
  const { id } = await db.create(buildWorkshopPayload(v1));
  await db.update(id, buildWorkshopPayload({ ...v1, name: '道具v2', stage: 'shared' })); // 改动 + 晋升分享
  let live = (await db.list()).map(parseWorkshopRow).filter(Boolean);
  assert.equal(live.length, 1); // upsert：还是一行
  assert.deepEqual([live[0].entry.name, live[0].entry.stage], ['道具v2', 'shared']);
  await db.update(id, { is_active: false });
  live = (await db.list()).map(parseWorkshopRow).filter(Boolean);
  assert.equal(live.length, 0);
});

test('缺口5：匿名局没有本地战斗历史列表——只有当场的文字战报，想留痕只能手动复制分享串', { todo: true }, () => {});
