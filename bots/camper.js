// 蹲草流：看得见敌人就交火（近身先眩晕）；看不见就找草丛蹲着装死。
export default function camper(api) {
  const foe = api.enemy();
  const R = api.rules();
  const d = api.distTo(foe);
  if (api.enemyVisible()) {
    if (d <= R.stunRange && api.ready('stun')) return api.stun();
    if (api.canFire() && d <= R.fireRange) return api.fireAt(foe);
    if (d > R.fireRange) return api.moveTo(foe); // 追到射程内
    return null; // 射程内装填中：原地不动
  }
  if (!api.inGrass()) {
    const g = api.nearestGrass();
    if (g) return api.moveTo(g);
    const s = api.nearestStar();
    return s ? api.moveTo(s) : api.patrol();
  }
  return null; // 已在草丛：蹲住
}
