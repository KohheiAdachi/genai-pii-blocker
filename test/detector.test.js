import { describe, it, expect } from 'vitest';
import vectors from './vectors.json' with { type: 'json' };

// src/*.js は globalThis に代入するだけのスクリプト。
// 拡張機能側では manifest.json の content_scripts.js に列挙して読み込むため、
// テストでも同じ順序で読み込む（ADR-0007）。
import '../src/rules.js';
import '../src/detector.js';

const { Detector } = globalThis;

/** 検出結果を [ruleId, level] の配列にする */
const levels = (text) => Detector.detect(text).map((f) => [f.ruleId, f.level]);

describe('テストベクタ（開発ドキュメント 7.2）', () => {
  for (const v of vectors) {
    const expected = v.expect.map((e) => [e.ruleId, e.level]);
    it(`${JSON.stringify(v.input)} → ${expected.length ? JSON.stringify(expected) : '検出なし'}（${v.note}）`, () => {
      expect(levels(v.input)).toEqual(expected);
    });
  }
});

describe('保険者番号の検証番号', () => {
  const { luhn } = Detector._internal;

  it('設定要領の計算例（復元値）を通す', () => {
    expect(luhn('06130488')).toBe(true);
  });

  it('1桁変えると通らない', () => {
    expect(luhn('06130489')).toBe(false);
  });

  it('国民健康保険の6桁も同じ計算で検証できる', () => {
    expect(luhn('131235')).toBe(true);
    expect(luhn('131234')).toBe(false);
  });

  it('数字以外を含む文字列は false', () => {
    expect(luhn('0613001a')).toBe(false);
    expect(luhn('')).toBe(false);
  });
});

describe('マイナンバーの検査用数字', () => {
  const { myNumber } = Detector._internal;

  it('検査用数字が一致する', () => {
    expect(myNumber('123456789018')).toBe(true);
  });

  it('検査用数字が一致しない', () => {
    expect(myNumber('123456789019')).toBe(false);
  });

  it('12桁以外は false', () => {
    expect(myNumber('12345678901')).toBe(false);
    expect(myNumber('1234567890123')).toBe(false);
  });
});

describe('正規化と位置対応表', () => {
  const { normalizeWithMap } = Detector._internal;

  it('全角英数字・全角空白を半角化する', () => {
    expect(normalizeWithMap('０６１３　').text).toBe('0613 ');
  });

  it('数字に挟まれたハイフン類を - に統一する', () => {
    expect(normalizeWithMap('0613−0017').text).toBe('0613-0017');
    expect(normalizeWithMap('0613ー0017').text).toBe('0613-0017');
  });

  it('数字に挟まれていない長音は残す', () => {
    expect(normalizeWithMap('データー').text).toBe('データー');
  });

  it('map は正規化後の各文字から元テキストの位置を引ける', () => {
    const { text, map } = normalizeWithMap('あ０６い');
    expect(text).toBe('あ06い');
    expect(map.length).toBe(text.length + 1);
    // 正規化後の '0' は元テキストの1文字目
    expect(map[1]).toBe(1);
    expect(map[map.length - 1]).toBe(4);
  });
});

describe('マスク', () => {
  it('元テキストの位置で置換される（全角数字）', () => {
    const src = '保険証の保険者番号は０６１３００１７です';
    const out = Detector.mask(src, Detector.detect(src));
    expect(out).toBe('保険証の保険者番号は[保険者番号]です');
  });

  it('区切り文字を含む範囲もまとめて置換される', () => {
    const src = '保険者番号 0613-0017 です';
    const out = Detector.mask(src, Detector.detect(src));
    expect(out).toBe('保険者番号 [保険者番号] です');
  });

  it('複数の検出箇所を後ろから置換する', () => {
    const src = '保険者番号 06130017 とマイナンバー 123456789018 を記載';
    const out = Detector.mask(src, Detector.detect(src));
    expect(out).toBe('保険者番号 [保険者番号] とマイナンバー [マイナンバー] を記載');
  });

  it('検出なしなら元のまま', () => {
    expect(Detector.mask('通常の文章', [])).toBe('通常の文章');
  });
});

describe('伏せ字（preview）', () => {
  it('先頭2桁以外を伏せる', () => {
    expect(Detector.preview('06130017')).toBe('06******');
  });

  it('4文字以下は全部伏せる', () => {
    expect(Detector.preview('1234')).toBe('****');
  });

  it('完全な値が残らない', () => {
    expect(Detector.preview('123456789018')).not.toContain('9018');
  });
});

describe('判定理由（ADR-0013：なぜ止めたかを示す）', () => {
  const reasons = (text) => Detector.detect(text)[0].reasons;

  it('形式一致・検証番号一致・強キーワードを挙げる', () => {
    expect(reasons('保険者番号 06130017')).toEqual([
      '8桁の数字という形式が一致',
      '検証番号（チェックディジット）が一致',
      '近くに「保険者番号」というキーワードがある'
    ]);
  });

  it('否定キーワードで減点したことを示す', () => {
    const r = reasons('注文番号 06130017');
    expect(r).toContain('「注文番号」があるため減点した');
    expect(r).toContain('確実なキーワードがないため、参考表示に留めた');
  });

  it('弱いキーワードしかない場合はそう書く', () => {
    expect(reasons('番号 06130017')).toContain('近くに「番号」という語がある（弱い一致）');
  });

  it('キーワードがなければ上限に留めた理由だけが付く', () => {
    const r = reasons('06130017');
    expect(r).toEqual([
      '8桁の数字という形式が一致',
      '検証番号（チェックディジット）が一致',
      '確実なキーワードがないため、参考表示に留めた'
    ]);
  });

  it('検出値そのものは理由に含まれない', () => {
    for (const r of reasons('保険者番号 06130017')) {
      expect(r).not.toContain('06130017');
    }
  });
});

describe('判定レベル', () => {
  it('管理者ポリシーで action が block のルールは block になる', () => {
    const rules = [{ ...globalThis.PII_RULES[0], action: 'block' }];
    const found = Detector.detect('保険者番号 06130017', { rules });
    expect(found.map((f) => f.level)).toEqual(['block']);
  });

  it('enabled: false のルールは検査されない', () => {
    const rules = [{ ...globalThis.PII_RULES[0], enabled: false }];
    expect(Detector.detect('保険者番号 06130017', { rules })).toEqual([]);
  });

  it('閾値を上げると notice も落ちる', () => {
    const thresholds = { high: 200, low: 150 };
    expect(Detector.detect('保険者番号 06130017', { thresholds })).toEqual([]);
  });

  it('未知のバリデータ名は検証なしで通さず、対象外にする', () => {
    const rules = [{ ...globalThis.PII_RULES[0], validator: 'unknown' }];
    expect(Detector.detect('保険者番号 06130017', { rules })).toEqual([]);
  });
});

describe('入力の扱い', () => {
  it('空文字・非文字列は空配列を返す', () => {
    expect(Detector.detect('')).toEqual([]);
    expect(Detector.detect(null)).toEqual([]);
    expect(Detector.detect(undefined)).toEqual([]);
  });

  it('不正な正規表現のルールがあっても検査全体は止まらない', () => {
    const rules = [
      { id: 'broken', label: '壊れたルール', kind: 'regex', pattern: '([', action: 'warn' },
      globalThis.PII_RULES[0]
    ];
    const found = Detector.detect('保険者番号 06130017', { rules });
    expect(found.map((f) => f.ruleId)).toEqual(['insurer_number']);
  });
});

describe('性能（非機能要件 2.2）', () => {
  it('1万文字の検査を50ms以内で終える', () => {
    // 業務文書風に日本語と数字を混ぜる。ダミー番号を1件だけ埋め込む
    const chunk = 'これは議事録のテスト文章です。参加者は5名、資料は3点。番号は987654321。';
    let text = '';
    while (text.length < 10000) text += chunk;
    text = text.slice(0, 10000) + '保険者番号 06130017';

    const started = performance.now();
    const found = Detector.detect(text);
    const elapsed = performance.now() - started;

    expect(found.some((f) => f.ruleId === 'insurer_number')).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });
});
