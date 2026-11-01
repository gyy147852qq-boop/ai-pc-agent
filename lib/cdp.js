'use strict';
/**
 * 备用桥接：用 Chrome DevTools Protocol 直接驱动一个真实浏览器窗口。
 * 零第三方依赖 —— 只用 Node 内置 fetch + WebSocket（Node >= 22）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const p of BROWSER_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

class CdpBridge {
  constructor(opts) {
    this.port = opts.cdpPort || 9222;
    this.url = opts.cdpUrl || 'https://chat.deepseek.com';
    this.profileDir = opts.profileDir;
    this.pageAgentPath = opts.pageAgentPath;
    this.emit = opts.emit || (() => {});
    this.ws = null;
    this.msgId = 0;
    this.cbs = new Map();
    this.injected = false;
    this.ready = false;   // 页面里真的找到聊天输入框了才算就绪
    this.browserProc = null;
  }

  async _list() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2500) });
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  async _waitDebugger(ms = 25000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const l = await this._list();
      if (l) return l;
      await sleep(400);
    }
    return null;
  }

  async _launch() {
    const exe = findBrowser();
    if (!exe) throw new Error('没找到 Chrome / Edge，请先安装其中之一，或改用油猴桥接');
    fs.mkdirSync(this.profileDir, { recursive: true });
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience,EdgeSidebar',
      '--window-size=1280,900',
      this.url,
    ];
    this.emit('sys', `启动浏览器：${path.basename(exe)}（独立配置目录，需要登录一次，之后会记住）`);
    this.browserProc = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    this.browserProc.unref();
    return this._waitDebugger();
  }

  async connect() {
    if (this.ws && this.ws.readyState === 1) return;
    let list = await this._list();
    if (!list) list = await this._launch();
    if (!list) throw new Error('浏览器调试端口没起来（端口 ' + this.port + ' 被占用？）');

    let page = list.find((t) => t.type === 'page' && /deepseek|chatgpt|kimi|moonshot|doubao/i.test(t.url || ''));
    if (!page) page = list.find((t) => t.type === 'page' && !/devtools|edge:\/\/|chrome:\/\//i.test(t.url || ''));
    if (!page) throw new Error('浏览器里没有可用标签页');

    await this._openWs(page.webSocketDebuggerUrl);
    await this.send('Page.enable', {});
    await this.send('Runtime.enable', {});

    const cur = await this.evaluate('location.href').catch(() => '');
    if (!cur || !/deepseek|chatgpt|kimi|moonshot|doubao/i.test(cur)) {
      await this.send('Page.navigate', { url: this.url });
      await sleep(3000);
    }
    await this._inject();
    const st = await this.evaluate('window.__AIAgent ? window.__AIAgent.status() : null');
    this.ready = !!(st && st.hasComposer);
    if (!st || !st.hasComposer) {
      this.emit('warn', '浏览器已连上，但没找到聊天输入框 —— 请在那个窗口里登录/打开对话页，然后点「重新检查」');
    } else {
      this.emit('sys', `已接管浏览器窗口（${st.host}，识别为 ${st.profile} 页面）`);
    }
  }

  /** 重新看一眼页面当前状态；脚本丢了就重新注入 */
  async probe() {
    let st = null;
    try { st = await this.evaluate('window.__AIAgent ? window.__AIAgent.status() : null'); } catch (e) {}
    if (!st) {
      try { await this._inject(); } catch (e) {}
      try { st = await this.evaluate('window.__AIAgent ? window.__AIAgent.status() : null'); } catch (e) {}
    }
    this.ready = !!(st && st.hasComposer);
    return st;
  }

  /** 把浏览器窗口提到最前面，让用户看得见 */
  async focus() {
    try { await this.send('Page.bringToFront', {}); } catch (e) {}
  }

  /** 页面体检：排查「找不到输入框 / 发不出去」到底卡在哪一步 */
  async inspect() {
    await this.connect();
    await this.focus();
    const script = [
      '(() => {',
      '  const A = window.__AIAgent;',
      '  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 60 && r.height > 8; };',
      '  const qa = (s) => { try { return Array.from(document.querySelectorAll(s)); } catch (e) { return []; } };',
      '  const body = (document.body && document.body.innerText) || "";',
      '  const comp = A ? A.findComposer() : null;',
      '  const desc = (el) => ({',
      '    tag: el.tagName,',
      '    cls: String(el.className || "").slice(0, 60),',
      '    aria: el.getAttribute("aria-label") || "",',
      '    title: el.getAttribute("title") || "",',
      '    txt: (el.innerText || "").replace(/\\s+/g, " ").slice(0, 18),',
      '    svg: !!el.querySelector("svg"),',
      '    off: !!el.disabled || el.getAttribute("aria-disabled") === "true"',
      '  });',
      '  return {',
      '    href: location.href,',
      '    title: document.title,',
      '    agentAlive: !!A,',
      '    profile: A ? A.profile().id : null,',
      '    textareas: qa("textarea").filter(vis).length,',
      '    contenteditables: qa(\'[contenteditable="true"]\').filter(vis).length,',
      '    bodyLen: body.length,',
      '    composer: comp ? Object.assign(desc(comp), {',
      '      valueLen: A.getInputText(comp).length,',
      '      valueHead: A.getInputText(comp).slice(0, 30)',
      '    }) : null,',
      '    sendBtnFound: !!(A && A.findSendButton()),',
      '    clickables: qa(\'button, div[role="button"], [class*="send"]\').filter(vis).slice(-10).map(desc)',
      '  };',
      '})()',
    ].join('\n');
    return this.evaluate(script);
  }

  _openWs(wsUrl) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === 'undefined') {
        return reject(new Error('当前 Node 版本不支持内置 WebSocket（需要 Node 22+）'));
      }
      const ws = new WebSocket(wsUrl);
      const t = setTimeout(() => reject(new Error('连接浏览器调试端口超时')), 12000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        this.ws = ws;
        resolve();
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(t);
        reject(new Error('WebSocket 连接失败：' + (e.message || '未知')));
      });
      ws.addEventListener('close', () => {
        this.ws = null;
        this.injected = false;
      });
      ws.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
        if (m.id && this.cbs.has(m.id)) {
          const cb = this.cbs.get(m.id);
          this.cbs.delete(m.id);
          if (m.error) cb.reject(new Error(m.error.message || 'CDP 错误'));
          else cb.resolve(m.result);
        }
      });
    });
  }

  send(method, params) {
    if (!this.ws) return Promise.reject(new Error('浏览器未连接'));
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.cbs.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.cbs.has(id)) {
          this.cbs.delete(id);
          reject(new Error('CDP 调用超时：' + method));
        }
      }, 30000);
      const wrap = this.cbs.get(id);
      this.cbs.set(id, {
        resolve: (v) => { clearTimeout(t); wrap.resolve(v); },
        reject: (e) => { clearTimeout(t); wrap.reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text || '页面脚本报错');
    }
    return r.result ? r.result.value : undefined;
  }

  async _inject() {
    const src = fs.readFileSync(this.pageAgentPath, 'utf8');
    await this.evaluate(src + '\n;true');
    this.injected = true;
  }

  async sendAndWait(text, opts = {}) {
    await this.connect();
    if (!this.injected) await this._inject();

    await this.focus();
    const before = await this.evaluate('window.__AIAgent.snapshot()');

    // 1) 聚焦后用 CDP 发真实文本事件。
    //    React / Vue 这类受控组件只认真实 input 事件，直接改 value 它不认，
    //    结果就是「字在框里但发送按钮还是灰的、回车也没反应」。
    const focused = await this.evaluate('window.__AIAgent.focusComposer()');
    if (focused) {
      await this.send('Input.insertText', { text });
    } else {
      await this.evaluate(`window.__AIAgent.setInput(${JSON.stringify(text)})`);
    }

    await sleep(250);
    let val = '';
    try {
      val = await this.evaluate('window.__AIAgent.getInputText(window.__AIAgent.findComposer())');
    } catch (e) {}
    if (!val || !val.trim()) {
      const r = await this.evaluate(`window.__AIAgent.setInput(${JSON.stringify(text)})`);
      if (!r || !r.ok) throw new Error((r && r.error) || '写不进输入框');
    }

    // 2) 真实回车键
    const key = (type) => this.send('Input.dispatchKeyEvent', {
      type,
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
    });
    await key('rawKeyDown');
    await key('keyUp');
    await sleep(500);

    let cleared = false;
    try { cleared = !(await this.evaluate('window.__AIAgent.hasText()')); } catch (e) { cleared = true; }

    // 3) 回车没发出去 → 点发送按钮
    if (!cleared) {
      const clicked = await this.evaluate(
        '(() => { const b = window.__AIAgent.findSendButton(); if (!b) return false; b.click(); return true; })()'
      );
      await sleep(700);
      try { cleared = !(await this.evaluate('window.__AIAgent.hasText()')); } catch (e) { cleared = true; }
      if (!cleared) {
        throw new Error(clicked
          ? '消息没发出去（回车和点发送按钮都没反应）—— 页面结构可能变了'
          : '消息没发出去，而且找不到发送按钮 —— 页面结构可能变了');
      }
    }

    this.emit('sys', '已发送，等待 AI 回复…');

    const stableMs = opts.stableMs || 1600;
    const timeoutMs = opts.timeoutMs || 240000;
    const t0 = Date.now();
    let started = false;
    let last = '';
    let lastChange = Date.now();

    while (Date.now() - t0 < timeoutMs) {
      await sleep(500);
      let s;
      try {
        s = await this.evaluate('window.__AIAgent.snapshot()');
      } catch (e) {
        continue;
      }
      if (!s) continue;
      const grew = s.count > before.count || (s.text && s.text !== before.text);
      if (!started) {
        if (grew) { started = true; last = s.text; lastChange = Date.now(); }
        continue;
      }
      if (s.text !== last) { last = s.text; lastChange = Date.now(); }
      else if (last && Date.now() - lastChange >= stableMs && Date.now() - t0 > 900) {
        return last;
      }
    }
    if (started && last) return last;
    throw new Error('等待 AI 回复超时');
  }
}

module.exports = { CdpBridge, findBrowser };
