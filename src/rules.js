// src/rules.js — 同梱する検出ルール。
//
// JSONではなくJSとして同梱するのは、コンテンツスクリプトから
// chrome.runtime.getURL() 経由で読み込む必要をなくし、通信APIの使用を例外なく
// ゼロにするため（ADR-0007）。manifest.json の content_scripts.js に列挙して
// 読み込む。
//
// ルールはデータ構造のまま書く。関数は持ち込まず、バリデータは名前で参照する
// （実体は detector.js）。管理者ポリシー由来の customRules と同じ形式を保つため。
//
// 同梱ルールの action は例外なくすべて 'warn'（ADR-0013）。'block' は管理者ポリシーの
// blockRules で指定された種別にのみ適用される。
//
// POCスコープでは保険者番号とマイナンバーの2種のみ実装する（#16 段階2）。
// チェックディジットを持つ種別（validator あり）と、持たない種別の両方の経路を
// 通せるため、縦一本の確認にはこの2種で足りる。残りの種別は段階4で追加する:
//
//   - 公費負担者番号（8桁）        … validator: 'luhn'
//   - 公費負担医療の受給者番号（7桁）… validator: 'luhn'、キーワード必須
//   - 後期高齢者医療 被保険者番号（8桁）… 全国共通の検証方式が存在しないため
//                                        validator: null＋requireKeyword: true
//
// 上記の桁構成と検証方式の根拠は
// docs/research/2026-09-21-kouhi-koukikoureisha-number-format.md を参照。
globalThis.PII_RULES = [
  {
    id: 'insurer_number',
    label: '保険者番号',
    kind: 'numeric',
    lengths: [6, 8],
    validator: 'luhn',
    action: 'warn',
    // 6・8桁の数字は10%の確率で偶然検証を通るため、強キーワードがなければ
    // スコアを high 未満に抑え、「参考」表示に留める
    requireKeywordForHigh: true,
    keywords: {
      strong: ['保険者番号', '保険証', '保険者'],
      weak: ['番号', 'No'],
      negative: ['注文番号', '郵便番号', '型番', '請求書']
    }
  },
  {
    id: 'my_number',
    label: 'マイナンバー',
    kind: 'numeric',
    lengths: [12],
    validator: 'myNumber',
    action: 'warn',
    keywords: {
      strong: ['マイナンバー', '個人番号'],
      weak: ['番号'],
      negative: []
    }
  }
];
