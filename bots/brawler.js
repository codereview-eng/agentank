// 贴脸流（技能：超载）：死咬最后目击位置贴上去，先超载压弹再 2 连发，贴身丢炸弹；躲炸弹。
import { bombEvade } from './util.js';

export default function brawler(api) {
  const evade = bombEvade(api);
  if (evade) return evade;
  const foe = api.enemy();
  const R = api.rules();
  const d = api.distTo(foe);
  if (api.enemyVisible()) {
    if (api.ready() && api.canFire() && d <= R.fireRange) return api.useSkill(); // 超载压弹
    if (api.canFire() && d <= R.fireRange) return api.fireAt(foe);
    if (d <= 2 && api.ready('bomb')) return api.throwBomb(); // 贴身丢雷（随后 bombEvade 自动撤离）
  }
  if (d === 0) return api.patrol(); // 已到最后目击点仍没人：就地搜索
  return api.moveTo(foe);
}
brawler.skill = 'overload';
