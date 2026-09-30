// src/sites.js — サイトごとのDOMセレクタ。
//
// セレクタは「壊れる前提」のデータであり、検出ロジックやイベント捕捉ロジックと
// 混ぜるとサイト改修のたびに全体の回帰試験が必要になる。ここに分離しておくことで、
// AIサービスの画面改修への追従が「このファイルの値の変更」だけで済む（ADR-0011）。
//
// サイト固有セレクタと汎用セレクタの両方を常に試す。固有セレクタが外れても
// 完全な素通りにはならず、部分的にでも捕捉できる状態を残すため。
//
// POCスコープでは ChatGPT のみ。残りのサイトは #8 で追加する。
//
// 重要: セレクタはサイトの改修で予告なく変わる。リリースごと・月1回、
// 開発ドキュメント 7.3 のチェックリストで実機確認すること（ADR-0011）。

// サイト固有セレクタが外れたときのフォールバック。
// 過去メッセージの編集欄など、固有セレクタを用意していないUIもここで拾える。
globalThis.PII_GENERIC = {
  editor: 'textarea, [contenteditable="true"], [contenteditable=""]',
  sendButton: [
    'button[type="submit"]',
    'button[aria-label*="送信"]',
    'button[aria-label*="Send" i]',
    'button[data-testid*="send" i]'
  ].join(', ')
};

globalThis.PII_SITES = {
  // ChatGPT。入力欄は ProseMirror 系の contenteditable（#prompt-textarea）。
  // 旧UIの textarea も残っている場合があるため両方を候補にする。
  'chatgpt.com': {
    editor: '#prompt-textarea, div[contenteditable="true"], textarea',
    sendButton: [
      'button[data-testid="send-button"]',
      'button[aria-label*="送信"]',
      'button[aria-label*="Send" i]'
    ].join(', ')
  }
};

// chat.openai.com は chatgpt.com へリダイレクトされるが、移行期間中のために残す
globalThis.PII_SITES['chat.openai.com'] = globalThis.PII_SITES['chatgpt.com'];
