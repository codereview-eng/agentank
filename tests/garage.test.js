import test from 'node:test';
import assert from 'node:assert/strict';
import {
  garageFromRows,
  migrateLocalSave,
  upsertLocalTank,
  reconcileLogin,
  nextTankName,
  buildTankPayload,
} from '../web/play.js';

// ============================================================
// 多坦克车库（方案 v2）纯函数契约：
//   - 云端 Tank 每行一台坦克：name 分组、version 原地递增、is_active=出战；
//   - 本地匿名存档 agentank.save 升级为坦克列表（旧单份一次性迁移为「坦克1」）；
//   - 登录时刻逐台按名字衔接三分支：无同名→upload、同名同码→synced、同名不同码→conflict。
// ============================================================

// ---------- 云端行 → 车库 ----------

test('garage/行分组：每名一台；同名脏数据取最高 version；行形态兼容 {fields} 包裹', () => {
  const g = garageFromRows([
    { id: 'e1', fields: { name: '主攻', code: 'a', skill: 'boost', version: 2, is_active: false } },
    { id: 'e2', fields: { name: '防守', code: 'b', skill: 'shield', version: 5, is_active: true } },
    { id: 'e3', fields: { name: '主攻', code: 'a2', skill: 'boost', version: 3, is_active: false } }, // 同名脏数据：取 v3
  ]);
  assert.deepEqual(g.tanks.map((t) => [t.name, t.v, t.code]), [['主攻', 3, 'a2'], ['防守', 5, 'b']]);
  assert.equal(g.active.name, '防守'); // is_active=true 即出战
});

test('garage/出战判定：全未标 active 取最新入库；多台标 active 取最后一台；空车库 active=null', () => {
  const none = garageFromRows([
    { id: 'e1', name: 'a', code: '', version: 1, is_active: false },
    { id: 'e2', name: 'b', code: '', version: 1, is_active: false },
  ]);
  assert.equal(none.active.name, 'b');
  const multi = garageFromRows([
    { id: 'e1', name: 'a', code: '', version: 1, is_active: true },
    { id: 'e2', name: 'b', code: '', version: 1, is_active: true },
  ]);
  assert.equal(multi.active.name, 'b');
  assert.deepEqual(garageFromRows([]), { tanks: [], active: null });
});

test('garage/行清洗：无 name 的行跳过；version 缺省按 1', () => {
  const g = garageFromRows([
    { id: 'e1', fields: { code: 'orphan' } },
    { id: 'e2', fields: { name: 't', code: 'c' } },
  ]);
  assert.deepEqual(g.tanks.map((t) => [t.name, t.v]), [['t', 1]]);
});

// ---------- 本地存档迁移 ----------

test('garage/迁移：旧单份 {code,v,n} → 一台「坦克1」（v 保留）', () => {
  const s = migrateLocalSave(JSON.stringify({ code: 'legacy-code', v: 4, n: 4 }), '坦克1');
  assert.deepEqual(s, { tanks: [{ name: '坦克1', code: 'legacy-code', strategy: '', skill: '', v: 4 }], cur: '坦克1' });
});

test('garage/迁移：新格式透传并清洗（坏条目剔除、cur 失配回落第一台）', () => {
  const raw = JSON.stringify({
    tanks: [
      { name: '主攻', code: 'a', skill: 'boost', v: 2 },
      { name: '', code: 'x' }, // 无名：剔除
      { name: '坏的' }, // 无 code：剔除
    ],
    cur: '不存在的',
  });
  const s = migrateLocalSave(raw, '坦克1');
  assert.deepEqual(s, { tanks: [{ name: '主攻', code: 'a', strategy: '', skill: 'boost', v: 2 }], cur: '主攻' });
});

test('garage/迁移：空/坏/无内容存量一律安全返回空车库', () => {
  assert.deepEqual(migrateLocalSave(null, '坦克1'), { tanks: [], cur: null });
  assert.deepEqual(migrateLocalSave('{bad json', '坦克1'), { tanks: [], cur: null });
  assert.deepEqual(migrateLocalSave(JSON.stringify({ code: '   ' }), '坦克1'), { tanks: [], cur: null });
});

// ---------- 本地保存 ----------

test('garage/本地保存：同名递增 v、新名 v1、cur 跟随；不改入参 store', () => {
  const s0 = { tanks: [], cur: null };
  const r1 = upsertLocalTank(s0, { name: '坦克1', code: 'c1', skill: 'teleport' });
  assert.deepEqual([r1.v, r1.cur], [1, '坦克1']);
  const r2 = upsertLocalTank(r1, { name: '坦克1', code: 'c2', skill: 'teleport' });
  assert.equal(r2.v, 2);
  const r3 = upsertLocalTank(r2, { name: '坦克2', code: 'd1', skill: 'shield' });
  assert.deepEqual([r3.v, r3.cur], [1, '坦克2']);
  assert.deepEqual(r3.tanks.map((t) => [t.name, t.v]), [['坦克1', 2], ['坦克2', 1]]);
  assert.deepEqual(s0.tanks, []); // 入参不被改写
});

// ---------- 登录时刻衔接三分支 ----------

test('garage/衔接：无同名→upload；同名同码→synced；同名不同码→conflict（逐台判定）', () => {
  const local = [
    { name: '主攻', code: 'same', skill: 'boost', v: 2 },
    { name: '防守', code: 'local-ver', skill: 'shield', v: 1 },
    { name: '新兵', code: 'fresh', skill: '', v: 1 },
  ];
  const cloud = [
    { id: 'e1', name: '主攻', code: 'same', skill: 'boost', v: 3, active: true },
    { id: 'e2', name: '防守', code: 'cloud-ver', skill: 'shield', v: 4, active: false },
  ];
  const r = reconcileLogin(local, cloud);
  assert.deepEqual(r.synced, ['主攻']);
  assert.deepEqual(r.upload.map((t) => t.name), ['新兵']);
  assert.deepEqual(r.conflicts.map((c) => [c.local.name, c.cloud.v]), [['防守', 4]]);
});

test('garage/衔接：本地为空三分支全空；云端为空全部 upload', () => {
  assert.deepEqual(reconcileLogin([], [{ name: 'a', code: 'x' }]), { upload: [], conflicts: [], synced: [] });
  const r = reconcileLogin([{ name: 'a', code: 'x' }, { name: 'b', code: 'y' }], []);
  assert.deepEqual(r.upload.map((t) => t.name), ['a', 'b']);
});

// ---------- 命名 ----------

test('garage/命名：nextTankName 找最小可用编号（跳过占用）', () => {
  const mk = (n) => `坦克${n}`;
  assert.equal(nextTankName([], mk), '坦克1');
  assert.equal(nextTankName(['坦克1', '坦克3'], mk), '坦克2');
  assert.equal(nextTankName(['坦克1', '坦克2'], mk), '坦克3');
});

// ---------- 入库 payload（与 schema 对齐） ----------

test('garage/入库：一键入库 payload = 原名、v1、schema 六字段对齐（含 strategy）', () => {
  const p = buildTankPayload({ name: '坦克2·防守', code: 'c', skill: 'shield', version: 1, is_active: false });
  assert.deepEqual(Object.keys(p).sort(), ['code', 'is_active', 'name', 'skill', 'strategy', 'version']);
  assert.deepEqual([p.name, p.version, p.is_active], ['坦克2·防守', 1, false]);
});
