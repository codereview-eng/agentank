import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCALES } from '../web/i18n.js';

// ============================================================
// 创作工坊独立页 DOM/i18n 契约：
//   - 顶栏赛季 chip 旁有一级入口按钮（已知位置，1 击直达）；
//   - 双 <main>：对战页 playMain + 工坊页 wsMain（默认隐藏，#workshop 深链切换）；
//   - 旧左栏内嵌 <details id="workshop"> 面板已移除，全部功能 id 迁入工坊页；
//   - i18n 新键 zh/en 齐备（同构性由 i18n.test.js 全量兜底）。
// ============================================================

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

test('工坊页/入口：顶栏赛季旁有 wsPageBtn，双 main 骨架在位且工坊页默认隐藏', () => {
  const season = html.indexOf('data-i18n="ui.season"');
  const btn = html.indexOf('id="wsPageBtn"');
  assert.ok(season >= 0, '缺赛季 chip');
  assert.ok(btn > season, '工坊按钮应紧随赛季 chip 之后（顶栏一级入口）');
  assert.match(html, /<main id="playMain">/);
  assert.match(html, /<main id="wsMain" hidden/);
  assert.match(html, /main\[hidden\]\{display:none\}/, 'hidden 必须能压过 main 的 display:grid');
});

test('工坊页/迁移：旧内嵌 details 面板已移除，功能 id 全部迁入工坊页', () => {
  assert.ok(!/<details id="workshop"/.test(html), '旧内嵌工坊面板应已移除');
  const wsMainHtml = html.slice(html.indexOf('<main id="wsMain"'), html.indexOf('<footer>'));
  for (const id of ['wsBackBtn', 'wsFilterRow', 'wsList', 'wsTpl', 'wsNewBtn', 'wsEditor', 'wsErr', 'wsSaveBtn', 'wsImport', 'wsImportBtn', 'wsShareBattleBtn', 'wsShareOut']) {
    assert.ok(wsMainHtml.includes(`id="${id}"`), `工坊页缺 id=${id}`);
  }
});

// 回归（2026-08-13 用户报障「切到创作工坊后切不回对战页」）：
//   - 顶栏 chip 必须是开关：已在工坊页时再点即切回（此前再点无反应，用户最自然的切回动作失效）；
//   - 切页必须设完 hash 直接调 syncWsPage，不依赖 hashchange 事件（部分内嵌 WebView 不派发）。
test('工坊页/切回：顶栏 chip 是开关，切页不依赖 hashchange 事件', () => {
  const appJs = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  assert.match(appJs, /gotoWsPage\(location\.hash !== '#workshop'\)/, '顶栏 chip 应为开关：工坊页内再点即返回对战');
  assert.match(appJs, /location\.hash = on \? '#workshop' : '';\s*\n\s*syncWsPage\(\);/, '设 hash 后必须直接调 syncWsPage，不能只等 hashchange');
  assert.match(appJs, /'wsBackBtn'\)\?\.addEventListener\('click', \(\) => gotoWsPage\(false\)\)/, '「← 返回对战」应与 chip 走同一 gotoWsPage(false)');
  assert.match(appJs, /dataset\.i18n = on \? 'ui\.wsBack' : 'ui\.wsPageBtn'/, '工坊页内 chip 文案应变「← 返回对战」（含语言切换后重渲染一致）');
});

test('工坊页/i18n：新键 zh/en 齐备', () => {
  for (const k of ['wsPageBtn', 'wsBack', 'wsBrowseTitle', 'wsCreateTitle', 'wsFilterAll', 'wsEquip', 'wsEquipped', 'wsEquipNa']) {
    assert.ok(LOCALES.zh.ui[k], `缺 zh ui.${k}`);
    assert.ok(LOCALES.en.ui[k], `缺 en ui.${k}`);
  }
});
