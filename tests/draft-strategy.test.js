// 战术文字零丢失：编辑器/战术框内容的最终裁决（坦克 vs 未保存草稿）
// 复现的线上故障（2026-08-19）：登录后云端接管用云端的空 strategy 覆盖了正在写的战术文字，
// 并紧接着 clearDraft() 抹掉草稿 → 刷新后战术文字彻底消失，而代码因为云端存了所以还在。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEditorState, draftIsClean } from '../web/play.js';

const DEFAULT_CODE = 'export default function decide(api) { return api.patrol(); }';
const DEFAULT_STRATEGY = '优先抢星，血少就撤';
const isDefaultCode = (c) => String(c || '').replace(/\s+/g, '') === DEFAULT_CODE.replace(/\s+/g, '');
const base = { defaultCode: DEFAULT_CODE, defaultStrategy: DEFAULT_STRATEGY, isDefaultCode };

test('线上故障复现：云端 strategy 为空时，绝不能覆盖掉草稿里的战术文字', () => {
  const tank = { name: 'tankbase', code: 'function decide(){ return 1 }', strategy: '' }; // 云端实测：strategy 全空
  const draft = { cur: 'tankbase', code: 'function decide(){ return 2 }', strategy: '贴脸压制，血少撤退' };
  const r = resolveEditorState({ tank, draft, cur: 'tankbase', ...base });
  assert.equal(r.strategy, '贴脸压制，血少撤退'); // ← 修复前这里是 ''
  assert.equal(r.code, 'function decide(){ return 2 }');
  assert.equal(r.fromDraft, true);
});

test('匿名期写的草稿要能衔接到登录后的出战坦克（cur 从 null 变成坦克名）', () => {
  const tank = { name: 'tankbase', code: 'cloud-code', strategy: '' };
  const draft = { cur: null, code: 'anon-code', strategy: '登录前写的战术' };
  const r = resolveEditorState({ tank, draft, cur: 'tankbase', ...base });
  assert.equal(r.strategy, '登录前写的战术');
  assert.equal(r.code, 'anon-code');
});

test('草稿属于别的坦克时不串台', () => {
  const tank = { name: 'tankbase', code: 'cloud-code', strategy: '云端战术' };
  const draft = { cur: '另一台', code: 'other-code', strategy: '另一台的战术' };
  const r = resolveEditorState({ tank, draft, cur: 'tankbase', ...base });
  assert.equal(r.code, 'cloud-code');
  assert.equal(r.strategy, '云端战术');
  assert.equal(r.fromDraft, false);
});

test('草稿战术为空时不擦掉坦克已存的战术（零丢失优先）', () => {
  const tank = { name: 't', code: 'cloud-code', strategy: '坦克存的战术' };
  const draft = { cur: 't', code: 'draft-code', strategy: '' };
  const r = resolveEditorState({ tank, draft, cur: 't', ...base });
  assert.equal(r.code, 'draft-code');       // 代码用草稿（未保存的改动要留住）
  assert.equal(r.strategy, '坦克存的战术'); // 战术不被空草稿擦掉
});

test('坦克存了战术就用坦克的；没存且代码仍是默认脚本 → 给默认战术文本', () => {
  assert.equal(resolveEditorState({ tank: { code: 'x', strategy: '存过的' }, draft: null, cur: 't', ...base }).strategy, '存过的');
  assert.equal(resolveEditorState({ tank: { code: DEFAULT_CODE, strategy: '' }, draft: null, cur: 't', ...base }).strategy, DEFAULT_STRATEGY);
  assert.equal(resolveEditorState({ tank: { code: 'custom', strategy: '' }, draft: null, cur: 't', ...base }).strategy, '');
});

test('尚无坦克（首访）→ 默认代码 + 默认战术文本', () => {
  const r = resolveEditorState({ tank: null, draft: null, cur: null, ...base });
  assert.equal(r.code, DEFAULT_CODE);
  assert.equal(r.strategy, DEFAULT_STRATEGY);
});

test('空草稿 / 只有空白的草稿一律忽略', () => {
  const tank = { name: 't', code: 'cloud-code', strategy: '云端战术' };
  for (const draft of [null, undefined, { cur: 't', code: '   ', strategy: '' }, { cur: 't' }]) {
    const r = resolveEditorState({ tank, draft, cur: 't', ...base });
    assert.equal(r.code, 'cloud-code', JSON.stringify(draft));
    assert.equal(r.strategy, '云端战术');
  }
});

test('draftIsClean：只有草稿与坦克逐字一致才允许清草稿（否则清掉=丢用户改动）', () => {
  const tank = { name: 't', code: 'c', strategy: 's' };
  assert.equal(draftIsClean({ cur: 't', code: 'c', strategy: 's' }, tank), true);
  assert.equal(draftIsClean({ cur: 't', code: 'c', strategy: '改过的战术' }, tank), false); // ← 线上正是这种情况被清掉了
  assert.equal(draftIsClean({ cur: 't', code: '改过的代码', strategy: 's' }, tank), false);
  assert.equal(draftIsClean(null, tank), true); // 没草稿 = 无需保留
  assert.equal(draftIsClean({ cur: '别的坦克', code: 'x', strategy: 'y' }, tank), false); // 别台的草稿不归这里清
});
