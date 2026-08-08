import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runMatch, mapFromAscii, tileAt, TILE,
  validateContent, makePack, serializePack, parsePack,
  resolvePackMap, compileBot, promoteStage, STAGES, OFFICIAL_CONTENT,
} from '../src/engine/index.js';

const idle = () => null;

// ---- 样例内容（四类全声明式，可 JSON 序列化）----
const MAP_DEF = {
  type: 'map',
  id: 'ravine',
  name: '峡谷',
  desc: '中央窄谷，两侧高地',
  rows: [
    '#########',
    '#A..g...#',
    '#..DD...#',
    '#.......#',
    '#...*...#',
    '#.......#',
    '#...DD..#',
    '#...g..B#',
    '#########',
  ],
};
const SKILL_DEF = {
  type: 'skill',
  id: 'frostnova',
  name: '霜冻新星',
  cd: 50,
  effect: { kind: 'freeze', dur: 5 },
};
const ITEM_DEF = {
  type: 'item',
  id: 'nitro',
  name: '氮气罐',
  effect: { kind: 'boost', dur: 4 },
};
const BOT_DEF = {
  type: 'bot',
  id: 'sniper',
  name: '狙击流',
  skill: 'shield',
  code: 'export default function decide(api) {\n  if (api.enemyVisible() && api.canFire()) return api.fireAt(api.enemy());\n  return null;\n}',
};

test('validateContent：四类合法定义全部通过', () => {
  for (const def of [MAP_DEF, SKILL_DEF, ITEM_DEF, BOT_DEF]) {
    const r = validateContent(def);
    assert.equal(r.ok, true, `${def.type}/${def.id} 应通过校验：${(r.errors || []).join('；')}`);
  }
});

test('validateContent：非法内容拒收并给出中文原因', () => {
  const bads = [
    [{ ...SKILL_DEF, id: '中文id' }, 'id 非法'],
    [{ ...SKILL_DEF, cd: 1 }, 'cd 越界'],
    [{ ...SKILL_DEF, effect: { kind: 'nuke' } }, '未知效果原语'],
    [{ ...ITEM_DEF, effect: { kind: 'nuke' } }, '未知效果原语'],
    [{ ...MAP_DEF, rows: ['#####', '#A.B#'] }, '地图无封底'],
    [{ ...MAP_DEF, rows: ['#########', '#A..#..B#', '#########'] }, 'A/B 不连通'],
    [{ ...BOT_DEF, code: 'x'.repeat(5000) }, '代码超长'],
    [{ type: 'wand', id: 'x1', name: 'x' }, '未知类型'],
  ];
  for (const [def, why] of bads) {
    const r = validateContent(def);
    assert.equal(r.ok, false, `应拒收（${why}）`);
    assert.ok(r.errors.length >= 1 && /[\u4e00-\u9fff]/.test(r.errors[0]), '错误原因应为中文');
  }
});

test('内容包：makePack 默认 stage=private，序列化往返逐字段一致，坏串安全报错', () => {
  const pack = makePack([MAP_DEF, SKILL_DEF, ITEM_DEF, BOT_DEF], { author: 'zkf' });
  assert.equal(pack.formatVersion, 1);
  assert.ok(pack.entries.every((e) => e.stage === 'private'), '新内容默认私有（阶段1）');
  const s = serializePack(pack);
  assert.equal(typeof s, 'string');
  const back = parsePack(s);
  assert.deepEqual(back, pack, '往返应逐字段一致');
  assert.throws(() => parsePack('!!!not-a-pack!!!'), /内容包/, '坏串应给中文报错');
  assert.throws(() => parsePack(serializePack({ formatVersion: 1, entries: [{ type: 'skill', id: 'bad', name: 'x', cd: 1, effect: { kind: 'freeze' } }] })), /校验/, '带非法条目的串应整体拒收');
});

test('阶段流转：private→shared→official 逐级晋升，越级/回退拒绝', () => {
  assert.deepEqual(STAGES, ['private', 'shared', 'official']);
  const e = { ...SKILL_DEF, stage: 'private' };
  const shared = promoteStage(e);
  assert.equal(shared.stage, 'shared', '阶段1→2');
  const official = promoteStage(shared);
  assert.equal(official.stage, 'official', '阶段2→3');
  assert.throws(() => promoteStage(official), /official/, '已官方收录不可再晋升');
});

test('自定义地图实跑：resolvePackMap 转引擎地图并可开局', () => {
  const pack = makePack([MAP_DEF]);
  const map = resolvePackMap(pack, 'ravine');
  assert.ok(map && map.width === 9 && map.height === 9);
  assert.equal(tileAt(map, 4, 2), TILE.DIRT);
  const r = runMatch({ seed: 7, map, botA: idle, botB: idle, maxTicks: 30 });
  assert.ok(r.ticks > 0 && Array.isArray(r.events));
  assert.equal(resolvePackMap(pack, 'no-such'), null);
});

test('自定义技能实跑：装备 pack 技能按效果原语生效（事件 name=自定义 id）', () => {
  const map = mapFromAscii(['######', '#A.B.#', '######']);
  const pack = makePack([SKILL_DEF]);
  const A = (api) => (api.ready() ? api.useSkill() : null);
  const B = (api) => api.moveTo({ x: 4, y: 1 });
  const r = runMatch({ seed: 1, map, botA: A, botB: B, skillA: 'frostnova', content: pack, maxTicks: 12 });
  assert.ok(r.events.some((e) => e.type === 'skill' && e.name === 'frostnova' && e.who === 0), 'skill 事件应带自定义 id');
  const fh = r.events.find((e) => e.type === 'freeze_hit' && e.target === 1);
  assert.ok(fh, '应按 freeze 原语生效');
  assert.equal(fh.duration, 5, '时长应用自定义参数');
});

test('未带内容包时装备未知技能应报错（不静默）', () => {
  const map = mapFromAscii(['#####', '#A.B#', '#####']);
  assert.throws(() => runMatch({ seed: 1, map, botA: idle, botB: idle, skillA: 'frostnova', maxTicks: 3 }), /frostnova/);
});

test('自定义道具实跑：pack 道具进刷新池，拾取按原语生效（kind=自定义 id）', () => {
  const map = mapFromAscii(['##########', '#A.......#', '#.......B#', '##########']);
  const pack = makePack([ITEM_DEF]);
  const r = runMatch({
    seed: 1, map, botA: (api) => api.moveTo({ x: 8, y: 1 }), botB: idle, content: pack,
    rules: { zone: { start: 9999 }, items: { start: 0, every: 100, max: 1, kinds: ['nitro'], forceAt: { x: 1, y: 1 } } },
    maxTicks: 8,
  });
  const pick = r.events.find((e) => e.type === 'item_pick' && e.who === 0);
  assert.ok(pick && pick.kind === 'nitro', 'item_pick.kind 应为自定义 id');
  const moves = r.events.filter((e) => e.type === 'move' && e.who === 0 && e.t === pick.t);
  assert.ok(moves.length >= 2, 'boost 原语应生效（当拍走 2 格）');
});

test('自定义 bot：compileBot 编译 decide 源码可实跑且确定性', () => {
  const bot = compileBot(BOT_DEF);
  assert.equal(typeof bot, 'function');
  assert.equal(bot.skill, 'shield', 'bot 默认技能应带出');
  const map = () => mapFromAscii(['##########', '#A......B#', '##########']);
  const r1 = runMatch({ seed: 3, map: map(), botA: bot, botB: idle, maxTicks: 40 });
  const r2 = runMatch({ seed: 3, map: map(), botA: compileBot(BOT_DEF), botB: idle, maxTicks: 40 });
  assert.ok(r1.events.some((e) => e.type === 'fire' && e.who === 0), '狙击流应开火');
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), '同 seed 同代码应逐字节一致');
  assert.throws(() => compileBot({ ...BOT_DEF, code: 'const x = 1;' }), /decide/, '无 decide 入口应报错');
});

test('战报自带内容包（阶段2 重现凭据）：result.content 深等于传入 pack 且逐字节可重现', () => {
  const pack = makePack([MAP_DEF, SKILL_DEF, ITEM_DEF], { author: 'zkf' });
  const run = () => runMatch({
    seed: 11, map: resolvePackMap(pack, 'ravine'),
    botA: (api) => (api.ready() ? api.useSkill() : api.patrol()), botB: (api) => api.patrol(),
    skillA: 'frostnova', content: pack, maxTicks: 80,
  });
  const r1 = run();
  assert.deepEqual(r1.content, pack, '战报应嵌入完整内容包');
  assert.equal(JSON.stringify(r1), JSON.stringify(run()), '凭战报参数+内容包应逐字节重现');
  const plain = runMatch({ seed: 1, map: mapFromAscii(['#####', '#A.B#', '#####']), botA: idle, botB: idle, maxTicks: 3 });
  assert.equal(plain.content, undefined, '未用内容包的战报不应有 content 字段');
});

test('阶段3 官方收录：OFFICIAL_CONTENT 全部校验通过且 stage=official', () => {
  assert.ok(Array.isArray(OFFICIAL_CONTENT) && OFFICIAL_CONTENT.length >= 4, '官方列表应含四类收录示例');
  const types = new Set(OFFICIAL_CONTENT.map((e) => e.type));
  for (const t of ['map', 'skill', 'item', 'bot']) assert.ok(types.has(t), `官方列表应含 ${t}`);
  for (const e of OFFICIAL_CONTENT) {
    assert.equal(e.stage, 'official', `${e.id} 应为 official`);
    const r = validateContent(e);
    assert.equal(r.ok, true, `${e.id} 应过校验：${(r.errors || []).join('；')}`);
  }
});

test('确定性：官方收录内容与内置同权使用（官方地图+官方技能跑整局逐字节一致）', () => {
  const offMap = OFFICIAL_CONTENT.find((e) => e.type === 'map');
  const offSkill = OFFICIAL_CONTENT.find((e) => e.type === 'skill');
  const pack = makePack(OFFICIAL_CONTENT);
  const run = () => runMatch({
    seed: 21, map: resolvePackMap(pack, offMap.id),
    botA: (api) => (api.ready() ? api.useSkill() : api.patrol()), botB: (api) => api.patrol(),
    skillA: offSkill.id, content: pack, maxTicks: 120,
  });
  assert.equal(JSON.stringify(run()), JSON.stringify(run()));
});
