// src/detector.js — 検出エンジン。
//
// 「正規化 → パターン照合 → チェックディジット検証 → 文脈キーワードによる
// スコア加算 → 判定」の順で検査する（開発ドキュメント 3章、ADR-0005）。
//
// 判定レベルは3種（ADR-0013）:
//   'block'  … 送信不可。管理者ポリシーの blockRules で指定された種別のみ
//   'warn'   … 警告（強調表示）。既定。送信は確認ポップアップで止まるが承認で送信できる
//   'notice' … 警告（参考表示）。送信可否は 'warn' と同じ
//
// 外部通信APIは一切使わない（ADR-0002）。console への出力も行わない（ADR-0008）。
globalThis.Detector = (() => {
  // ハイフンとして扱う文字。長音「ー」も含むが、数字に挟まれた場合だけ置換する
  const DASHES = '‐‑‒–—―−ー';
  const DASH_BETWEEN_DIGITS = new RegExp(`(?<=[0-9])[${DASHES}](?=[0-9])`, 'g');

  // 区切り（空白・ハイフン・ドット）を挟んだ数字列を候補として抽出する。
  // 先頭の1桁＋3〜18桁で、4〜19桁の数字列に対応する
  const NUMERIC_RUN = /(?<![0-9])[0-9](?:[ \-.]?[0-9]){3,18}(?![0-9])/g;

  const DEFAULT_THRESHOLDS = { high: 70, low: 40 };

  // スコアの配点（開発ドキュメント 3.5）
  const SCORE = { format: 30, validator: 40, strong: 40, weak: 15, negative: -40 };

  // 文脈キーワードを探す範囲（候補の前後の文字数）
  const CONTEXT_CHARS = 40;

  // 1文字ずつNFKC正規化し、正規化後の各文字が元テキストの何文字目に対応するかを
  // 記録する。マスク時に元テキストの位置を置換するために必要（ADR-0005）。
  // map の長さは text.length + 1 で、末尾には元テキストの終端位置が入る。
  function normalizeWithMap(src) {
    let text = '';
    const map = [];
    let i = 0;
    for (const ch of src) {
      const n = ch.normalize('NFKC');
      for (let k = 0; k < n.length; k++) {
        text += n[k];
        map.push(i);
      }
      i += ch.length;
    }
    map.push(i);
    // 数字に挟まれたハイフン類だけを '-' に統一する。
    // 置換は1文字→1文字なので map の対応関係は崩れない。
    // 「データーを整理」のような長音を壊さないため、数字に挟まれた場合に限定する。
    text = text.replace(DASH_BETWEEN_DIGITS, '-');
    return { text, map };
  }

  // 保険者番号・公費負担者番号・受給者番号・医療機関等コードの検証番号。
  // 末尾の桁を起点に2と1を交互に乗じ、積が2桁なら桁の和を取り、合計の下1桁を
  // 10から引く（厚生労働省「保険者番号等の設定要領」第1の5）。
  // この手順は Luhn アルゴリズムと一致する。
  // 根拠: docs/research/2026-09-21-kouhi-koukikoureisha-number-format.md
  function luhn(d) {
    if (!/^[0-9]+$/.test(d)) return false;
    let sum = 0;
    for (let i = d.length - 1, pos = 0; i >= 0; i--, pos++) {
      let v = d.charCodeAt(i) - 48;
      if (pos % 2 === 1) {
        v *= 2;
        if (v > 9) v -= 9;
      }
      sum += v;
    }
    return sum % 10 === 0;
  }

  // マイナンバーの検査用数字（開発ドキュメント 3.4）。
  // 上位11桁を右から P1…P11 とし、重み Qn を n<=6 なら n+1、n>=7 なら n-5 として
  // 総和を11で割った余り R から、R<=1 なら 0、R>=2 なら 11-R を検査用数字とする。
  function myNumber(d) {
    if (!/^[0-9]{12}$/.test(d)) return false;
    let sum = 0;
    for (let n = 1; n <= 11; n++) {
      const p = d.charCodeAt(11 - n) - 48;
      const q = n <= 6 ? n + 1 : n - 5;
      sum += p * q;
    }
    const r = sum % 11;
    return (r <= 1 ? 0 : 11 - r) === d.charCodeAt(11) - 48;
  }

  const VALIDATORS = { luhn, myNumber };

  function keywordScore(text, start, end, kw = {}) {
    const ctx = text.slice(
      Math.max(0, start - CONTEXT_CHARS),
      Math.min(text.length, end + CONTEXT_CHARS)
    );
    const has = (list) => (list || []).some((k) => ctx.includes(k));
    const strong = has(kw.strong);
    let s = 0;
    if (strong) s += SCORE.strong;
    if (has(kw.weak)) s += SCORE.weak;
    if (has(kw.negative)) s += SCORE.negative;
    return { score: s, strong };
  }

  function detect(src, settings = {}) {
    const rules = settings.rules || globalThis.PII_RULES || [];
    const thresholds = settings.thresholds || DEFAULT_THRESHOLDS;
    if (typeof src !== 'string' || src === '') return [];

    const { text, map } = normalizeWithMap(src);
    const findings = [];

    const push = (rule, start, end, score) => {
      // 既定では rule.action === 'warn'。'block' は管理者ポリシーで
      // blockRules に指定された種別にのみ入る（ADR-0013）
      let level = 'pass';
      if (score >= thresholds.high) level = rule.action || 'warn';
      else if (score >= thresholds.low) level = 'notice';
      if (level === 'pass') return;
      findings.push({
        ruleId: rule.id,
        label: rule.label,
        level,
        score,
        start: map[start], // 元テキスト上の位置
        end: map[end]
      });
    };

    const enabled = rules.filter((r) => r && r.enabled !== false);

    const numericRules = enabled.filter((r) => r.kind === 'numeric');
    if (numericRules.length) {
      for (const m of text.matchAll(NUMERIC_RUN)) {
        const digits = m[0].replace(/[^0-9]/g, '');
        const start = m.index;
        const end = m.index + m[0].length;
        for (const rule of numericRules) {
          if (!(rule.lengths || []).includes(digits.length)) continue;
          let score = SCORE.format;
          if (rule.validator) {
            const validate = VALIDATORS[rule.validator];
            // 未知のバリデータ名を無言で通すと検証なしで判定してしまうため対象外にする
            if (!validate || !validate(digits)) continue;
            score += SCORE.validator;
          }
          const kw = keywordScore(text, start, end, rule.keywords);
          // キーワード必須型：強キーワードがなければ検出しない
          if (rule.requireKeyword && !kw.strong) continue;
          score += kw.score;
          // 偶然チェックディジットを通る数字列を強調表示しないための上限
          if (rule.requireKeywordForHigh && !kw.strong) {
            score = Math.min(score, thresholds.high - 1);
          }
          push(rule, start, end, score);
        }
      }
    }

    for (const rule of enabled.filter((r) => r.kind === 'regex')) {
      let re;
      try {
        re = new RegExp(rule.pattern, 'g');
      } catch {
        continue; // 管理者ポリシー由来の不正な正規表現で検査全体を止めない
      }
      for (const m of text.matchAll(re)) {
        if (m[0] === '') continue;
        const start = m.index;
        const end = m.index + m[0].length;
        const kw = keywordScore(text, start, end, rule.keywords);
        if (rule.requireKeyword && !kw.strong) continue;
        push(rule, start, end, (rule.baseScore ?? SCORE.format) + kw.score);
      }
    }

    return dedupe(findings);
  }

  // 同じ範囲に複数ルールが当たった場合は、level が強くスコアの高いものを残す
  function dedupe(fs) {
    const rank = { block: 3, warn: 2, notice: 1 };
    fs.sort(
      (a, b) =>
        a.start - b.start ||
        (rank[b.level] || 0) - (rank[a.level] || 0) ||
        b.score - a.score
    );
    const out = [];
    for (const f of fs) {
      const last = out[out.length - 1];
      if (last && f.start < last.end) continue;
      out.push(f);
    }
    return out;
  }

  // 検出箇所を「[保険者番号]」のようなラベルに置換する。
  // AIへの文脈は残しつつ値だけを消すため、削除ではなくラベルに置き換える。
  function mask(src, findings) {
    let out = src;
    for (const f of [...findings].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, f.start) + `[${f.label}]` + out.slice(f.end);
    }
    return out;
  }

  // UI表示用：先頭2桁以外を伏せる。完全な値をDOMに書き出さないため（ADR-0008）
  function preview(value) {
    const s = String(value ?? '');
    return s.length <= 4 ? '*'.repeat(s.length) : s.slice(0, 2) + '*'.repeat(s.length - 2);
  }

  return {
    detect,
    mask,
    preview,
    _internal: { luhn, myNumber, normalizeWithMap, keywordScore, dedupe }
  };
})();
