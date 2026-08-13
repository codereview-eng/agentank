import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildLlmPrompt,
  extractLlmCode,
  mapLlmError,
  buildTankPayload,
  migrateLocalSave,
  upsertLocalTank,
  garageFromRows,
} from '../web/play.js';
import { LOCALES } from '../web/i18n.js';

// ============================================================
// 策略文本优先（strategy-first）契约：
//   - 玩家第一优先改「策略文本」，点按钮调 SDK LLM 生成脚本；
//   - prompt 合同 = 引擎 API 契约摘要 + 装备技能 + 策略文本（spike 已验证真跑一局可行）；
//   - 提取/编译失败一律 fail-closed；strategy 字段贯通本地存档与云端 Tank 实体。
// ============================================================

// ---------- prompt 构造 ----------

test('strategy/prompt：包含策略文本、装备技能与关键 API 契约行', () => {
  const p = buildLlmPrompt({ strategy: '贴脸抢星，血量低就跑', skill: 'teleport' });
  assert.match(p, /贴脸抢星，血量低就跑/);
  assert.match(p, /teleport（8 选 1/);
  for (const api of ['api.me()', 'api.enemyVisible()', 'api.fireAt(p)', 'api.moveTo(p)', 'api.useSkill(p?)', 'api.nearestStar()', 'api.zone()']) {
    assert.ok(p.includes(api), `prompt 缺 API 契约：${api}`);
  }
  assert.match(p, /export default function decide\(api\)/);
});

test('strategy/prompt：重试时带上一轮编译错误，首轮不带', () => {
  const p1 = buildLlmPrompt({ strategy: 's', skill: 'boost' });
  assert.ok(!p1.includes('编译失败'));
  const p2 = buildLlmPrompt({ strategy: 's', skill: 'boost', feedback: 'foo is not defined' });
  assert.match(p2, /编译失败.*foo is not defined/);
});

// ---------- 代码提取（fail-closed） ----------

test('strategy/提取：```js 围栏、```javascript 围栏、无围栏裸代码均可取', () => {
  const code = 'export default function decide(api) { return api.patrol(); }';
  assert.equal(extractLlmCode('```js\n' + code + '\n```'), code);
  assert.equal(extractLlmCode('好的：\n```javascript\n' + code + '\n```\n以上。'), code);
  assert.equal(extractLlmCode(code), code);
});

test('strategy/提取：纯解释文字（无 decide 入口）返回 null，不静默塞坏代码', () => {
  assert.equal(extractLlmCode('抱歉，请告诉我更多信息。'), null);
  assert.equal(extractLlmCode(''), null);
  assert.equal(extractLlmCode(null), null);
  assert.equal(extractLlmCode('```js\nconst x = 1;\n```'), null); // 有代码但无入口
});

// ---------- 错误映射 ----------

test('strategy/错误映射：登录/配额/超时各归其位，未知码透传 hint', () => {
  assert.equal(mapLlmError({ code: 'AUTH_REQUIRED' }).key, 'play.genNeedLogin');
  assert.equal(mapLlmError({ code: 'TOKEN_EXPIRED' }).key, 'play.genNeedLogin');
  const q = mapLlmError({ code: 'LLM_QUOTA_EXCEEDED', hint: 'resets at 12:00' });
  assert.deepEqual([q.key, q.vars.hint], ['play.genQuota', 'resets at 12:00']);
  assert.equal(mapLlmError({ code: 'LLM_TIMEOUT' }).key, 'play.genTimeout');
  const u = mapLlmError({ code: 'LLM_UPSTREAM_ERROR', hint: 'boom' });
  assert.deepEqual([u.key, u.vars.msg], ['play.genFail', 'boom']);
});

// ---------- strategy 字段贯通 ----------

test('strategy/贯通：Tank payload 六字段含 strategy（缺省空串）', () => {
  const p = buildTankPayload({ name: 't', code: 'c', strategy: '苟到最后', skill: 'cloak', version: 2 });
  assert.deepEqual(Object.keys(p).sort(), ['code', 'is_active', 'name', 'skill', 'strategy', 'version']);
  assert.equal(p.strategy, '苟到最后');
  assert.equal(buildTankPayload({ name: 't', code: 'c' }).strategy, '');
});

test('strategy/贯通：本地存档/云端行/保存递增均带 strategy，旧存量缺省空串', () => {
  // 本地新格式透传
  const s = migrateLocalSave(JSON.stringify({ tanks: [{ name: 'a', code: 'c', strategy: '控图', v: 2 }], cur: 'a' }), '坦克1');
  assert.equal(s.tanks[0].strategy, '控图');
  // 旧单份迁移：strategy 缺省空串
  const old = migrateLocalSave(JSON.stringify({ code: 'legacy', v: 3, n: 3 }), '坦克1');
  assert.equal(old.tanks[0].strategy, '');
  // 保存递增：strategy 跟随
  const r = upsertLocalTank(s, { name: 'a', code: 'c2', strategy: '改打贴脸', skill: '' });
  assert.deepEqual([r.tanks[0].strategy, r.tanks[0].v], ['改打贴脸', 3]);
  // 云端行分组：fields.strategy 透传
  const g = garageFromRows([{ id: 'e1', fields: { name: 'a', code: 'c', strategy: '蹲草', version: 1, is_active: true } }]);
  assert.equal(g.tanks[0].strategy, '蹲草');
});

// ---------- DOM / i18n 契约 ----------

test('strategy/DOM 契约：策略区、生成按钮、折叠脚本窗（默认收起）都在', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="strategyBox"/);
  assert.match(html, /id="genBtn"/);
  assert.match(html, /id="genMsg"/);
  assert.match(html, /<details id="codeBox"/);
  assert.ok(!/<details id="codeBox"[^>]*\bopen\b/.test(html), 'codeBox 必须默认折叠（脚本细节默认隐藏）');
  assert.match(html, /id="editor"/);
});

test('strategy/i18n：zh/en 生成流程键成对存在', () => {
  const keys = ['genLoginBtn', 'genUnavailable', 'genEmpty', 'genRunning', 'genRetry', 'genDone', 'genFail', 'genNeedLogin', 'genQuota', 'genTimeout', 'codeEdited'];
  for (const k of keys) {
    assert.equal(typeof LOCALES.zh.play[k], 'string', `zh play.${k}`);
    assert.equal(typeof LOCALES.en.play[k], 'string', `en play.${k}`);
  }
  for (const k of ['strategyPh', 'genBtn', 'codeBox']) {
    assert.equal(typeof LOCALES.zh.ui[k], 'string', `zh ui.${k}`);
    assert.equal(typeof LOCALES.en.ui[k], 'string', `en ui.${k}`);
  }
});
