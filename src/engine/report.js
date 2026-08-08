// 战报文本渲染：把结构化事件数组渲染成可读文字行（供前端回放/展示）。

const SKILL_NAMES = {
  shield: '护盾', freeze: '冰冻', stun: '眩晕', overload: '超载',
  cloak: '隐身', poison: '剧毒', teleport: '传送', boost: '疾驰',
};

const ITEM_NAMES = {
  medkit: '急救包', rapid: '双发弹', pierce: '穿甲弹',
  helmet: '头盔', clock: '时钟', boots: '疾行靴',
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
      case 'slide':
        lines.push(`${t} ${nm(e.who)} 在冰面滑到(${e.x},${e.y})`);
        break;
      case 'star':
        lines.push(`${t} ${nm(e.who)} 吃星（${e.total}）`);
        break;
      case 'star_spawn':
        lines.push(`${t} 新星星出现在(${e.x},${e.y})`);
        break;
      case 'star_gone':
        lines.push(`${t} (${e.x},${e.y}) 的星星被毒圈吞没`);
        break;
      case 'item_spawn':
        lines.push(`${t} 道具「${ITEM_NAMES[e.kind] ?? e.kind}」出现在(${e.x},${e.y})`);
        break;
      case 'item_pick': {
        const n = ITEM_NAMES[e.kind] ?? e.kind;
        if (e.kind === 'medkit') lines.push(`${t} ${nm(e.who)} 拾取急救包，回血至 ${e.hp}`);
        else if (e.kind === 'clock') lines.push(`${t} ${nm(e.who)} 拾取时钟，冻住了对手`);
        else lines.push(`${t} ${nm(e.who)} 拾取${n}`);
        break;
      }
      case 'item_gone':
        lines.push(`${t} (${e.x},${e.y}) 的${ITEM_NAMES[e.kind] ?? e.kind}被毒圈吞没`);
        break;
      case 'zone_shrink':
        lines.push(`${t} 毒圈收缩（第${e.ring}圈），安全区 (${e.x0},${e.y0})~(${e.x1},${e.y1})`);
        break;
      case 'zone_hit':
        lines.push(`${t} ${nm(e.target)} 在毒圈中 -${e.dmg}（剩${e.hp}）`);
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
      case 'end': {
        // 平局已根治：终局判定链必出胜负
        const REASON_CN = {
          kill: '击杀', stars: '星数', hp: '血量判定',
          damage: '输出判定', center: '圈心判定', coin: '种子掷签',
        };
        lines.push(
          e.winner == null
            ? `${t} 平局（星${e.stars[0]}:${e.stars[1]}）` // 兼容旧战报回放
            : `${t} ${nm(e.winner)} 获胜（${REASON_CN[e.reason] ?? e.reason}，星${e.stars[0]}:${e.stars[1]}）`,
        );
        break;
      }
      default:
        break; // poison_tick 等逐拍事件不入文字战报，避免刷屏
    }
  }
  return lines;
}
