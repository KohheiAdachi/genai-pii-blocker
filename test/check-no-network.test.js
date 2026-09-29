// check-no-network.mjs の検査ロジックのテスト。
// 検査対象は src/ と options/ だけなので、このファイル自身に検出パターンをそのまま書いてよい。

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  NETWORK_ALLOWLIST,
  checkDirectories,
  collectFiles,
  formatViolations,
  isNetworkAllowed,
  isTargetFile,
  scanSource,
} from '../scripts/check-no-network.mjs';

/** 一時ディレクトリにファイルツリーを書き出し、そのルートを返す。 */
function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-no-network-'));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

describe('scanSource', () => {
  it('通信APIを含む行を違反として検出し、行番号を報告する', () => {
    const source = ['const path = "/api";', 'const res = await fetch(path);', 'export {};'].join('\n');

    const violations = scanSource(source, { file: 'src/a.js' });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: 'src/a.js', line: 2, pattern: 'fetch(' });
  });

  it('console.log を違反として検出する（ADR-0008）', () => {
    const violations = scanSource("console.log('x');");

    expect(violations).toHaveLength(1);
    expect(violations[0].pattern).toBe('console.');
  });

  it.each([
    ['new XMLHttpRequest', 'const x = new XMLHttpRequest();'],
    ['new WebSocket', "const s = new WebSocket('wss://x');"],
    ['EventSource', "const e = new EventSource('/stream');"],
    ['sendBeacon', "navigator.sendBeacon('/b', data);"],
    ['import(', "await import('./m.js');"],
    ['http:// または https://', "const u = 'https://example.com';"],
  ])('%s を検出する', (pattern, line) => {
    expect(scanSource(line).map((v) => v.pattern)).toContain(pattern);
  });

  it('1行に複数のパターンがあればそれぞれ報告する', () => {
    const violations = scanSource("fetch(u); console.log(u);");

    expect(violations.map((v) => v.pattern).sort()).toEqual(['console.', 'fetch(']);
    expect(violations.every((v) => v.line === 1)).toBe(true);
  });

  it('クリーンなコードでは違反0件', () => {
    const source = [
      'export const Detector = {',
      '  detect(text) {',
      '    return RULES.filter((rule) => rule.re.test(text));',
      '  },',
      '};',
    ].join('\n');

    expect(scanSource(source)).toEqual([]);
  });

  it('allowNetwork では通信APIを許可するが console. は許可しない（ADR-0004）', () => {
    const source = ['const original = window.fetch;', "console.log('wrapped');"].join('\n');

    const violations = scanSource(source, { file: 'src/net-guard.js', allowNetwork: true });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 2, pattern: 'console.' });
  });

  it('CRLF でも行番号がずれない', () => {
    const source = ['// 1行目', '// 2行目', 'console.warn(x);'].join('\r\n');

    expect(scanSource(source)[0].line).toBe(3);
  });

  it('長い行はスニペットを切り詰める', () => {
    const violations = scanSource(`fetch(u); // ${'あ'.repeat(200)}`);

    expect(violations[0].snippet).toHaveLength(120);
    expect(violations[0].snippet.endsWith('...')).toBe(true);
  });
});

describe('許可リスト', () => {
  it('src/net-guard.js だけが許可される（ADR-0004）', () => {
    expect([...NETWORK_ALLOWLIST]).toEqual(['src/net-guard.js']);
    expect(isNetworkAllowed('src/net-guard.js')).toBe(true);
    expect(isNetworkAllowed('src/content.js')).toBe(false);
    expect(isNetworkAllowed('options/net-guard.js')).toBe(false);
  });
});

describe('isTargetFile', () => {
  it('JS と HTML のみを対象とする（manifest.json はURLを含むため除外）', () => {
    expect(isTargetFile('src/content.js')).toBe(true);
    expect(isTargetFile('options/options.html')).toBe(true);
    expect(isTargetFile('manifest.json')).toBe(false);
    expect(isTargetFile('src/.gitkeep')).toBe(false);
    expect(isTargetFile('docs/adr/README.md')).toBe(false);
  });
});

describe('collectFiles', () => {
  it('サブディレクトリも辿り、対象外の拡張子は除く', () => {
    const root = makeTree({
      'src/a.js': 'export {};',
      'src/.gitkeep': '',
      'src/sub/b.html': '<p></p>',
      'src/notes.md': '# x',
    });

    expect(collectFiles(join(root, 'src'), root)).toEqual(['src/a.js', 'src/sub/b.html']);
  });

  it('存在しないディレクトリでは空配列を返す', () => {
    const root = makeTree({ 'src/.gitkeep': '' });

    expect(collectFiles(join(root, 'options'), root)).toEqual([]);
  });
});

describe('checkDirectories', () => {
  it('src/ と options/ を検査し、許可リストを適用する', () => {
    const root = makeTree({
      'src/content.js': 'const res = fetch(url);',
      'src/net-guard.js': 'const original = window.fetch;',
      'options/options.html': '<p>設定</p>',
      'manifest.json': '{ "host_permissions": ["https://chatgpt.com/*"] }',
    });

    const { files, violations } = checkDirectories({ cwd: root });

    expect(files.sort()).toEqual(['options/options.html', 'src/content.js', 'src/net-guard.js']);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: 'src/content.js', pattern: 'fetch(' });
  });

  it('src/ と options/ が空でも違反0件で成功する（現状のリポジトリ）', () => {
    const root = makeTree({ 'src/.gitkeep': '', 'options/.gitkeep': '' });

    expect(checkDirectories({ cwd: root })).toEqual({ files: [], violations: [] });
  });
});

describe('formatViolations', () => {
  it('ファイル名・行番号・パターンを含む1行にする', () => {
    const line = formatViolations(scanSource('fetch(u);', { file: 'src/a.js' }));

    expect(line).toContain('src/a.js:1');
    expect(line).toContain('fetch(');
  });
});
