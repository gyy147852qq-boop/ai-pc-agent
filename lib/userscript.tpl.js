// ==UserScript==
// @name         AI 电脑代理 · 网页桥接
// @namespace    ai-pc-agent
// @version      1.0.0
// @description  把网页 AI 的回复转发给本地「AI 电脑代理」软件，并把软件发来的指令自动填进聊天框。只连 127.0.0.1，不往外发任何东西。
// @author       local
// @match        https://chat.deepseek.com/*
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://*.kimi.com/*
// @match        https://*.kimi.moonshot.cn/*
// @match        https://*.doubao.com/*
// @match        https://tongyi.aliyun.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const PORT = @@AGENT_PORT@@;
  const TOKEN = '@@AGENT_TOKEN@@';
  const BASE = 'http://127.0.0.1:' + PORT;

  /*__PAGE_AGENT__*/

  const A = window.__AIAgent;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (!A) {
    console.warn('[AI电脑代理] 页面代理未注入');
    return;
  }

  let since = -1;
  let paused = false;
  let busy = false;
  let lastState = 'init';

  /* --------------------------- 网络 --------------------------- */
  function request(method, url, body, timeout) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json', 'X-Agent-Token': TOKEN };
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method,
          url,
          headers,
          data: body ? JSON.stringify(body) : undefined,
          timeout: timeout || 30000,
          onload: (r) => {
            try { resolve(JSON.parse(r.responseText)); }
            catch (e) { reject(new Error('本地软件返回了非 JSON 内容')); }
          },
          onerror: () => reject(new Error('连不上本地软件')),
          ontimeout: () => reject(new Error('请求本地软件超时')),
        });
      } else {
        fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        }).then((r) => r.json()).then(resolve).catch(reject);
      }
    });
  }

  /* --------------------------- 悬浮状态条 --------------------------- */
  const badge = document.createElement('div');
  badge.id = '__ai_pc_agent_badge';
  badge.style.cssText = [
    'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483647',
    'font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
    'background:#111827', 'color:#e5e7eb', 'padding:7px 11px', 'border-radius:999px',
    'box-shadow:0 6px 20px rgba(0,0,0,.28)', 'display:flex', 'align-items:center', 'gap:8px',
    'cursor:default', 'user-select:none', 'opacity:.92', 'max-width:60vw',
  ].join(';');
  const dot = document.createElement('span');
  dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:#6b7280;flex:0 0 auto;display:inline-block';
  const label = document.createElement('span');
  label.textContent = 'AI 代理：连接中…';
  label.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
  const toggle = document.createElement('span');
  toggle.textContent = '暂停';
  toggle.style.cssText = 'cursor:pointer;color:#93c5fd;margin-left:4px;flex:0 0 auto';
  badge.appendChild(dot);
  badge.appendChild(label);
  badge.appendChild(toggle);

  function mountBadge() {
    if (!document.body) return setTimeout(mountBadge, 500);
    if (!document.getElementById('__ai_pc_agent_badge')) document.body.appendChild(badge);
  }
  mountBadge();

  function setBadge(state, text) {
    lastState = state;
    const color = { ok: '#34d399', busy: '#fbbf24', err: '#f87171', idle: '#6b7280' }[state] || '#6b7280';
    dot.style.background = color;
    label.textContent = 'AI 代理：' + text;
  }

  toggle.addEventListener('click', () => {
    paused = !paused;
    toggle.textContent = paused ? '继续' : '暂停';
    setBadge(paused ? 'idle' : 'ok', paused ? '已暂停' : '已连接');
  });

  /* --------------------------- 主循环 --------------------------- */
  async function handle(msg) {
    setBadge('busy', '正在填入指令…');
    const before = A.snapshot();

    const res = await A.sendMessage(msg.text);
    if (!res.ok) {
      setBadge('err', res.error || '发送失败');
      await request('POST', BASE + '/api/bridge/reply', { id: msg.id, error: res.error || '发送失败' }, 15000);
      return;
    }

    setBadge('busy', '等 AI 回复…');
    const r = await A.waitForReply(before, {});
    if (r.ok) {
      setBadge('ok', '已回复（' + Math.round((r.elapsedMs || 0) / 1000) + 's）');
      await request('POST', BASE + '/api/bridge/reply', { id: msg.id, text: r.text }, 20000);
    } else {
      setBadge('err', r.error || '等待回复超时');
      await request('POST', BASE + '/api/bridge/reply', { id: msg.id, error: r.error || '等待回复超时' }, 15000);
    }
  }

  async function tick() {
    if (paused || busy) return;
    if (!A.findComposer()) {
      setBadge('idle', '这个页面没有聊天框');
      return;
    }
    busy = true;
    try {
      const r = await request(
        'GET',
        BASE + '/api/bridge/poll?since=' + since + '&host=' + encodeURIComponent(location.host),
        null,
        26000
      );
      if (!r || !r.ok) throw new Error('本地软件没响应');
      since = r.seq;
      if (lastState !== 'busy') setBadge('ok', '已连接');
      if (r.msg) await handle(r.msg);
    } catch (e) {
      setBadge('err', e.message === '连不上本地软件' ? '本地软件没开' : e.message);
      await sleep(3000);
    } finally {
      busy = false;
    }
  }

  setBadge('idle', '连接中…');
  console.log('[AI电脑代理] 桥接脚本已加载 → ' + BASE + ' / ' + location.host);
  setInterval(tick, 1200);
  tick();
})();
