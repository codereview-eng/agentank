// 抢星流：以吃星为主，顺手开枪，残血传送保命（与示例脚本同构）。
export default function starGrabber(api) {
  const me = api.me();
  const R = api.rules();
  if (api.enemyVisible() && api.canFire() && api.distTo(api.enemy()) <= R.fireRange) {
    return api.fireAt(api.enemy());
  }
  if (me.hp < 30 && api.ready('teleport')) {
    const c = api.safestCorner();
    if (c) return api.teleport(c);
  }
  const star = api.nearestStar();
  return star ? api.moveTo(star) : api.patrol();
}
