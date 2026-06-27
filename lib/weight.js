'use strict';

// ── 商品重量估算 ──────────────────────────────────────────────────────────────
// 依商品名稱關鍵字判斷品類，回傳估算重量範圍與信心程度
function estimateWeight(productName, materialText = '', sleeveCm = null) {
  const name = productName;
  const mat = materialText;

  let category, label, minG, maxG, confidence, packagingNote;

  // フラット 不納入：GRL 平底鞋名稱一定會有其他鞋類關鍵字；フラット 單獨出現在「フラットシルエット洋裝」等服飾名稱，會誤判為鞋
  if (/サンダル|スニーカー|ブーツ|パンプス|シューズ|ミュール|ローファー|スリッポン|ウェッジ|ヒール/.test(name)) {
    category = 'shoes'; label = '鞋類'; minG = 700; maxG = 1020; confidence = 'medium';
  // ショルダー 不納入：「ショルダーオープン/ショルダーリボン」等服飾設計名稱很常見，需用 ショルダーバッグ 才精確
  } else if (/バッグ|トートバッグ|ショルダーバッグ|ハンドバッグ|リュック|クラッチ|ポーチ/.test(name)) {
    category = 'bag'; label = '包包'; minG = 450; maxG = 820; confidence = 'medium';
  } else if (/ピアス|ネックレス|リング|ブレスレット|ヘアアクセ|ヘアクリップ|バレッタ|アクセサリー/.test(name)) {
    category = 'accessory'; label = '配件'; minG = 60; maxG = 180; confidence = 'low';
  } else if (/コート|アウター|ダウン|ブルゾン|ムートン/.test(name)) {
    category = 'outerwear'; label = '外套'; minG = 650; maxG = 1150; confidence = 'medium';
  } else if (/ジャケット|カーディガン|ボレロ/.test(name)) {
    category = 'jacket'; label = '外罩衫'; minG = 280; maxG = 580; confidence = 'high';
  } else if (/スウェット|パーカー/.test(name)) {
    category = 'sweatshirt'; label = '衛衣/帽T'; minG = 300; maxG = 550; confidence = 'medium';
  // ショートデニム 先於 デニム：牛仔短褲比長褲輕很多
  } else if (/ショートデニム|デニムショーツ|デニムショート/.test(name)) {
    category = 'shorts_denim'; label = '牛仔短褲'; minG = 200; maxG = 380; confidence = 'medium';
  // デニム 先於 ワンピース/スカート：牛仔布料偏重，需用牛仔範圍而非洋裝範圍
  } else if (/デニム|ジーンズ/.test(name)) {
    category = 'denim'; label = '牛仔褲'; minG = 500; maxG = 850; confidence = 'high';
  } else if (/ワンピース|ドレス/.test(name)) {
    category = 'dress'; label = '洋裝'; minG = 200; maxG = 480; confidence = 'high';
  } else if (/スカート/.test(name)) {
    category = 'skirt'; label = '裙子'; minG = 170; maxG = 400; confidence = 'high';
  // レギンス/ショートパンツ 先於 パンツ：獨立範圍，避免被長褲範圍高估
  } else if (/レギンス|スパッツ/.test(name)) {
    category = 'leggings'; label = '內搭褲'; minG = 50; maxG = 150; confidence = 'high';
  } else if (/ショートパンツ|ハーフパンツ/.test(name)) {
    category = 'shorts'; label = '短褲'; minG = 120; maxG = 300; confidence = 'high';
  } else if (/パンツ|スラックス/.test(name)) {
    category = 'pants'; label = '褲子'; minG = 220; maxG = 520; confidence = 'high';
  } else if (/ニット|セーター/.test(name)) {
    category = 'knit'; label = '針織上衣'; minG = 180; maxG = 400; confidence = 'high';
  } else if (/トップス|シャツ|ブラウス|カットソー|Tシャツ|タンク|ノースリーブ/.test(name)) {
    category = 'top'; label = '上衣'; minG = 120; maxG = 300; confidence = 'high';
  } else {
    category = 'clothing'; label = '服飾'; minG = 150; maxG = 450; confidence = 'medium';
  }

  // 多件式套裝乘數（セットアップ × 1.8，セット / アンサンブル × 1.6）
  if (/セットアップ/.test(name)) {
    minG = Math.round(minG * 1.8); maxG = Math.round(maxG * 1.8);
  } else if (/セット|アンサンブル/.test(name)) {
    minG = Math.round(minG * 1.6); maxG = Math.round(maxG * 1.6);
  }

  // 包裝重量納入估算
  const pkgG = category === 'shoes' ? 200 : category === 'accessory' ? 30
    : (category === 'outerwear' || category === 'bag') ? 150 : 80;
  minG += pkgG; maxG += pkgG;
  packagingNote = `含包裝約${pkgG}g`;

  // 針織材質加成（優先順序：商品名袖丈 > 實測 sleeveCm > 素材判斷 > 保守預設）
  if (/ニット|セーター/.test(name)) {
    if (/ノースリーブ|袖なし/.test(name)) {
      // 無袖針織不加
    } else if (/半袖|半そで|ショートスリーブ|ポロシャツ/.test(name)) {
      minG += 45; maxG += 45;
    } else if (/七分袖|五分袖/.test(name)) {
      minG += 136; maxG += 136;
    } else if (sleeveCm !== null && sleeveCm < 30) {
      minG += 45; maxG += 45;   // 實測袖長 < 30cm → 短袖
    } else if (sleeveCm !== null && sleeveCm < 45) {
      minG += 136; maxG += 136; // 實測袖長 30~44cm → 五/七分袖
    } else if (/ウール|カシミア/.test(mat)) {
      minG += 227; maxG += 227; // 厚重羊毛
    } else if (/アクリル/.test(mat)) {
      minG += 180; maxG += 180; // 壓克力
    } else if (/コットン|綿/.test(mat)) {
      minG += 136; maxG += 136; // 棉質
    } else if (/レーヨン|ポリエステル|ナイロン/.test(mat)) {
      minG += 45; maxG += 45;  // 輕薄合成纖維
    } else {
      minG += 136; maxG += 136; // 未知素材→保守中間值
    }
  }

  // 布料材質加成/減輕（+0.3磅=136g；-0.2磅=91g）
  if (/ベロア|ツイード|ファー|レザー|PUレザー/.test(name)) {
    minG += 136; maxG += 136;
  } else if (/シフォン|レース/.test(name)) {
    minG = Math.max(50, minG - 91); maxG = Math.max(150, maxG - 91);
  }

  // 版型大小調整
  if (/オーバーサイズ|ルーズ/.test(name)) { minG = Math.round(minG * 1.1); maxG = Math.round(maxG * 1.1); }
  if (/ロング/.test(name) && /ワンピース|スカート|コート|アウター|カーディガン|パンツ|ジャケット/.test(name)) {
    minG = Math.round(minG * 1.15); maxG = Math.round(maxG * 1.15);
  }
  if (/ミニ/.test(name) && /ワンピース|スカート/.test(name)) {
    minG = Math.round(minG * 0.9); maxG = Math.round(maxG * 0.9);
  }

  // 袖丈縮減（外罩衫/洋裝的半袖與無袖）
  if (/半袖|半そで|ショートスリーブ/.test(name)) {
    if (/カーディガン|ジャケット|ボレロ/.test(name)) { minG = Math.round(minG * 0.85); maxG = Math.round(maxG * 0.85); }
    else if (/ワンピース|ドレス/.test(name))         { minG = Math.round(minG * 0.93); maxG = Math.round(maxG * 0.93); }
  }
  if (/ノースリーブ|袖なし/.test(name) && /ワンピース|ドレス/.test(name)) {
    minG = Math.round(minG * 0.88); maxG = Math.round(maxG * 0.88);
  }

  // 附贈配件加成
  if (/ティペット付き|ファー付き/.test(name)) { minG += 136; maxG += 136; }
  else if (/スカーフ付き|ストール付き/.test(name)) { minG += 68; maxG += 68; }
  else if (/ベルト付き/.test(name)) { minG += 45; maxG += 45; }

  const midG    = Math.round((minG + maxG) / 2);
  const midKg   = parseFloat((midG / 1000).toFixed(2));
  const midLbs  = parseFloat((midKg * 2.20462).toFixed(2));
  const minLbs  = parseFloat((minG / 1000 * 2.20462).toFixed(2));
  const maxLbs  = parseFloat((maxG / 1000 * 2.20462).toFixed(2));
  const minKg   = parseFloat((minG / 1000).toFixed(2));
  const maxKg   = parseFloat((maxG / 1000).toFixed(2));

  const confidenceLabel = confidence === 'high' ? '高' : confidence === 'medium' ? '中' : '低';
  const detail = `品類：${label}｜${packagingNote}｜估算範圍：${minG}~${maxG}g（${minLbs}~${maxLbs} lbs）`;

  return { category, label, midG, midKg, midLbs, minG, maxG, minLbs, maxLbs, minKg, maxKg, confidence, confidenceLabel, detail };
}

module.exports = { estimateWeight };
