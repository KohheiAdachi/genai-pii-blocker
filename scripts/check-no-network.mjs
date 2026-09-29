// 外部通信ゼロ（ADR-0002）とconsole出力禁止（ADR-0008）の機械的チェック。
//
// 開発ドキュメント 6.2 のサンプルを、行番号を出せるように行単位の走査へ改めたもの。
// CLIとしても（`npm run check:no-network`）、モジュールとしても（test/check-no-network.test.js）使える。
//
// Node標準モジュールのみを使う（ADR-0002：依存ライブラリはゼロ）。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 検査対象のディレクトリ（リポジトリルートからの相対パス）。 */
export const TARGET_DIRS = ['src', 'options'];

/** 検査対象の拡張子。`manifest.json` はURLを含むため対象外（開発ドキュメント 6.2）。 */
export const TARGET_EXTENSIONS = ['.js', '.html'];

/** 外部通信APIと生URL。`net-guard.js` だけは許可リストで除外される（ADR-0004）。 */
export const NETWORK_PATTERNS = [
  { name: 'fetch(', re: /\bfetch\s*\(/ },
  { name: 'new XMLHttpRequest', re: /new\s+XMLHttpRequest/ },
  { name: 'new WebSocket', re: /new\s+WebSocket/ },
  { name: 'EventSource', re: /EventSource/ },
  { name: 'sendBeacon', re: /sendBeacon/ },
  { name: 'import(', re: /\bimport\s*\(/ },
  { name: 'http:// または https://', re: /https?:\/\// },
];

/**
 * デバッグ出力の混入。ADR-0008 の「デバッグ出力をリリースビルドで除去する」への対応として、
 * 除去スクリプトではなくコード規約＋この機械検出を選んだ（PR #21）。
 * 許可リスト対象のファイルでも例外にしない。
 */
export const CONSOLE_PATTERNS = [{ name: 'console.', re: /\bconsole\s*\./ }];

/** 通信APIの参照のみ許可されるファイル（ADR-0004。変更時は個別レビュー必須）。 */
export const NETWORK_ALLOWLIST = new Set(['src/net-guard.js']);

/** OS差を消してパスを `/` 区切りに正規化する。 */
export function toPosixPath(p) {
  return sep === '/' ? p : p.split(sep).join('/');
}

/** そのファイルが通信APIの許可リストに入っているか。 */
export function isNetworkAllowed(filePath) {
  return NETWORK_ALLOWLIST.has(toPosixPath(filePath));
}

/**
 * ソースを1行ずつ検査して違反を返す。
 * @param {string} source 検査するテキスト
 * @param {{ allowNetwork?: boolean, file?: string }} [options]
 *   allowNetwork: 通信APIを許可する（許可リスト対象ファイル）。console は常に禁止。
 * @returns {{ file: string, line: number, pattern: string, snippet: string }[]}
 */
export function scanSource(source, options = {}) {
  const { allowNetwork = false, file = '<source>' } = options;
  const patterns = allowNetwork ? CONSOLE_PATTERNS : [...NETWORK_PATTERNS, ...CONSOLE_PATTERNS];
  const violations = [];

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const { name, re } of patterns) {
      if (re.test(lines[i])) {
        violations.push({ file, line: i + 1, pattern: name, snippet: snippetOf(lines[i]) });
      }
    }
  }
  return violations;
}

function snippetOf(line) {
  const trimmed = line.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

/** 検査対象の拡張子か。 */
export function isTargetFile(filePath) {
  return TARGET_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

/**
 * ディレクトリを再帰的に辿り、検査対象ファイルのパスを集める。
 * ディレクトリが存在しない場合は空配列を返す（`src/` が `.gitkeep` だけの段階でも落ちない）。
 * @returns {string[]} `root` 起点の相対パス（`/` 区切り）
 */
export function collectFiles(dir, root = dir) {
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) return [];

  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) return collectFiles(absolute, root);
      const relativePath = toPosixPath(relative(root, absolute));
      return isTargetFile(relativePath) ? [relativePath] : [];
    });
}

/**
 * 対象ディレクトリ配下のファイルをすべて検査する。
 * @param {{ cwd?: string, dirs?: string[] }} [options]
 * @returns {{ files: string[], violations: { file: string, line: number, pattern: string, snippet: string }[] }}
 */
export function checkDirectories(options = {}) {
  const { cwd = process.cwd(), dirs = TARGET_DIRS } = options;
  const files = [];
  const violations = [];

  for (const dir of dirs) {
    for (const relativePath of collectFiles(join(cwd, dir), cwd)) {
      files.push(relativePath);
      const source = readFileSync(join(cwd, relativePath), 'utf8');
      violations.push(
        ...scanSource(source, { file: relativePath, allowNetwork: isNetworkAllowed(relativePath) }),
      );
    }
  }
  return { files, violations };
}

/** 違反一覧を人が読める形に整える。 */
export function formatViolations(violations) {
  return violations.map((v) => `NG: ${v.file}:${v.line}: ${v.pattern}  |  ${v.snippet}`).join('\n');
}

/** CLI本体。終了コードを返す（0: 違反なし、1: 違反あり）。 */
export function main({ cwd = process.cwd(), log = console.log, error = console.error } = {}) {
  const { files, violations } = checkDirectories({ cwd });

  if (violations.length > 0) {
    error(formatViolations(violations));
    error('');
    error(`外部通信API・console出力の混入を ${violations.length} 件検出しました（ADR-0002 / ADR-0008）。`);
    error(`通信APIの参照が必要な場合の例外は ${[...NETWORK_ALLOWLIST].join(', ')} のみです（個別レビュー必須）。`);
    return 1;
  }

  log(`OK: 外部通信APIとconsole出力の混入はありません（検査 ${files.length} ファイル）。`);
  return 0;
}

// 直接実行されたときだけCLIとして動く（テストからのimportでは実行しない）。
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exit(main());
}
