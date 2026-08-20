import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCALES } from '../web/i18n.js';

// ============================================================
// 左栏重设计（方案 A · 2026-08-20 用户确认）DOM/CSS 契约：
//
// 根因回顾（线上实测 1440×720 登录态）：左栏内容 scrollHeight=1218px、clientHeight=614px，
// 溢出 604px，而 section/.ctrl 的 overflow-y 都是 visible，被 body{overflow:hidden} 直接切掉
// —— 车库以下（云端面板 458px + Agent Key 表 361px）整块不可见且无法滚动到。
//
// 方案 A 契约：
//   - 左栏 = 作战台：坦克切换器 → 通知区 → 可滚动战术区 → 一行对局设置 → 粘底 CTA；
//   - 车库 / 脚本编辑 / 账号与 Agent Key 三块低频功能移出左栏，进弹窗或抽屉；
//   - 兜底硬约束：左栏中段必须是独立滚动区，CTA 不参与滚动（任何状态都不许再被裁没）。
// ============================================================

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');

// 左栏片段 = 对战页第一个 section（到中栏注释为止）
const leftPanel = html.slice(html.indexOf('<main id="playMain">'), html.indexOf('<!-- 中：竞技场'));
const between = (startMark, endMark) => {
  const a = html.indexOf(startMark);
  assert.ok(a >= 0, `缺片段起点 ${startMark}`);
  const b = html.indexOf(endMark, a);
  assert.ok(b > a, `缺片段终点 ${endMark}`);
  return html.slice(a, b);
};

test('左栏/骨架：三段式（固定头 + 独立滚动中段 + 粘底 CTA）', () => {
  assert.match(leftPanel, /id="lpScroll"/, '左栏缺独立滚动中段 #lpScroll');
  assert.match(leftPanel, /id="lpCta"/, '左栏缺粘底操作区 #lpCta');
  // 中段必须真的能滚（这条就是本次 bug 的直接防线）
  const scrollRule = html.match(/#lpScroll\s*\{[^}]*\}/);
  assert.ok(scrollRule, '缺 #lpScroll 样式规则');
  assert.match(scrollRule[0], /overflow(-y)?\s*:\s*auto/, '#lpScroll 必须 overflow:auto，否则内容会像旧版一样被裁没');
  assert.match(scrollRule[0], /min-height\s*:\s*0/, 'flex 子项要 min-height:0，否则 overflow:auto 不生效');
  // CTA 不参与滚动
  const ctaRule = html.match(/#lpCta\s*\{[^}]*\}/);
  assert.ok(ctaRule, '缺 #lpCta 样式规则');
  assert.match(ctaRule[0], /flex\s*:\s*none/, '#lpCta 必须 flex:none 粘底，开战按钮任何状态都要可见');
});

test('左栏/收敛：只留每局都碰的东西，低频块全部搬走', () => {
  // 留下的
  for (const id of ['tankSwitch', 'tankMenu', 'noticeBox', 'strategyBox', 'genBtn', 'setupRow', 'battleBtn', 'saveBtn']) {
    assert.ok(leftPanel.includes(`id="${id}"`), `左栏应保留 id=${id}`);
  }
  // 搬走的（这些今天正是把左栏撑爆的元凶）
  for (const id of ['garageList', 'garageNewBtn', 'playAgentKeys', 'akListBody', 'playStatus', 'editor']) {
    assert.ok(!leftPanel.includes(`id="${id}"`), `id=${id} 应已移出左栏（进弹窗/抽屉）`);
  }
  // 左栏不再有任何折叠块：details 一多就无限长高，是旧结构长胖的机制
  assert.ok(!/<details/.test(leftPanel), '左栏不应再有 <details> 折叠块');
});

test('左栏/搬迁：车库弹窗、脚本抽屉、账号弹窗三个容器就位且默认隐藏', () => {
  for (const id of ['overlayScrim', 'garageModal', 'scriptDrawer', 'accountModal']) {
    assert.ok(html.includes(`id="${id}"`), `缺覆盖层容器 id=${id}`);
    assert.match(html, new RegExp(`id="${id}"[^>]*hidden`), `${id} 应默认 hidden`);
  }
  const garage = between('id="garageModal"', 'id="scriptDrawer"');
  for (const id of ['garageList', 'garageMsg', 'garageNewBtn']) {
    assert.ok(garage.includes(`id="${id}"`), `车库弹窗缺 id=${id}`);
  }
  const drawer = between('id="scriptDrawer"', 'id="accountModal"');
  assert.ok(drawer.includes('id="editor"'), '脚本抽屉缺代码编辑器 #editor');
  // 「回填默认流派代码」本就是改脚本的动作，跟脚本待在一起
  assert.ok(drawer.includes('id="playFillBtn"'), '脚本抽屉缺「回填内置流派」#playFillBtn');
  const account = between('id="accountModal"', '<footer>');
  for (const id of ['playStatus', 'playAgentKeys', 'akListBody']) {
    assert.ok(account.includes(`id="${id}"`), `账号弹窗缺 id=${id}`);
  }
});

test('左栏/对局设置：三行下拉压成一行 chip + 气泡（select 保留在气泡里）', () => {
  const setup = between('id="setupRow"', 'id="lpCta"');
  for (const id of ['chipOpp', 'chipSkill', 'chipMap']) {
    assert.ok(setup.includes(`id="${id}"`), `对局设置缺 chip id=${id}`);
  }
  // 原生 select 必须还在（深链 ?skill=/?map=/?opp= 与既有逻辑依赖它们）
  for (const id of ['opp', 'skillSel', 'mapSel']) {
    assert.ok(setup.includes(`id="${id}"`), `气泡内应保留原生 select id=${id}`);
  }
  assert.match(appJs, /function syncSetupChips\(/, 'chip 文案需随 select 值同步');
  // 回归（本轮真机复验抓到）：只定义不调用 → chip 初值是空的。初始化必须排在深链
  // ?opp=/?skill=/?map= 与内容包选项注入之后，否则取到的是旧值/空值。
  assert.match(appJs, /refreshSkillHint\(\);[^\n]*\n\s*syncSetupChips\(\);/, '启动时必须初始化 chip 值（且在深链落定之后）');
});

test('左栏/接线：覆盖层可开可关、Esc 关闭、通知折叠成一条', () => {
  assert.match(appJs, /function openOverlay\(/, '缺 openOverlay');
  assert.match(appJs, /function closeOverlay\(/, '缺 closeOverlay');
  assert.match(appJs, /e\.key === 'Escape'/, '覆盖层必须支持 Esc 关闭');
  assert.match(appJs, /function renderNotices\(/, '三条提示需收敛为统一通知队列');
  // 通知区默认只显示 1 条 + 「还有 N 条」，避免像旧版那样三条横幅叠加把设置项顶下去
  assert.match(appJs, /noticeMore/, '缺「还有 N 条」折叠入口');
});

test('左栏/i18n：新键 zh/en 齐备', () => {
  for (const k of ['garageManage', 'scriptDrawerTitle', 'accountTitle', 'noticeMore', 'overlayClose', 'tankSwitchLocal', 'tankSwitchCloud']) {
    assert.ok(LOCALES.zh.ui[k], `缺 zh ui.${k}`);
    assert.ok(LOCALES.en.ui[k], `缺 en ui.${k}`);
  }
});
