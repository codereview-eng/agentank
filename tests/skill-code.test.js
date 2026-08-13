import test from 'node:test';
import assert from 'node:assert/strict';
import { skillCodeMismatch, SKILL_IDS } from '../web/play.js';
import { LOCALES } from '../web/i18n.js';

// ============================================================
// 技能装备与代码调用的一致性契约：
//   - 装备由下拉框决定（app.js 挂 guarded.skill），代码只决定何时施放；
//   - 引擎旧入口（api.teleport/cloak/stun）与 api.ready('技能名')
//     在装备不符时按 no-op/false 处理——静默失效；
//   - 默认模板必须技能无关（api.ready() + api.useSkill()），8 选 1 通吃；
//   - 用户改过的代码不动，靠 skillCodeMismatch 检出点名失效并提醒。
// ============================================================

// ---------- 不符检测纯函数 ----------

test('skill-code/检测：旧入口点名（teleport/cloak/stun）与装备不符 → 检出；装备一致不报', () => {
  const code = "if (api.ready('teleport')) return api.teleport(api.safestCorner());";
  assert.deepEqual(skillCodeMismatch(code, 'shield'), ['teleport']);
  assert.deepEqual(skillCodeMismatch(code, 'teleport'), []);
  assert.deepEqual(skillCodeMismatch('return api.cloak();', 'boost'), ['cloak']);
  assert.deepEqual(skillCodeMismatch('return api.stun();', 'stun'), []);
});

test('skill-code/检测：ready("技能名") 双引号/空白变体检出；bomb/fire 非技能名不报', () => {
  assert.deepEqual(skillCodeMismatch('api . ready ( "freeze" )', 'shield'), ['freeze']);
  assert.deepEqual(skillCodeMismatch("api.ready('bomb') && api.ready('fire')", 'shield'), []);
  assert.deepEqual(skillCodeMismatch('api.ready()', 'shield'), []); // 无参 = 通用，永不报
});

test('skill-code/检测：注释里的点名不算调用；空代码/非字符串安全返回空', () => {
  const code = "// api.teleport(...) 已废弃\n/* api.ready('stun') */\nreturn api.patrol();";
  assert.deepEqual(skillCodeMismatch(code, 'shield'), []);
  assert.deepEqual(skillCodeMismatch('', 'shield'), []);
  assert.deepEqual(skillCodeMismatch(null, 'shield'), []);
});

test('skill-code/检测：多处点名去重并全部列出', () => {
  const code = "api.ready('teleport'); api.teleport({x:1,y:1}); api.cloak();";
  assert.deepEqual(skillCodeMismatch(code, 'boost').sort(), ['cloak', 'teleport']);
});

// ---------- 默认模板技能无关 ----------

test('skill-code/模板：双语默认模板对全部 8 个技能零不符（换技能零感知）', () => {
  assert.equal(SKILL_IDS.length, 8);
  for (const lang of ['zh', 'en']) {
    const tpl = LOCALES[lang].script.default;
    for (const s of SKILL_IDS) {
      assert.deepEqual(skillCodeMismatch(tpl, s), [], `${lang} 模板在装备 ${s} 时不应有失效点名`);
    }
  }
});

test('skill-code/模板：残血 + 技能就绪 → useSkill 通用施放（任意装备都会真的放技能）', () => {
  for (const lang of ['zh', 'en']) {
    const tpl = LOCALES[lang].script.default;
    const fn = new Function(tpl.replace(/export\s+default\s+/g, '') + '\n;return decide;')();
    const readyCalls = [];
    const api = {
      me: () => ({ hp: 20 }),
      nearestStar: () => null,
      enemyVisible: () => false,
      canFire: () => false,
      ready: (n) => { readyCalls.push(n); return n == null; }, // 引擎语义：无参 = 所装备技能
      useSkill: (p) => ({ type: 'skill', ...(p || {}) }),
      safestCorner: () => ({ x: 1, y: 1 }),
      fireAt: () => ({}), enemy: () => ({}), moveTo: () => ({}), patrol: () => ({ type: 'idle' }),
    };
    const act = fn(api);
    assert.equal(act.type, 'skill', `${lang} 模板残血时应施放所装备技能`);
    assert.deepEqual([act.x, act.y], [1, 1]); // 传坐标：传送可用，其它技能引擎侧忽略
    assert.deepEqual(readyCalls, [undefined], `${lang} 模板应使用无参 ready()`);
  }
});
