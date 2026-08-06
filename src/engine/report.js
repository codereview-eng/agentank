// 战报文本渲染：把结构化事件数组渲染成可读文字行（供前端回放/展示）。

const SKILL_NAMES = {
  shield: '护盾', freeze: '冰冻', stun: '眩晕', overload: '超载',
  cloak: '隐身', poison: '剧毒', teleport: '传送', boost: '疾驰',
};

export function renderText(result, names = ['甲', '乙']) {
  const nm = (i) => names[i] ?? `P${i}`;
  const lines = [];
  for (const e of result.events) {
    const t = `t=${String(e.t).padStart(3, '0')}`;
    switch (e.type) {
      case 'start': {
        const sk = e.skills ? ` 技能 ${nm(0)}=${SKILL_NAMES[e.skills[0]] ?? e.skills[0]} ${nm(1)}=${SKILL_NAMES[e.skills[1]] ?? e.skills[1]}` : '';
        lines.push(`${t} 对战开始 seed=${e.seed} 地图${e.width}x${e.height}${sk}`);
        break;
      }
      case 'goal':
        if (e.tag === 'star') lines.push(`${t} ${nm(e.who)} 直奔星星`);
        else if (e.tag === 'enemy') lines.push(`${t} ${nm(e.who)} 扑向敌人`);
        else lines.push(`${t} ${nm(e.who)} 移动到(${e.x},${e.y})`);
        break;
      case 'turn': {
        const arrow = { '1,0': '→', '-1,0': '←', '0,1': '↓', '0,-1': '↑' }[e.dx + ',' + e.dy] ?? '';
        lines.push(`${t} ${nm(e.who)} 转炮口${arrow}`);
        break;
      }
      case 'fire':
        lines.push(`${t} ${nm(e.who)} 开火`);
        break;
      case 'hit':
        lines.push(`${t} ${nm(e.who)} 命中 ${nm(e.target)}（-${e.dmg}，剩${e.hp}）`);
        break;
      case 'bullet_end':
        if (e.reason === 'wall') lines.push(`${t} ${nm(e.who)} 的子弹被墙挡下`);
        else if (e.reason === 'mound') lines.push(`${t} ${nm(e.who)} 的子弹打在土堆上`);
        else if (e.reason === 'out') lines.push(`${t} ${nm(e.who)} 的子弹飞出场外`);
        break;
      case 'mound_hit':
        if (e.hp > 0) lines.push(`${t} (${e.x},${e.y}) 的土堆被打出裂缝`);
        break;
      case 'mound_destroyed':
        lines.push(`${t} (${e.x},${e.y}) 的土堆被摧毁`);
        break;
      case 'bomb_place':
        lines.push(`${t} ${nm(e.who)} 在(${e.x},${e.y})放下炸弹`);
        break;
      case 'bomb_explode': {
        const dmg = e.hits.map((h) => `${nm(h.who)}-${h.dmg}`).join(' ');
        lines.push(`${t} 炸弹在(${e.x},${e.y})爆炸${dmg ? `，${dmg}` : '，无人受伤'}`);
        break;
      }
      case 'shield_block':
        lines.push(`${t} ${nm(e.who)} 的护盾挡下了${e.source === 'bomb' ? '炸弹' : '子弹'}`);
        break;
      case 'star':
        lines.push(`${t} ${nm(e.who)} 吃星（${e.total}）`);
        break;
      case 'star_spawn':
        lines.push(`${t} 新星星出现在(${e.x},${e.y})`);
        break;
      case 'skill': {
        const n = SKILL_NAMES[e.name] ?? e.name;
        if (e.name === 'teleport') lines.push(`${t} ${nm(e.who)} 传送到(${e.x},${e.y})`);
        else if (e.name === 'overload') lines.push(`${t} ${nm(e.who)} 超载压弹，下次开火 2 连发`);
        else lines.push(`${t} ${nm(e.who)} 施放${n}`);
        break;
      }
      case 'freeze_hit':
        lines.push(`${t} ${nm(e.target)} 被冰冻${e.duration}拍，动弹不得`);
        break;
      case 'stun_hit':
        lines.push(`${t} ${nm(e.target)} 被眩晕${e.duration}拍，操作错乱`);
        break;
      case 'poison_hit':
        lines.push(`${t} ${nm(e.target)} 中毒，${e.duration}拍内持续掉血`);
        break;
      case 'teleport_reveal':
        lines.push(`${t} ${nm(e.who)} 现身于(${e.x},${e.y})`);
        break;
      case 'death':
        lines.push(`${t} ${nm(e.who)} 被击毁`);
        break;
      case 'end':
        lines.push(
          e.winner == null
            ? `${t} 平局（星${e.stars[0]}:${e.stars[1]}）`
            : `${t} ${nm(e.winner)} 获胜（${e.reason === 'kill' ? '击杀' : '星数'}，星${e.stars[0]}:${e.stars[1]}）`,
        );
        break;
      default:
        break; // poison_tick 等逐拍事件不入文字战报，避免刷屏
    }
  }
  return lines;
}
