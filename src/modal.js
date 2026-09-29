// src/modal.js — 確認ポップアップ（closed Shadow DOM）
//
// ADR-0009 / ADR-0013 / 開発ドキュメント 5.7・6.4
// - closed な Shadow DOM に描画し、ページのスクリプトから内部DOMを辿れないようにする
// - 「このまま送信する」はページからの合成クリックで押せないよう event.isTrusted を検証する
// - 検出値は伏せ字にしてから表示し、完全な値をDOMに書き出さない（ADR-0008）
// - 既定のフォーカスは「編集に戻る」に置く（誤承認の防止）
globalThis.PiiModal = (() => {
  const TITLE = '個人情報が含まれている可能性があります';
  const MAX_ITEMS = 12; // 一覧の表示上限（これを超えた分は件数のみ示す）
  const MAX_PREVIEW = 32; // 伏せ字の表示上限

  // 開いているポップアップの状態。closed Shadow DOM の参照はこのクロージャの中だけに保持する
  let open = null;

  const LEVEL = {
    block: { badge: '要注意', icon: '⚠', cls: 'lv-block' },
    warn: { badge: '警告', icon: '⚠', cls: 'lv-warn' },
    notice: { badge: '参考', icon: '•', cls: 'lv-notice' }
  };

  const CSS = `
.overlay {
  all: initial;                  /* ページから継承するスタイルを断ち切る */
  display: flex;
  position: absolute;
  inset: 0;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background: rgba(17, 20, 24, 0.55);
  font-family: system-ui, -apple-system, "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif;
  font-size: 14px;
  line-height: 1.7;
  color: #1b1f24;
  text-align: left;
  -webkit-font-smoothing: antialiased;
}
.dialog {
  display: block;
  box-sizing: border-box;
  width: 100%;
  max-width: 520px;
  max-height: 100%;
  overflow-y: auto;
  padding: 20px 22px;
  border-radius: 12px;
  background: #ffffff;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
.head { display: flex; align-items: flex-start; gap: 10px; }
.head .icon { display: block; font-size: 22px; line-height: 1.2; color: #b42318; }
.title { display: block; margin: 0; font-size: 16px; font-weight: 700; line-height: 1.5; }
.lead { display: block; margin: 10px 0 0; color: #3b424b; }
.list { display: block; margin: 14px 0 0; padding: 0; list-style: none; }
.item {
  display: block;
  margin: 8px 0 0;
  padding: 10px 12px;
  border: 1px solid #e3e6ea;
  border-left-width: 4px;
  border-radius: 8px;
  background: #fbfcfd;
}
.item.lv-warn, .item.lv-block { border-left-color: #b42318; background: #fff6f5; }
.item.lv-notice { border-left-color: #b8bfc7; background: #fafbfc; }
.item-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mark { display: inline-block; font-size: 15px; line-height: 1; }
.lv-warn > .item-head > .mark, .lv-block > .item-head > .mark { color: #b42318; }
.lv-notice > .item-head > .mark { color: #8b939c; }
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.lv-warn > .item-head > .badge, .lv-block > .item-head > .badge { background: #b42318; color: #ffffff; }
.lv-notice > .item-head > .badge { background: #eceef1; color: #5a626c; }
.label { display: inline-block; font-weight: 700; }
.lv-notice .label { font-weight: 600; color: #4a525c; }
.value {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  background: #eef1f4;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  letter-spacing: 0.06em;
}
.reason { display: block; margin: 4px 0 0; font-size: 12.5px; color: #5a626c; }
.lv-notice .reason { color: #6d747d; }
.more { display: block; margin: 8px 0 0; font-size: 12.5px; color: #5a626c; }
.note { display: block; margin: 14px 0 0; font-size: 12.5px; color: #5a626c; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; margin: 18px 0 0; }
.btn {
  display: inline-block;
  margin: 0;
  padding: 9px 16px;
  border: 1px solid #c3c9d0;
  border-radius: 8px;
  background: #ffffff;
  color: #1b1f24;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
}
.btn:hover { background: #f4f6f8; }
.btn-primary { border-color: #15803d; background: #15803d; color: #ffffff; }
.btn-primary:hover { background: #166f38; }
.btn-danger { border-color: #b42318; color: #b42318; }
.btn-danger:hover { background: #fff1f0; }
.btn:focus { outline: 3px solid #1d63d1; outline-offset: 2px; }
@media (prefers-color-scheme: dark) {
  .overlay { color: #e8eaed; background: rgba(0, 0, 0, 0.66); }
  .dialog { background: #1f2329; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6); }
  .head .icon { color: #ff9c92; }
  .lead, .reason, .more, .note { color: #b6bcc4; }
  .item { border-color: #363c44; background: #23282f; }
  .item.lv-warn, .item.lv-block { border-left-color: #ff6b5e; background: #2b2320; }
  .item.lv-notice { border-left-color: #4a525c; background: #22262c; }
  .lv-warn > .item-head > .badge, .lv-block > .item-head > .badge { background: #ff6b5e; color: #2a0d0a; }
  .lv-notice > .item-head > .badge { background: #363c44; color: #ced3d9; }
  .lv-notice .label { color: #ced3d9; }
  .lv-warn > .item-head > .mark, .lv-block > .item-head > .mark { color: #ff6b5e; }
  .lv-notice > .item-head > .mark { color: #9aa2ab; }
  .value { background: #2e343b; }
  .btn { border-color: #4a525c; background: #2a2f36; color: #e8eaed; }
  .btn:hover { background: #333941; }
  .btn-primary { border-color: #2f9e56; background: #2f9e56; color: #07200f; }
  .btn-danger { border-color: #ff6b5e; color: #ff9c92; }
  .btn-danger:hover { background: #33231f; }
}
@media (prefers-reduced-motion: no-preference) {
  .dialog { animation: pop 120ms ease-out; }
}
@keyframes pop { from { transform: translateY(6px); opacity: 0; } to { transform: none; opacity: 1; } }
`;

  // 伏せ字。Detector（#3）が未読込のときも値をそのまま表示しないようにする
  function preview(value) {
    const src = String(value == null ? '' : value);
    let masked;
    try {
      masked = globalThis.Detector?.preview ? String(globalThis.Detector.preview(src)) : '*'.repeat(src.length);
    } catch (_) {
      masked = '*'.repeat(src.length);
    }
    if (!masked) masked = '*'.repeat(src.length);
    return masked.length > MAX_PREVIEW ? masked.slice(0, MAX_PREVIEW) + '…' : masked;
  }

  function sliceOf(text, finding) {
    const src = typeof text === 'string' ? text : '';
    const start = Number.isInteger(finding?.start) ? finding.start : 0;
    const end = Number.isInteger(finding?.end) ? finding.end : 0;
    if (!src || end <= start) return '';
    return src.slice(Math.max(0, start), Math.min(src.length, end));
  }

  // 判定理由。検出結果が理由を持っていればそれを使い、無ければスコアから説明する
  function reasonsOf(finding) {
    if (Array.isArray(finding?.reasons) && finding.reasons.length) return finding.reasons.map((r) => String(r));
    if (typeof finding?.reason === 'string' && finding.reason) return [finding.reason];
    const score = Number(finding?.score);
    const out = ['番号の形式が一致'];
    if (Number.isFinite(score)) {
      if (score >= 100) out.push('検証番号が一致', '前後に関連するキーワードあり');
      else if (score >= 70) out.push('検証番号または前後のキーワードが一致');
      else out.push('前後のキーワードは弱い一致のみ');
    }
    return out;
  }

  function el(root, tag, cls, text) {
    const node = root.ownerDocument.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    root.appendChild(node);
    return node;
  }

  // ホスト要素。ページのCSSに消されないよう、インラインの !important で指定する
  function createHost() {
    const host = document.createElement('pii-guard-' + Math.random().toString(36).slice(2, 10));
    host.style.cssText = [
      'all: initial !important',
      'position: fixed !important',
      'inset: 0 !important',
      'display: block !important',
      'z-index: 2147483647 !important',
      'pointer-events: auto !important',
      'visibility: visible !important',
      'opacity: 1 !important'
    ].join(';');
    (document.body || document.documentElement).appendChild(host);
    return host;
  }

  function close() {
    if (!open) return;
    const { host, keydown, focusin, restore } = open;
    open = null;
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('focusin', focusin, true);
    host.remove();
    try {
      if (restore && restore.isConnected) restore.focus();
    } catch (_) {
      /* フォーカスの復帰に失敗しても表示上の問題のみ */
    }
  }

  function run(fn) {
    close();
    if (typeof fn !== 'function') return;
    try {
      fn();
    } catch (_) {
      /* 呼び出し側のコールバックの失敗でポップアップの後始末を止めない */
    }
  }

  function focusables(root) {
    return [...root.querySelectorAll('button')].filter((b) => !b.disabled);
  }

  // ポップアップの骨格を作り、本文を builder に組み立てさせる
  function mount(builder) {
    const restore = document.activeElement;
    close();

    const host = createHost();
    const root = host.attachShadow({ mode: 'closed' }); // ページから shadowRoot を辿れない
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    const overlay = el(root, 'div', 'overlay');
    // 背景のクリックでは閉じない（誤操作での承認・離脱を避ける）
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) e.preventDefault();
    });

    const dialog = el(overlay, 'div', 'dialog');
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('tabindex', '-1');

    const ctx = {
      root,
      dialog,
      // ボタンの追加。ハンドラでは event.isTrusted を検証し、合成クリックを拒否する（ADR-0009）
      button(parent, text, cls, onActivate) {
        const btn = el(parent, 'button', 'btn' + (cls ? ' ' + cls : ''), text);
        btn.type = 'button';
        btn.addEventListener('click', (e) => {
          if (!e.isTrusted) return; // ページのスクリプトによる click() では承認させない
          if (!open || open.root !== root) return;
          e.preventDefault();
          e.stopPropagation();
          onActivate();
        });
        return btn;
      }
    };

    const built = builder(ctx) || {};

    const keydown = (e) => {
      if (!open || open.root !== root) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close(); // Esc は「編集に戻る」と同じ動作
        return;
      }
      if (e.key === 'Tab') {
        // フォーカストラップ：ポップアップの外へ Tab で出さない
        const items = focusables(root);
        if (!items.length) return;
        const current = root.activeElement;
        let index = items.indexOf(current);
        if (index < 0) index = e.shiftKey ? 0 : items.length - 1;
        const next = items[(index + (e.shiftKey ? -1 : 1) + items.length) % items.length];
        e.preventDefault();
        e.stopImmediatePropagation();
        next.focus();
      }
    };

    // ページ側が入力欄へ focus() を戻しても、フォーカスをポップアップに引き戻す
    const focusin = (e) => {
      if (!open || open.root !== root) return;
      if (e.target === host) return; // Shadow DOM 内での移動（ターゲットはホスト要素に再ターゲットされる）
      const items = focusables(root);
      (built.defaultFocus || items[0] || dialog).focus();
    };

    open = { host, root, keydown, focusin, restore };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('focusin', focusin, true);

    // 既定のフォーカスは「編集に戻る」（誤承認の防止。ADR-0013）
    (built.defaultFocus || focusables(root)[0] || dialog).focus();
  }

  function header(ctx, titleText, leadText, tone) {
    const head = el(ctx.dialog, 'div', 'head');
    el(head, 'span', 'icon', tone === 'notice' ? 'ℹ' : '⚠').setAttribute('aria-hidden', 'true');
    const title = el(head, 'h2', 'title', titleText);
    title.id = 'pii-title';
    ctx.dialog.setAttribute('aria-labelledby', title.id);
    if (leadText) {
      const lead = el(ctx.dialog, 'p', 'lead', leadText);
      lead.id = 'pii-lead';
      ctx.dialog.setAttribute('aria-describedby', lead.id);
    }
  }

  function renderFindings(ctx, findings, text) {
    const list = el(ctx.dialog, 'ul', 'list');
    // 強調（block / warn）を先に、参考（notice）を後ろに並べる
    const rank = { block: 0, warn: 1, notice: 2 };
    const sorted = findings
      .slice()
      .sort((a, b) => (rank[a?.level] ?? 3) - (rank[b?.level] ?? 3) || (b?.score || 0) - (a?.score || 0));
    for (const f of sorted.slice(0, MAX_ITEMS)) {
      const level = LEVEL[f?.level] || LEVEL.notice;
      const item = el(list, 'li', 'item ' + level.cls);
      const head = el(item, 'div', 'item-head');
      el(head, 'span', 'mark', level.icon).setAttribute('aria-hidden', 'true');
      el(head, 'span', 'badge', level.badge);
      el(head, 'span', 'label', String(f?.label || f?.ruleId || '不明な種別'));
      const masked = preview(sliceOf(text, f));
      if (masked) el(head, 'span', 'value', masked);
      el(item, 'p', 'reason', '判定理由: ' + reasonsOf(f).join(' / '));
    }
    if (sorted.length > MAX_ITEMS) {
      el(ctx.dialog, 'p', 'more', `ほかに ${sorted.length - MAX_ITEMS} 件の検出があります。`);
    }
    if (sorted.some((f) => f?.level === 'notice')) {
      el(ctx.dialog, 'p', 'note', '「参考」は確度が低い検出です。送信できるかどうかは「警告」と同じで、内容の確認は利用者が行います。');
    }
  }

  // 確認ポップアップ（送信・貼り付け）
  function show(options) {
    const opts = options || {};
    const mode = opts.mode === 'paste' ? 'paste' : 'send';
    const findings = Array.isArray(opts.findings) ? opts.findings : [];
    const text = typeof opts.text === 'string' ? opts.text : '';
    const canProceed = opts.canProceed !== false;
    const proceedLabel = mode === 'paste' ? 'このまま貼り付ける' : 'このまま送信する';

    mount((ctx) => {
      header(
        ctx,
        TITLE,
        mode === 'paste'
          ? '貼り付けようとした内容に次の情報が見つかったため、いったん止めました。'
          : '送信しようとした内容に次の情報が見つかったため、いったん止めました。'
      );
      renderFindings(ctx, findings, text);

      const actions = el(ctx.dialog, 'div', 'actions');
      ctx.button(actions, '該当箇所をマスクする', 'btn-primary', () => run(opts.onMask));
      const back = ctx.button(actions, '編集に戻る', '', () => run(null));
      // 管理者ポリシーでブロック指定された種別のときは続行のボタンを出さない
      if (canProceed) ctx.button(actions, proceedLabel, 'btn-danger', () => run(opts.onProceed));
      return { defaultFocus: back };
    });
  }

  // 検査に失敗したとき（fail-closed。内容を確認のうえ続行できる）
  function showError(options) {
    const opts = options || {};
    mount((ctx) => {
      header(
        ctx,
        '内容を検査できませんでした',
        '検査中にエラーが発生したため、送信をいったん中止しました。内容をご自身で確認のうえ、続行するか編集に戻るかを選んでください。'
      );
      const actions = el(ctx.dialog, 'div', 'actions');
      const back = ctx.button(actions, '編集に戻る', '', () => run(null));
      ctx.button(actions, 'このまま送信する', 'btn-danger', () => run(opts.onProceed));
      return { defaultFocus: back };
    });
  }

  // ファイル添付のブロック（続行の経路は無い）
  function showFileBlocked() {
    mount((ctx) => {
      header(
        ctx,
        'ファイルの添付はブロックされています',
        'ファイルの中身は検査できないため、添付を中止しました。必要な内容は、個人情報を取り除いたうえで本文に入力してください。'
      );
      const actions = el(ctx.dialog, 'div', 'actions');
      const back = ctx.button(actions, '編集に戻る', 'btn-primary', () => run(null));
      return { defaultFocus: back };
    });
  }

  return { show, showError, showFileBlocked, close, isOpen: () => open !== null };
})();
