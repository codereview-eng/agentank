// 随机乱走基线：只会随机巡逻，从不开火——用于衡量四流派 bot 的强度下限。
export default function baseline(api) {
  return api.patrol();
}
