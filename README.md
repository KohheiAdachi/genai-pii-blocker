# pii-guard

生成AIチャット（ChatGPT、Claude、Gemini、Copilot、Perplexity）への入力を**送信直前に端末内で検査**し、健康保険の被保険者番号などの個人情報を検出したら送信をいったん止めて確認ポップアップを表示するブラウザ拡張機能（Chrome / Edge、Manifest V3）。

**拡張機能自身は外部通信を一切行わない。** 検査・判定・ログはすべて端末内で完結する。

## 現在の状態

**個人のPOC開発中。** 組織配布（強制インストール、管理者ポリシー、運用体制）は現時点のスコープ外で、issue に `deferred` ラベルを付けて棚上げしている。進捗と作業順序は [#16](../../issues/16) を参照。

## ドキュメントの読み方

この順に読むと設計の背景まで辿れる。

| | 内容 |
| --- | --- |
| [`docs/pii-guard-development-doc.md`](docs/pii-guard-development-doc.md) | 開発ドキュメント。要件・検出ルール・アーキテクチャ・詳細設計・テスト計画・配布運用 |
| [`docs/adr/README.md`](docs/adr/README.md) | アーキテクチャ決定記録（ADR）13本。「なぜこうなっているのか」の一次情報 |
| [`docs/research/`](docs/research/) | 調査記録。公的番号の桁構成と検証方式など |

ADRの運用：決定は書き換えない。方針が変わったら新しいADRを追加し、古い方のステータスを `置換（ADR-NNNN による）` にする。決定を変えない事実の確定（調査結果など）は末尾に日付つきの「追記」節を足す。

## 開発

```sh
npm install
npm test          # 単体テスト（Vitest）
npm run test:watch
```

拡張機能の読み込み：`chrome://extensions` → デベロッパーモードON → 「パッケージ化されていない拡張機能を読み込む」でリポジトリのルートを選ぶ。

### ディレクトリ構成

```
src/        拡張機能のコード（rules.js / detector.js / sites.js / modal.js / content.js / net-guard.js / background.js）
options/    設定画面
icons/      アイコン
test/       単体テスト
scripts/    ビルド時チェック
docs/       設計ドキュメント
```

## コードの制約

以下は好みではなく、ADRで決めた設計上の制約。破るとその決定が成立しなくなる。

### 外部通信APIを使わない（ADR-0002）

`fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource` / `navigator.sendBeacon` / `import()` を使わない。`src/net-guard.js` だけは例外（ラップ対象として参照するため。個別レビュー必須）。

`npm run check:no-network`（`scripts/check-no-network.mjs`）で機械的に検査する。CIでも PR と `main` への push で実行し、違反があればビルドを落とす。

- 検出対象：`fetch(` / `new XMLHttpRequest` / `new WebSocket` / `EventSource` / `sendBeacon` / `import(` / `http://`・`https://`、**および `console.`**（下記「検出値を保存・出力しない」。ADR-0008 の「デバッグ出力をビルドで除去する」を、除去スクリプトではなくコード規約＋この機械検出で満たしている）
- 検査対象：`src/` と `options/` の `.js` / `.html` のみ。`manifest.json` は `host_permissions` や `matches` にURLを含むため対象外
- 許可リスト：`src/net-guard.js` のみ。通信APIの参照だけを許可し、`console.` は許可しない
- 違反はファイル名・行番号・該当パターンで報告される

### 同梱コードの依存ライブラリはゼロ

拡張機能に同梱するコードは依存ゼロ。Vitest のような**開発用 devDependency はこの制約の対象外**だが、数は最小限に保つ。

### バンドラ・トランスパイラを使わない

MV3 は `manifest.json` の `content_scripts.js` に列挙した素のJSをそのまま読み込む。検出ルールをJSONではなくJSモジュールとして同梱しているのも、読み込みにビルドを要さないようにするため（ADR-0007）。

### 検出値を保存・出力しない（ADR-0008）

入力テキストと検出値は保存しない。`console` へも出力しない（DevToolsのログは他の拡張機能やページのスクリプトから読める場合があり、保存しない方針の抜け道になる）。UIには `Detector.preview()` で伏せ字にしてから表示する。

`chrome.storage.sync` は使わない（書くだけでGoogleアカウント経由でクラウド同期される）。保存先は `chrome.storage.local` と `chrome.storage.managed` のみ。

### テストに実在の個人情報を使わない

チェックディジットを満たすダミー番号を生成して使う。検算済みのダミー値と生成方法は [`docs/research/2026-09-21-kouhi-koukikoureisha-number-format.md`](docs/research/2026-09-21-kouhi-koukikoureisha-number-format.md) にある。

## ライセンス

個人利用のため未設定（`package.json` は `private: true`）。第三者へ配布する段階で決める。
