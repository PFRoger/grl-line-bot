// ── 顏色對照表（複合詞排前面，避免被單字提前匹配）────────────────────────────
const COLOR_MAP_OBJ = {
  'オフホワイト': '灰白色', 'オフベージュ': '杏色',  'ライトブルー': '淺藍色',
  'ライトグレー': '淺灰色', 'グレージュ':  '藕色',   'ワインレッド': '酒紅色',
  'ミントグリーン': '薄荷綠色', 'キャメル': '駝色',  'オートミール': '燕麥色',
  'ブラック': '黑色',  'ピンク': '粉色',    'グレー': '灰色',    'アイボリー': '象牙白',
  'チャコール': '炭灰色', 'ホワイト': '米白色', 'ブルー': '藍色',  'ベージュ': '淺褐色',
  'グリーン': '綠色',  'レッド': '紅色',    'イエロー': '黃色', 'パープル': '紫色',
  'ブラウン': '咖啡色', 'モカ': '摩卡色',   'ボルドー': '酒紅色', 'カーキ': '卡其色',
  'ネイビー': '藏青色', 'オレンジ': '橘色', 'ミント': '薄荷綠', 'ラベンダー': '薰衣草紫',
  'マスタード': '芥末黃',
};
const COLOR_KEYS = Object.keys(COLOR_MAP_OBJ);

function hasColorKeyword(text) {
  return COLOR_KEYS.some((k) => text.includes(k));
}

function translateColorWithJp(text) {
  for (const jp of COLOR_KEYS) {
    if (text.includes(jp)) return `${COLOR_MAP_OBJ[jp]}(${jp})`;
  }
  return text;
}

module.exports = { COLOR_MAP_OBJ, COLOR_KEYS, hasColorKeyword, translateColorWithJp };
