// src/content.js — イベント捕捉と送信制御。
//
// ISOLATED world で document_start に読み込まれ、window に capture で
// リスナーを登録する。サイト自身のハンドラより先に実行されるため、送信操作を
// 横取りできる（ADR-0003）。
//
// 検出時は送信をいったん止めて確認ポップアップを表示し、利用者が承認したときだけ
// 送信する。既定の判定は警告のみで、ブロックは管理者ポリシーで指定された種別に
// のみ適用される（ADR-0013）。
//
// 外部通信APIは使わない（ADR-0002）。console への出力も行わない（ADR-0008）。
globalThis.PiiContent = (() => {
  // 承認の有効期間。一度の「このまま送信する」が以降の入力にまで効くと
  // 警告が実質的に無効化されるため、同一テキストかつこの時間内に限る（ADR-0013）
  const APPROVAL_MS = 10_000;

  // ---- 副作用のない判定ロジック（単体テスト対象） ----

  // Enterでの送信とみなすか。
  // IME変換確定のEnter（isComposing / keyCode 229）を送信と誤認すると
  // 日本語入力が壊れる。Shift+Enter は改行なので対象外。
  function isSendKey(e) {
    if (!e || e.key !== 'Enter') return false;
    if (e.isComposing || e.keyCode === 229) return false;
    if (e.shiftKey) return false;
    return true;
  }

  // 承認が有効か。同一テキストかつ有効期間内のときだけ通す。
  // テキストを編集すれば承認は効かず、再検査される。
  function approvalMatches(approved, text, now) {
    return Boolean(approved) && approved.text === text && now < approved.until;
  }

  // ホスト名からサイトアダプタを選ぶ。未知のホストは汎用セレクタにフォールバックする
  function selectSite(hostname, sites, generic) {
    return (sites && sites[hostname]) || generic;
  }

  // 検出結果から、続行ボタンを出してよいかを決める。
  // 既定では block レベルは発生しないため true。ポリシー指定時のみ false（ADR-0013）
  function canProceedWith(findings) {
    return !findings.some((f) => f.level === 'block');
  }

  // 件数ログに渡す代表レベル。強い順に1つだけ選ぶ
  function summaryLevel(findings) {
    return ['block', 'warn', 'notice'].find((lv) => findings.some((f) => f.level === lv));
  }

  const internals = { isSendKey, approvalMatches, selectSite, canProceedWith, summaryLevel };

  // ---- ここから下はDOMに触る。テスト環境では実行しない ----

  function init() {
    const site = selectSite(location.hostname, globalThis.PII_SITES, globalThis.PII_GENERIC);
    const generic = globalThis.PII_GENERIC;

    let settings = {
      thresholds: { high: 70, low: 40 },
      rules: globalThis.PII_RULES,
      blockFiles: true
    };
    let approved = null; // 利用者が確認ポップアップで承認した { text, until }

    // 利用者設定の読み込み。管理者ポリシー（storage.managed）との統合は #20。
    // 読み込み前に送信された場合は同梱ルールの既定値で検査する
    try {
      chrome.storage.local.get(null).then(
        (local) => { settings = mergeSettings(settings, local || {}); },
        () => {}
      );
    } catch { /* storage が使えなくても既定値で動く */ }

    function mergeSettings(base, src) {
      const disabled = new Set(src.disabledRules || []);
      const toBlock = new Set(src.blockRules || []); // 既定は空＝すべて警告
      return {
        ...base,
        thresholds: src.thresholds || base.thresholds,
        blockFiles: src.blockFileUpload ?? base.blockFiles,
        rules: [...(globalThis.PII_RULES || []), ...(src.customRules || [])].map((r) => ({
          ...r,
          enabled: !disabled.has(r.id),
          action: toBlock.has(r.id) ? 'block' : r.action || 'warn'
        }))
      };
    }

    const matches = (el, selector) => {
      if (!el || typeof el.closest !== 'function') return null;
      try {
        return el.closest(selector);
      } catch {
        return null; // セレクタが壊れていても捕捉全体を止めない
      }
    };

    // サイト固有セレクタと汎用セレクタの両方を試す（ADR-0011）
    const findEditor = (target) => matches(target, site.editor) || matches(target, generic.editor);
    const isSendButton = (target) =>
      matches(target, site.sendButton) || matches(target, generic.sendButton);

    function currentEditor() {
      const active = document.activeElement;
      const fromActive = matches(active, site.editor) || matches(active, generic.editor);
      if (fromActive) return fromActive;
      return document.querySelector(site.editor) || document.querySelector(generic.editor);
    }

    const getText = (el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText) || '';

    const stop = (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    function check(e, el, mode) {
      const text = getText(el);
      if (!text.trim()) return;

      // 承認済みならそのまま通す。承認は一度きりで消費する
      if (approvalMatches(approved, text, Date.now())) {
        approved = null;
        return;
      }

      let findings;
      try {
        findings = globalThis.Detector.detect(text, settings);
      } catch {
        // fail-closed：検査できなければまず止める。
        // ただし業務を止めないよう、利用者は確認のうえ続行できる（ADR-0013）
        stop(e);
        globalThis.PiiModal.showError({ onProceed: () => approve(text, e) });
        return;
      }
      if (!findings.length) return;

      stop(e);
      report(findings);
      globalThis.PiiModal.show({
        mode,
        findings,
        text,
        canProceed: canProceedWith(findings),
        onMask: () => replaceEditorText(el, globalThis.Detector.mask(text, findings)),
        onProceed: () => approve(text, e)
      });
    }

    // 承認を記録し、止めた操作をもう一度起こす。
    // 再発火が効かないサイトでも、利用者が10秒以内に同じ操作をやり直せば通る
    function approve(text, e) {
      approved = { text, until: Date.now() + APPROVAL_MS };
      redispatch(e);
    }

    function redispatch(e) {
      try {
        if (e.type === 'keydown') {
          const target = e.target;
          if (!target || typeof target.dispatchEvent !== 'function') return;
          target.focus?.();
          target.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
              composed: true
            })
          );
          return;
        }
        const button = isSendButton(e.target);
        if (button && typeof button.click === 'function') button.click();
      } catch { /* 再発火に失敗しても、承認は残っているので手動でやり直せる */ }
    }

    // Enter送信（IME変換確定のEnter、Shift+Enterの改行は除外）
    window.addEventListener(
      'keydown',
      (e) => {
        if (!isSendKey(e)) return;
        const el = findEditor(e.target);
        if (el) check(e, el, 'send');
      },
      true
    );

    // 送信ボタン（サイトによっては pointerdown で送信するため両方を捕捉）
    for (const type of ['pointerdown', 'click']) {
      window.addEventListener(
        type,
        (e) => {
          if (!isSendButton(e.target)) return;
          const el = currentEditor();
          if (el) check(e, el, 'send');
        },
        true
      );
    }

    // フォーム送信
    window.addEventListener(
      'submit',
      (e) => {
        const el = currentEditor();
        if (el) check(e, el, 'send');
      },
      true
    );

    // 貼り付け・ドロップ：入力欄に入る前に検査する
    function onIncoming(e, data) {
      const el = findEditor(e.target) || currentEditor();
      if (!el || !data) return;

      if (data.files?.length && settings.blockFiles) {
        stop(e);
        globalThis.PiiModal.showFileBlocked();
        return;
      }

      const text = data.getData('text/plain') || '';
      if (!text.trim()) return;

      let findings;
      try {
        findings = globalThis.Detector.detect(text, settings);
      } catch {
        stop(e);
        globalThis.PiiModal.showError({ onProceed: () => insertAtCursor(el, text) });
        return;
      }
      if (!findings.length) return;

      stop(e);
      report(findings);
      globalThis.PiiModal.show({
        mode: 'paste',
        findings,
        text,
        canProceed: canProceedWith(findings),
        onMask: () => insertAtCursor(el, globalThis.Detector.mask(text, findings)),
        onProceed: () => insertAtCursor(el, text)
      });
    }
    window.addEventListener('paste', (e) => onIncoming(e, e.clipboardData), true);
    window.addEventListener('drop', (e) => onIncoming(e, e.dataTransfer), true);

    // 入力欄の書き換え。
    // React / ProseMirror の内部状態が追従するよう、ネイティブな編集操作で行う。
    // 直接代入するとDOMだけが変わり、表示はマスクされているのに送信内容は
    // マスク前、という最悪の失敗が起きる（ADR-0010）
    function replaceEditorText(el, newText) {
      try {
        el.focus();
        if (el.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(el, newText);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, newText);
      } catch {
        // マスクに失敗したら、書き換えたつもりで送信されるのが最も危険なので
        // 何もしない。利用者は「編集に戻る」で自分で直せる
      }
    }

    function insertAtCursor(el, text) {
      try {
        el.focus();
        document.execCommand('insertText', false, text);
      } catch { /* 同上 */ }
    }

    // 検出件数のみを通知する。検出値そのものは渡さない（ADR-0008）。
    // 受け側の Service Worker は #10 で実装するため、現時点では届かず握り潰される
    function report(findings) {
      try {
        chrome.runtime
          .sendMessage({
            type: 'detected',
            site: location.hostname,
            kinds: [...new Set(findings.map((f) => f.ruleId))],
            level: summaryLevel(findings)
          })
          ?.catch(() => {});
      } catch { /* 受け側がいなくても検査は続ける */ }
    }
  }

  // 拡張機能として読み込まれたときだけ動かす。
  // 単体テストでは判定ロジックだけを import して検証する
  if (typeof window !== 'undefined' && typeof document !== 'undefined') init();

  return { _internal: internals };
})();
