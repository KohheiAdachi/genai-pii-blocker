import { describe, it, expect } from 'vitest';
import manifest from '../manifest.json' with { type: 'json' };

import '../src/rules.js';
import '../src/sites.js';
// content.js は window / document があるときだけ初期化するので、
// Node 環境では判定ロジックだけが読み込まれる
import '../src/content.js';

const { isSendKey, approvalMatches, selectSite, canProceedWith, summaryLevel } =
  globalThis.PiiContent._internal;

describe('Enter送信の判定', () => {
  it('素のEnterは送信とみなす', () => {
    expect(isSendKey({ key: 'Enter' })).toBe(true);
  });

  it('IME変換確定のEnterは送信とみなさない（isComposing）', () => {
    expect(isSendKey({ key: 'Enter', isComposing: true })).toBe(false);
  });

  it('IME変換確定のEnterは送信とみなさない（keyCode 229）', () => {
    expect(isSendKey({ key: 'Enter', keyCode: 229 })).toBe(false);
  });

  it('Shift+Enterは改行なので送信とみなさない', () => {
    expect(isSendKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('Enter以外のキーは対象外', () => {
    expect(isSendKey({ key: 'a' })).toBe(false);
    expect(isSendKey(null)).toBe(false);
  });
});

describe('承認の有効判定', () => {
  const now = 1_000_000;

  it('同一テキストかつ有効期間内なら通す', () => {
    expect(approvalMatches({ text: 'あ', until: now + 1 }, 'あ', now)).toBe(true);
  });

  it('テキストが変わっていたら通さない（編集したら再検査される）', () => {
    expect(approvalMatches({ text: 'あ', until: now + 1 }, 'あい', now)).toBe(false);
  });

  it('期限切れなら通さない', () => {
    expect(approvalMatches({ text: 'あ', until: now }, 'あ', now)).toBe(false);
  });

  it('承認が無ければ通さない', () => {
    expect(approvalMatches(null, 'あ', now)).toBe(false);
  });
});

describe('サイトアダプタの選択', () => {
  it('ホスト名に対応するアダプタを返す', () => {
    const site = selectSite('chatgpt.com', globalThis.PII_SITES, globalThis.PII_GENERIC);
    expect(site.editor).toContain('#prompt-textarea');
  });

  it('未知のホストは汎用セレクタにフォールバックする', () => {
    const site = selectSite('example.com', globalThis.PII_SITES, globalThis.PII_GENERIC);
    expect(site).toBe(globalThis.PII_GENERIC);
  });

  it('汎用セレクタは textarea と contenteditable の両方を拾う', () => {
    expect(globalThis.PII_GENERIC.editor).toContain('textarea');
    expect(globalThis.PII_GENERIC.editor).toContain('contenteditable');
  });
});

describe('続行ボタンの可否', () => {
  it('既定（警告のみ）では続行できる', () => {
    expect(canProceedWith([{ level: 'warn' }, { level: 'notice' }])).toBe(true);
  });

  it('ポリシーでブロック指定された種別があれば続行させない', () => {
    expect(canProceedWith([{ level: 'warn' }, { level: 'block' }])).toBe(false);
  });
});

describe('件数ログの代表レベル', () => {
  it('強い順に1つ選ぶ', () => {
    expect(summaryLevel([{ level: 'notice' }, { level: 'warn' }])).toBe('warn');
    expect(summaryLevel([{ level: 'notice' }])).toBe('notice');
    expect(summaryLevel([{ level: 'block' }, { level: 'warn' }])).toBe('block');
  });
});

describe('manifest.json', () => {
  it('Manifest V3 である', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('拡張機能ページのCSPで connect-src none を指定している（ADR-0002）', () => {
    expect(manifest.content_security_policy.extension_pages).toContain("connect-src 'none'");
  });

  it('過剰な権限を要求していない（ADR-0002）', () => {
    expect(manifest.permissions).toEqual(['storage']);
    expect(manifest.host_permissions).toBeUndefined();
    for (const forbidden of ['webRequest', 'tabs', 'identity', '<all_urls>']) {
      expect(JSON.stringify(manifest)).not.toContain(forbidden);
    }
  });

  it('対象ドメインのみにコンテンツスクリプトを注入する', () => {
    expect(manifest.content_scripts[0].matches).toEqual([
      'https://chatgpt.com/*',
      'https://chat.openai.com/*'
    ]);
  });

  it('document_start で読み込む（サイトのハンドラより先にリスナーを登録するため）', () => {
    expect(manifest.content_scripts[0].run_at).toBe('document_start');
  });

  it('スクリプトを依存順に列挙している', () => {
    expect(manifest.content_scripts[0].js).toEqual([
      'src/rules.js',
      'src/detector.js',
      'src/sites.js',
      'src/modal.js',
      'src/content.js'
    ]);
  });
});
