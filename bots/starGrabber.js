// 抢星流（技能：疾驰）：以吃星为主，远星开疾驰冲刺，顺手开枪；躲炸弹。
import { bombEvade } from './util.js';

export default function starGrabber(api) {
  const evade = bombEvade(api);
  if (evade) return evade;
  const me = api.me();
  const foe = api.enemy();
  const R = api.rules();
  if (api.enemyVisible() && api.canFire() && api.distTo(foe) <= R.fireRange
    && (foe.x === me.x || foe.y === me.y)) {
    return api.fireAt(foe);
  }
  const star = api.nearestStar();
  if (star && !me.boosted && api.ready() && api.distTo(star) >= 4) return api.useSkill(); // 疾驰抢星
  return star ? api.moveTo(star) : api.patrol();
}
starGrabber.skill = 'boost';
