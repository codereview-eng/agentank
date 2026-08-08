import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, LANGS, fmt, resolveLang } from '../web/i18n.js';
import { RULES, PRESET_MAPS } from '../src/engine/index.js';

const CJK = /[\u4e00-\u9fff]/;

// 递归收集叶子键路径（字典结构必须 zh/en 完全同构）
function leafPaths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') out.push(...leafPaths(v, p));
    else out.push(p);
  }
  return out.sort();
}

function leafAt(obj, path) {
  return path.split('.').reduce((o, k) => o[k], obj);
}

test('LOCALES：恰好 zh/en 两种语言，LANGS 对齐', () => {
  assert.deepEqual(Object.keys(LOCALES).sort(), ['en', 'zh']);
  assert.deepEqual([...LANGS].sort(), ['en', 'zh']);
});

test('键位对齐：zh/en 叶子键路径完全同构', () => {
  assert.deepEqual(leafPaths(LOCALES.zh), leafPaths(LOCALES.en));
});

test('语言纯净度：en 全部叶子无中文；zh 整体含中文', () => {
  for (const p of leafPaths(LOCALES.en)) {
    const v = leafAt(LOCALES.en, p);
    assert.ok(!CJK.test(String(v)), `en.${p} 不应含中文：${v}`);
  }
  assert.ok(leafPaths(LOCALES.zh).some((p) => CJK.test(String(leafAt(LOCALES.zh, p)))), 'zh 应含中文');
});

test('占位符对齐：同一键的 zh/en 模板 {token} 集合一致', () => {
  const tokens = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const p of leafPaths(LOCALES.zh)) {
    assert.deepEqual(
      tokens(leafAt(LOCALES.zh, p)), tokens(leafAt(LOCALES.en, p)),
      `${p} 占位符不一致`,
    );
  }
});

test('覆盖面：技能 8、道具 6、终局判定链 6、地图 13 全部有词条', () => {
  for (const lang of LANGS) {
    const L = LOCALES[lang];
    assert.deepEqual(
      Object.keys(L.skill).sort(),
      ['boost', 'cloak', 'freeze', 'overload', 'poison', 'shield', 'stun', 'teleport'],
      `${lang}.skill 应恰好覆盖 8 技能`,
    );
    assert.deepEqual(Object.keys(L.item).sort(), [...RULES.items.kinds].sort(), `${lang}.item 应对齐 RULES.items.kinds`);
    for (const r of ['kill', 'stars', 'hp', 'damage', 'center', 'coin']) {
      assert.ok(L.reason[r], `${lang}.reason.${r} 缺失`);
    }
    assert.deepEqual(
      Object.keys(L.maps).sort(),
      PRESET_MAPS.map((m) => m.id).sort(),
      `${lang}.maps 应恰好覆盖全部预置图`,
    );
    for (const id of Object.keys(L.maps)) {
      assert.ok(L.maps[id].name && L.maps[id].desc, `${lang}.maps.${id} 需有 name/desc`);
    }
  }
  // zh 地图词条必须与引擎 PRESET_MAPS 保持同源（防止两处文案漂移）
  for (const m of PRESET_MAPS) {
    assert.equal(LOCALES.zh.maps[m.id].name, m.name, `zh.maps.${m.id}.name 应与引擎一致`);
    assert.equal(LOCALES.zh.maps[m.id].desc, m.desc, `zh.maps.${m.id}.desc 应与引擎一致`);
  }
});

test('fmt：占位符替换与缺参原样保留', () => {
  assert.equal(fmt('{a} 命中 {b}', { a: 'X', b: 'Y' }), 'X 命中 Y');
  assert.equal(fmt('hit {n}', {}), 'hit {n}');
  assert.equal(fmt('t={t}', { t: 0 }), 't=0');
});

test('resolveLang：?lang= > 存储 > 浏览器语言 > 默认 zh，非法值回落', () => {
  assert.equal(resolveLang('en', null, 'zh-CN'), 'en');
  assert.equal(resolveLang('fr', 'en', 'zh-CN'), 'en');
  assert.equal(resolveLang(null, 'zh', 'en-US'), 'zh');
  assert.equal(resolveLang(null, null, 'en-US'), 'en');
  assert.equal(resolveLang(null, null, 'zh-CN'), 'zh');
  assert.equal(resolveLang(null, null, null), 'zh');
});
