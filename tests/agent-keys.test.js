import test from 'node:test';
import assert from 'node:assert/strict';
import { agentKeysGate, agentKeyRows, agentKeyLimitReached, mapAgentKeyError } from '../web/play.js';
import { LOCALES, LANGS } from '../web/i18n.js';

// ---------- gated 判定：登录态 + agentKeys API 面齐备才亮 ----------
test('agentKeysGate: 未登录/无 API 一律 false，登录+全 API 面才 true', () => {
  const api = { create: () => {}, list: () => {}, revoke: () => {} };
  assert.equal(agentKeysGate({ user: null, api }), false);
  assert.equal(agentKeysGate({ user: undefined, api }), false);
  assert.equal(agentKeysGate({ user: { id: 'u1' }, api: null }), false);
  assert.equal(agentKeysGate({ user: { id: 'u1' }, api: undefined }), false);
  assert.equal(agentKeysGate({ user: { id: 'u1' }, api }), true);
});

test('agentKeysGate: API 面残缺（缺 create/list/revoke 任一）即 false', () => {
  const fn = () => {};
  assert.equal(agentKeysGate({ user: { id: 'u1' }, api: { list: fn, revoke: fn } }), false);
  assert.equal(agentKeysGate({ user: { id: 'u1' }, api: { create: fn, revoke: fn } }), false);
  assert.equal(agentKeysGate({ user: { id: 'u1' }, api: { create: fn, list: fn } }), false);
  assert.equal(agentKeysGate({ user: { id: 'u1' }, api: { create: fn, list: fn, revoke: 1 } }), false);
});

// ---------- 列表渲染数据：纯函数产出行数据，不碰 DOM ----------
test('agentKeyRows: 字段映射 + 空 last_used_at 显示占位符', () => {
  const rows = agentKeyRows([
    { id: 'ak_aaa', status: 'active', created_at: '2026-08-12T03:00:00Z', last_used_at: null },
    { id: 'ak_bbb', status: 'revoked', created_at: '2026-08-11T01:00:00Z', last_used_at: '2026-08-11T02:00:00Z', revoked_at: '2026-08-11T03:00:00Z' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, 'ak_aaa');
  assert.equal(rows[0].statusKey, 'play.akStActive');
  assert.equal(rows[0].revocable, true);
  assert.equal(rows[0].lastUsed, '—');
  assert.ok(rows[0].created.includes('2026'));
  assert.equal(rows[1].statusKey, 'play.akStRevoked');
  assert.equal(rows[1].revocable, false);
  assert.ok(rows[1].lastUsed.includes('2026'));
});

test('agentKeyRows: 非法输入零容忍回空数组', () => {
  assert.deepEqual(agentKeyRows(null), []);
  assert.deepEqual(agentKeyRows(undefined), []);
  assert.deepEqual(agentKeyRows('x'), []);
});

// ---------- 限额：每 slug 限 3 把（只数 active） ----------
test('agentKeyLimitReached: 3 把 active 即满，revoked 不占额', () => {
  const a = (id) => ({ id, status: 'active' });
  const r = (id) => ({ id, status: 'revoked' });
  assert.equal(agentKeyLimitReached([a('1'), a('2')]), false);
  assert.equal(agentKeyLimitReached([a('1'), a('2'), a('3')]), true);
  assert.equal(agentKeyLimitReached([a('1'), a('2'), r('3'), r('4')]), false);
  assert.equal(agentKeyLimitReached([]), false);
  assert.equal(agentKeyLimitReached(null), false);
});

// ---------- 错误映射：PlayError {code,message,hint} → i18n key ----------
test('mapAgentKeyError: 已知 code 映射到专属词条', () => {
  assert.deepEqual(mapAgentKeyError({ code: 'AUTH_REQUIRED', message: 'x' }), { key: 'play.akErrAuth', vars: {} });
  assert.deepEqual(mapAgentKeyError({ code: 'AGENT_KEY_REVOKED', message: 'x' }), { key: 'play.akErrRevoked', vars: {} });
  assert.deepEqual(mapAgentKeyError({ code: 'QUOTA_EXCEEDED', message: 'x' }), { key: 'play.akErrQuota', vars: {} });
});

test('mapAgentKeyError: RATE_LIMITED 带 resetsAtMs 换算成秒（向上取整、不为负）', () => {
  const now = 1000000;
  assert.deepEqual(
    mapAgentKeyError({ code: 'RATE_LIMITED', resetsAtMs: now + 4200 }, now),
    { key: 'play.akErrRate', vars: { secs: 5 } },
  );
  assert.deepEqual(
    mapAgentKeyError({ code: 'RATE_LIMITED', quota: { resetsAtMs: now + 1 } }, now),
    { key: 'play.akErrRate', vars: { secs: 1 } },
  );
  assert.deepEqual(
    mapAgentKeyError({ code: 'RATE_LIMITED', resetsAtMs: now - 99 }, now),
    { key: 'play.akErrRate', vars: { secs: 0 } },
  );
});

test('mapAgentKeyError: 未知 code 回通用词条，带 code+msg（hint 拼进 msg）', () => {
  assert.deepEqual(
    mapAgentKeyError({ code: 'CONTRACT_VIOLATION', message: 'boom' }),
    { key: 'play.akErrGeneric', vars: { code: 'CONTRACT_VIOLATION', msg: 'boom' } },
  );
  assert.deepEqual(
    mapAgentKeyError({ code: 'X', message: 'm', hint: 'h' }),
    { key: 'play.akErrGeneric', vars: { code: 'X', msg: 'm (h)' } },
  );
  assert.deepEqual(
    mapAgentKeyError(new Error('net down')),
    { key: 'play.akErrGeneric', vars: { code: 'UNKNOWN', msg: 'net down' } },
  );
});

// ---------- i18n：mapping 引用的全部词条 zh/en 双语在位 ----------
test('agent-key 词条: zh/en 全量在位（含状态/按钮/警示）', () => {
  const need = [
    'akTitle', 'akCreate', 'akCopy', 'akCopied', 'akRevoke', 'akOnce', 'akEmpty', 'akLimit',
    'akThId', 'akThStatus', 'akThCreated', 'akThLastUsed', 'akThAction',
    'akStActive', 'akStRevoked',
    'akErrAuth', 'akErrRevoked', 'akErrQuota', 'akErrRate', 'akErrGeneric',
  ];
  for (const lang of LANGS) {
    for (const k of need) {
      assert.ok(typeof LOCALES[lang].play[k] === 'string' && LOCALES[lang].play[k], `${lang}.play.${k} 缺失`);
    }
  }
});
