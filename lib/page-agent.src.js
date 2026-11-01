/**
 * 页面侧 DOM 代理（页面上下文里运行，油猴脚本和 CDP 驱动共用同一份）
 * 目标：不依赖具体站点的哈希 class，用多套选择器 + 文本稳定性检测完成收发。
 */
(function () {
  'use strict';

  const VERSION = 3;
  if (window.__AIAgent && window.__AIAgent.__v === VERSION) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const PROFILES = [
    {
      id: 'deepseek',
      match: (h) => h.includes('deepseek.com'),
      assistant: ['.ds-markdown', '[class*="ds-markdown"]'],
      composer: ['textarea#chat-input', 'textarea[placeholder]', 'textarea', 'div[contenteditable="true"]', '[role="textbox"]'],
    },
    {
      id: 'chatgpt',
      match: (h) => h.includes('chatgpt.com') || h.includes('chat.openai.com'),
      assistant: ['[data-message-author-role="assistant"] .markdown', '[data-message-author-role="assistant"]'],
      composer: ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea'],
    },
    {
      id: 'kimi',
      match: (h) => h.includes('kimi.com') || h.includes('moonshot.cn'),
      assistant: ['[class*="segment-content"]', '.markdown', '[class*="markdown"]'],
      composer: ['div[contenteditable="true"]', 'textarea'],
    },
    {
      id: 'generic',
      match: () => true,
      assistant: [
        '[data-message-author-role="assistant"]',
        '[class*="ds-markdown"]',
        '[class*="markdown"]',
        '[class*="prose"]',
      ],
      composer: ['textarea', 'div[contenteditable="true"]', '[role="textbox"]'],
    },
  ];

  function profile() {
    const h = location.host || '';
    return PROFILES.find((p) => p.match(h)) || PROFILES[PROFILES.length - 1];
  }

  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 8) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  }

  function findComposer() {
    for (const sel of profile().composer) {
      let list = [];
      try { list = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
      for (const el of list) {
        if (!visible(el)) continue;
        if (el.disabled || el.readOnly) continue;
        if (el.getAttribute('aria-hidden') === 'true') continue;
        return el;
      }
    }
    return null;
  }

  function getInputText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return (el.innerText || el.textContent || '').trim();
  }

  /** DOM 节点 → 近似 markdown 文本，保留代码块围栏 */
  function serialize(root) {
    if (!root) return '';
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll('button, svg, [class*="copy"], [class*="toolbar"], [class*="action"], [class*="icon"]')
      .forEach((n) => { try { n.remove(); } catch (e) {} });

    // 代码块上方那个语言标签（"powershell"）是独立元素，会混进正文，去掉
    clone.querySelectorAll('div, span').forEach((el) => {
      if (el.children.length) return;
      const t = (el.textContent || '').trim();
      if (!t || t.length > 14) return;
      if (!/^(powershell|ps1|pwsh|python|py|javascript|js|typescript|ts|json|bash|sh|shell|cmd|bat|text|plaintext|sql|html|css|xml|yaml|java|c|cpp|csharp|go|rust)$/i.test(t)) return;
      const nx = el.nextElementSibling;
      const pv = el.previousElementSibling;
      const nearPre = (nx && (nx.tagName === 'PRE' || nx.querySelector('pre'))) || (pv && pv.tagName === 'PRE');
      if (nearPre) { try { el.remove(); } catch (e) {} }
    });
    clone.querySelectorAll('pre').forEach((pre) => {
      const codeEl = pre.querySelector('code');
      const cls = (pre.className || '') + ' ' + (codeEl ? codeEl.className || '' : '');
      const m = cls.match(/language-([a-zA-Z0-9+#]+)/);
      const lang = m ? m[1] : '';
      let code = (codeEl || pre).innerText || (codeEl || pre).textContent || '';
      code = code.replace(/\r\n/g, '\n').replace(/\n+$/, '');
      const fence = '`'.repeat(3);
      const node = document.createTextNode('\n' + fence + lang + '\n' + code + '\n' + fence + '\n');
      try { pre.replaceWith(node); } catch (e) {}
    });
    clone.querySelectorAll('li').forEach((li) => {
      // 保证列表项之间换行，innerText 在部分浏览器里不插换行
      if (!/^\s*[•\-*\d]/.test(li.innerText || '')) {
        try { li.insertBefore(document.createTextNode('• '), li.firstChild); } catch (e) {}
      }
    });
    let text = clone.innerText || clone.textContent || '';
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** 排除"思考过程 / 引用"这类不该当回答的块 */
  function isThinkingBlock(el) {
    let n = el;
    for (let i = 0; i < 6 && n && n !== document.body; i++) {
      const c = (n.className || '') + ' ' + (n.getAttribute && (n.getAttribute('data-testid') || '') || '');
      if (/think|reason|thought|cot-|citation/i.test(String(c))) return true;
      n = n.parentElement;
    }
    return false;
  }

  function assistantEls() {
    const trySelectors = (list) => {
      for (const sel of list) {
        let els = [];
        try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { continue; }
        els = els.filter((el) => (el.textContent || '').trim().length > 0 && !isThinkingBlock(el));
        if (els.length) return els;
      }
      return null;
    };
    return trySelectors(profile().assistant) || trySelectors(PROFILES[PROFILES.length - 1].assistant) || [];
  }

  function snapshot() {
    const els = assistantEls();
    const last = els.length ? els[els.length - 1] : null;
    return { count: els.length, text: last ? serialize(last) : '' };
  }

  function setInput(text) {
    const el = findComposer();
    if (!el) return { ok: false, error: '没找到聊天输入框（页面结构可能变了，或还没登录）' };
    try { el.focus(); } catch (e) {}
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, text);
      } catch (e) {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    const got = getInputText(el);
    if (!got.trim()) return { ok: false, error: '文字没能写进输入框' };
    return { ok: true, value: got };
  }

  function pressEnter(el) {
    const base = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true, view: window,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', base));
    el.dispatchEvent(new KeyboardEvent('keypress', base));
    el.dispatchEvent(new KeyboardEvent('keyup', base));
  }

  function clickableAncestor(el) {
    let n = el;
    for (let i = 0; i < 4 && n; i++) {
      if (n.tagName === 'BUTTON' || n.getAttribute && n.getAttribute('role') === 'button') return n;
      n = n.parentElement;
    }
    return null;
  }

  function findSendButton() {
    const cands = Array.from(document.querySelectorAll('button, div[role="button"], [class*="send"]'));
    const scored = [];
    for (const b of cands) {
      if (!visible(b)) continue;
      const label = (b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.className || '') + ' ' + (b.textContent || '').slice(0, 30);
      if (!/发送|send|submit/i.test(label)) continue;
      if (b.disabled || b.getAttribute('aria-disabled') === 'true') continue;
      scored.push(b);
    }
    if (scored.length) return scored[scored.length - 1];

    // 兜底：输入框附近、右侧、含 svg 的可点击元素
    const comp = findComposer();
    if (!comp) return null;
    const box = comp.getBoundingClientRect();
    let best = null;
    let bestD = Infinity;
    for (const el of document.querySelectorAll('button, div[role="button"]')) {
      if (!el.querySelector('svg')) continue;
      if (!visible(el)) continue;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      const r = el.getBoundingClientRect();
      if (r.left < box.left + box.width * 0.5) continue;
      if (Math.abs(r.top - box.top) > box.height + 40) continue;
      const d = Math.hypot(r.left - box.right, r.top - box.bottom);
      if (d < bestD) { bestD = d; best = el; }
    }
    return best;
  }

  /** 只负责"按下发送"：回车 → 点按钮，两条路都试 */
  async function submit() {
    const el = findComposer();
    if (!el) return { ok: false, error: '输入框不见了' };
    if (!getInputText(el).trim()) return { ok: false, error: '输入框是空的' };

    pressEnter(el);
    for (let i = 0; i < 6; i++) {
      await sleep(200);
      if (!getInputText(el).trim()) return { ok: true, via: 'enter' };
    }

    const btn = findSendButton();
    if (btn) {
      try { btn.click(); } catch (e) {}
      for (let i = 0; i < 8; i++) {
        await sleep(200);
        if (!getInputText(el).trim()) return { ok: true, via: 'click' };
      }
    }
    return { ok: false, error: '消息没能发出去（回车和点按钮都失败），请手动点一次发送' };
  }

  async function sendMessage(text) {
    const setRes = setInput(text);
    if (!setRes.ok) return setRes;
    await sleep(150);
    return submit();
  }

  async function waitForReply(before, opts) {
    const o = Object.assign({ stableMs: 1600, timeoutMs: 240000, minMs: 900, pollMs: 400 }, opts || {});
    const t0 = Date.now();
    let started = false;
    let last = '';
    let lastChange = Date.now();

    while (Date.now() - t0 < o.timeoutMs) {
      await sleep(o.pollMs);
      const s = snapshot();
      const grew = s.count > before.count || (s.text && s.text !== before.text);
      if (!started) {
        if (grew) {
          started = true;
          last = s.text;
          lastChange = Date.now();
        }
        continue;
      }
      if (s.text !== last) {
        last = s.text;
        lastChange = Date.now();
      } else if (last && Date.now() - lastChange >= o.stableMs && Date.now() - t0 >= o.minMs) {
        return { ok: true, text: last, elapsedMs: Date.now() - t0 };
      }
    }
    if (started && last) return { ok: true, text: last, partial: true };
    return { ok: false, error: '等待 AI 回复超时' };
  }

  /** 聚焦输入框并把光标放到末尾（配合 CDP 的真实输入事件） */
  function focusComposer() {
    const el = findComposer();
    if (!el) return false;
    try { el.focus(); } catch (e) {}
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const n = (el.value || '').length;
      try { el.setSelectionRange(n, n); } catch (e) {}
    } else {
      try {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (e) {}
    }
    return document.activeElement === el || el.contains(document.activeElement);
  }

  /** 输入框里现在有没有字 */
  function hasText() {
    const el = findComposer();
    return !!(el && getInputText(el).trim());
  }

  function status() {
    const c = findComposer();
    const s = snapshot();
    return {
      host: location.host,
      href: location.href,
      profile: profile().id,
      hasComposer: !!c,
      assistantCount: s.count,
      lastLen: s.text.length,
      title: document.title,
    };
  }

  window.__AIAgent = {
    __v: VERSION,
    sleep,
    profile,
    findComposer,
    findSendButton,
    getInputText,
    focusComposer,
    hasText,
    serialize,
    snapshot,
    setInput,
    submit,
    sendMessage,
    waitForReply,
    status,
  };
})();
