'use strict';

const TOKEN = window.__TOKEN__ || '';
const $ = (id) => document.getElementById(id);

const stream = $('stream');
const emptyBox = $('empty');
let state = {};
let config = {};
let lastLogId = 0;

/* ---------------------------- 请求 ---------------------------- */
async function api(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------------------- 日志渲染 ---------------------------- */
const KIND_META = {
  user: { cls: 'user', who: '我的需求' },
  ai: { cls: 'ai', who: '网页 AI' },
  sys: { cls: 'sys', who: '' },
  warn: { cls: 'warn', who: '提示' },
  err: { cls: 'err', who: '错误' },
  done: { cls: 'done', who: '完成' },
  ask: { cls: 'ask', who: 'AI 提问' },
  prompt: { cls: 'prompt', who: '复制给网页 AI' },
};

function renderLog(item) {
  if (item.id <= lastLogId) return;
  lastLogId = item.id;
  if (emptyBox && emptyBox.parentNode) emptyBox.remove();

  const el = document.createElement('div');
  const m = KIND_META[item.kind];

  if (item.kind === 'cmd') {
    const risk = (item.meta && item.meta.risk) || { level: 'confirm', why: [] };
    const lv = { safe: '只读', confirm: '写操作', danger: '高危' }[risk.level] || '写操作';
    el.className = 'msg cmd';
    el.innerHTML =
      '<div class="msg-head">' +
      '<span class="who">执行命令' + (item.meta && item.meta.total > 1 ? ` ${item.meta.index}/${item.meta.total}` : '') + '</span>' +
      `<span class="tag ${risk.level}">${lv}</span>` +
      '<span class="copy">复制</span>' +
      '</div><pre>' + esc(item.text) + '</pre>';
    el.querySelector('.copy').onclick = () => copy(item.text, el.querySelector('.copy'));
    stream.appendChild(el);
    return;
  }

  if (item.kind === 'out') {
    const mt = item.meta || {};
    const ok = mt.exitCode === 0;
    el.className = 'msg out';
    el.innerHTML =
      '<div class="msg-head">' +
      `<span class="who">输出</span>` +
      `<span class="tag">${mt.exitCode == null ? '—' : 'exit ' + mt.exitCode}</span>` +
      (mt.durationMs != null ? `<span class="muted">${(mt.durationMs / 1000).toFixed(1)}s</span>` : '') +
      (mt.timedOut ? '<span class="tag danger">超时</span>' : '') +
      '<span class="copy">复制</span>' +
      '</div><pre class="' + (ok ? '' : 'exit-bad') + '">' + esc(item.text) + '</pre>';
    el.querySelector('.copy').onclick = () => copy(item.text, el.querySelector('.copy'));
    stream.appendChild(el);
    return;
  }

  if (item.kind === 'prompt') {
    el.className = 'msg prompt';
    el.innerHTML =
      '<div class="msg-head"><span class="who">复制给网页 AI</span><span class="copy">复制</span></div>' +
      '<div class="msg-body">' + esc(item.text) + '</div>';
    el.querySelector('.copy').onclick = () => copy(item.text, el.querySelector('.copy'));
    stream.appendChild(el);
    return;
  }

  el.className = 'msg ' + (m ? m.cls : 'sys');
  if (item.kind === 'sys') {
    el.textContent = item.text;
  } else {
    el.innerHTML =
      (m && m.who ? `<div class="msg-head"><span class="who">${esc(m.who)}</span></div>` : '') +
      '<div class="msg-body">' + esc(item.text) + '</div>';
  }
  stream.appendChild(el);
}

function copy(text, node) {
  try {
    navigator.clipboard.writeText(text);
    if (node) {
      const old = node.textContent;
      node.textContent = '已复制';
      setTimeout(() => { node.textContent = old; }, 1200);
    }
  } catch (e) {}
}

function scrollBottom() {
  stream.scrollTop = stream.scrollHeight;
}

/* ---------------------------- 状态渲染 ---------------------------- */
function renderState(s) {
  if (!s) return;
  state = s;

  const pill = $('statusPill');
  const txt = $('statusText');
  pill.className = 'pill status-pill';
  const map = {
    idle: ['', '空闲'],
    running: ['busy', s.statusText || '运行中'],
    waiting_approval: ['warn', '等待确认'],
    waiting_user: ['warn', s.statusText || '等待你回复'],
    done: ['ok', '任务完成'],
    stopped: ['', '已停止'],
    error: ['bad', s.statusText || '出错'],
  };
  const mm = map[s.status] || ['', s.statusText || s.status];
  if (mm[0]) pill.classList.add(mm[0]);
  txt.textContent = mm[1];

  $('roundInfo').textContent = s.round ? `第 ${s.round} 轮` : '';

  const bp = $('bridgePill');
  const bt = $('bridgeText');
  bp.className = 'pill';
  const modeName = { userscript: '油猴', cdp: '浏览器接管', manual: '手动' }[s.bridgeMode] || s.bridgeMode;
  if (s.bridgeMode === 'manual') {
    bt.textContent = '手动模式';
  } else if (s.bridgeConnected) {
    bp.classList.add('ok');
    bt.textContent = modeName + ' 已连接' + (s.bridgeHost ? ' · ' + s.bridgeHost : '');
  } else {
    bp.classList.add('bad');
    bt.textContent = modeName + (s.bridgeLastSeen ? ' 已断开' : ' 未连接');
    bp.title = s.bridgeLastSeen
      ? '上次心跳：' + new Date(s.bridgeLastSeen).toLocaleTimeString()
      : '浏览器里的桥接脚本从来没连上过';
  }

  // 待确认命令
  const pc = $('pendingCard');
  if (s.pending) {
    pc.classList.remove('hidden');
    $('pendingCode').textContent = s.pending.code;
    const lv = s.pending.risk.level;
    $('pendingLevel').textContent = { safe: '只读', confirm: '写操作', danger: '高危操作' }[lv] || '写操作';
    $('pendingLevel').className = 'tag ' + lv;
    $('pendingWhy').textContent = (s.pending.risk.why || []).join('；');
  } else {
    pc.classList.add('hidden');
  }

  // 提问 / 手动粘贴
  const ac = $('askCard');
  if (s.question) {
    ac.classList.remove('hidden');
    const isManual = s.question.kind === 'manual';
    ac.querySelector('.card-label').textContent = isManual ? '粘贴网页 AI 的回复' : 'AI 在问你';
    $('askText').textContent = isManual ? s.question.text : s.question.text;
    $('answerBox').placeholder = isManual ? '把 DeepSeek 的整段回复粘贴到这里…' : '回答它…';
    $('answerBtn').textContent = isManual ? '提交给 AI' : '回复';
  } else {
    ac.classList.add('hidden');
  }

  const running = !!s.running;
  $('startBtn').disabled = running;
  $('stopBtn').disabled = !running;
}

/* ---------------------------- 设置 ---------------------------- */
function renderConfig(c) {
  if (!c) return;
  config = c;
  $('bridgeMode').value = c.bridgeMode;
  $('autoSafe').checked = !!c.autoSafe;
  $('maxRounds').value = c.maxRounds;
  $('execTimeout').value = Math.round((c.execTimeoutMs || 120000) / 1000);
  $('cdpUrl').value = c.cdpUrl || '';
  renderSteps(c.bridgeMode);
}

function renderSteps(mode) {
  const el = $('steps');
  if (mode === 'cdp') {
    el.innerHTML =
      '<li>点右边「重连浏览器」，软件会自己开一个浏览器窗口</li>' +
      '<li>在那个窗口里登录 <a href="https://chat.deepseek.com" target="_blank" rel="noreferrer">chat.deepseek.com</a>（只需一次）</li>' +
      '<li>登录后回到这里，再点一次「重连浏览器」</li>' +
      '<li>顶栏显示「浏览器接管 已连接」就能用了</li>';
  } else if (mode === 'manual') {
    el.innerHTML =
      '<li>点「开始」后，软件会把要发的内容显示在左边</li>' +
      '<li>你手动复制粘贴给网页 AI</li>' +
      '<li>再把 AI 的回复粘贴到右下角输入框</li>' +
      '<li>适合临时用一次、不想装插件</li>';
  } else {
    el.innerHTML =
      '<li>装一个 Tampermonkey（油猴）浏览器扩展</li>' +
      '<li><a href="/bridge.user.js" target="_blank">点这里安装桥接脚本</a></li>' +
      '<li>打开 <a href="https://chat.deepseek.com" target="_blank" rel="noreferrer">chat.deepseek.com</a> 并登录</li>' +
      '<li>页面右下角出现「AI 代理：已连接」就能用了</li>';
  }
}

/* ---------------------------- 后端存活检测 ---------------------------- */
let backendUp = true;
let quitting = false;

function showOffline(msg) {
  backendUp = false;
  if (msg) $('offlineMsg').textContent = msg;
  $('offline').classList.remove('hidden');
}
function hideOffline() {
  backendUp = true;
  $('offline').classList.add('hidden');
}

async function heartbeat() {
  if (quitting) return;
  try {
    const r = await fetch('/api/state', {
      headers: { 'X-Agent-Token': TOKEN },
      cache: 'no-store',
    });
    if (!r.ok) throw new Error('bad');
    if (!backendUp) location.reload();
  } catch (e) {
    if (backendUp) showOffline();
  }
}

$('retryBtn').onclick = () => location.reload();
$('closeWinBtn').onclick = () => {
  try { window.close(); } catch (e) {}
  setTimeout(() => showOffline('浏览器不允许网页自己关窗口，请手动点右上角的 ×。'), 300);
};

/* ---------------------------- 事件绑定 ---------------------------- */
$('startBtn').onclick = async () => {
  const goal = $('goal').value.trim();
  if (!goal) { $('goal').focus(); return; }

  // 开跑前提醒：通道没通的话会立刻失败，先说清楚
  if (state.bridgeMode === 'userscript' && !state.bridgeConnected) {
    const ok = confirm(
      '油猴桥接脚本还没连上，现在开始会立刻失败。\n\n' +
      '先做这几步：\n' +
      '1. 浏览器装 Tampermonkey\n' +
      '2. 右侧「接入步骤」里点安装桥接脚本\n' +
      '3. 打开 chat.deepseek.com 登录，页面右下角出现「AI 代理：已连接」\n\n' +
      '仍然要试一下吗？'
    );
    if (!ok) return;
  }
  if (state.bridgeMode === 'cdp' && !state.bridgeConnected) {
    const ok = confirm('浏览器还没接管上。先点「重连浏览器」并在弹出的窗口里登录 DeepSeek。\n\n仍然要试一下吗？');
    if (!ok) return;
  }

  try {
    await api('POST', '/api/task', { goal });
  } catch (e) {
    alert(e.message);
  }
};

$('stopBtn').onclick = () => api('POST', '/api/stop').catch(() => {});

$('quitBtn').onclick = async () => {
  if (state.running && !confirm('任务还在跑，确定要退出吗？')) return;
  if (!state.running && !confirm('关闭「AI 电脑代理」？')) return;
  quitting = true;
  $('quitBtn').textContent = '正在关闭…';
  try { await api('POST', '/api/quit'); } catch (e) {}
  document.body.innerHTML =
    '<div style="height:100vh;display:grid;place-items:center;color:#5b6270;font-size:14px">' +
    '软件已关闭，这个窗口可以关掉了。</div>';
  // 应用窗口通常能自己关掉；不行的话上面那句话就是提示
  setTimeout(() => { try { window.close(); } catch (e) {} }, 700);
};

$('allowBtn').onclick = async () => {
  if (!state.pending) return;
  await api('POST', '/api/decision', { id: state.pending.id, allow: true }).catch((e) => alert(e.message));
};
$('denyBtn').onclick = async () => {
  if (!state.pending) return;
  await api('POST', '/api/decision', { id: state.pending.id, allow: false }).catch((e) => alert(e.message));
};

$('answerBtn').onclick = async () => {
  if (!state.question) return;
  const text = $('answerBox').value;
  if (!text.trim()) { $('answerBox').focus(); return; }
  await api('POST', '/api/reply', { id: state.question.id, text }).catch((e) => alert(e.message));
  $('answerBox').value = '';
};

$('answerBox').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('answerBtn').click();
});

$('saveBtn').onclick = async () => {
  try {
    const r = await api('POST', '/api/settings', {
      bridgeMode: $('bridgeMode').value,
      autoSafe: $('autoSafe').checked,
      maxRounds: +$('maxRounds').value,
      execTimeoutMs: +$('execTimeout').value * 1000,
      cdpUrl: $('cdpUrl').value,
    });
    renderConfig(r.config);
    $('saveBtn').textContent = '已保存';
    setTimeout(() => { $('saveBtn').textContent = '保存设置'; }, 1200);
  } catch (e) {
    alert(e.message);
  }
};

$('reconnectBtn').onclick = async () => {
  $('reconnectBtn').textContent = '连接中…';
  try {
    await api('POST', '/api/bridge/reconnect');
  } catch (e) {
    alert(e.message);
  }
  $('reconnectBtn').textContent = '重连浏览器';
};

$('autoBtn').onclick = async () => {
  const btn = $('autoBtn');
  const note = $('autoNote');
  btn.disabled = true;
  btn.textContent = '正在接管…（会弹一个浏览器窗口）';
  note.textContent = '第一次会打开一个新窗口，需要你在里面登录 DeepSeek。';
  try {
    const r = await api('POST', '/api/auto-bridge');
    if (r.ready) {
      btn.textContent = '已接管 ✓ 可以用了';
      note.textContent = '已识别聊天输入框（' + (r.status && r.status.host) + '）。现在写需求点「开始」就行。';
    } else {
      btn.textContent = '重新检查';
      const st = r.status;
      if (r.reason === 'login') {
        note.textContent = '浏览器停在 DeepSeek 登录页 —— 在那个窗口用手机号收验证码（或密码）登录，登录好点「重新检查」。';
      } else if (st) {
        note.textContent = '窗口已打开（' + st.host + '），但没找到聊天输入框。请在那个窗口打开 DeepSeek 对话页，然后点「重新检查」。';
      } else {
        note.textContent = '窗口已打开，但页面脚本没跑起来。请在那个窗口打开 chat.deepseek.com，然后点「重新检查」。';
      }
    }
  } catch (e) {
    btn.textContent = '重新检查';
    note.textContent = '接管失败：' + e.message;
  }
  btn.disabled = false;
};

$('setChev').onclick = () => {
  const body = $('settingsBody');
  const hidden = body.classList.toggle('hidden');
  $('setChev').textContent = hidden ? '展开' : '收起';
};

$('sysInfoBtn').onclick = async (e) => {
  e.preventDefault();
  $('modal').classList.remove('hidden');
  $('modalBody').textContent = '读取中…';
  try {
    const r = await api('GET', '/api/sysinfo');
    $('modalBody').textContent = r.text || '（没读到）';
  } catch (err) {
    $('modalBody').textContent = '读取失败：' + err.message;
  }
};
$('modalClose').onclick = () => $('modal').classList.add('hidden');
$('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').classList.add('hidden'); };

/* ---------------------------- 启动 ---------------------------- */
(async function init() {
  try {
    const r = await api('GET', '/api/state');
    renderConfig(r.config);
    renderState(r.state);
    if (r.logs && r.logs.length) {
      r.logs.forEach(renderLog);
    }
    scrollBottom();
  } catch (e) {
    console.error(e);
  }

  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.t === 'init') {
      renderConfig(d.config);
      renderState(d.state);
      if (d.logs && d.logs.length) { d.logs.forEach(renderLog); scrollBottom(); }
    } else if (d.t === 'log') {
      renderLog(d.item);
      scrollBottom();
    } else if (d.t === 'state') {
      renderState(d.state);
    } else if (d.t === 'reset') {
      lastLogId = 0;
      stream.innerHTML = '';
    }
  };
  es.onerror = () => {};
})();

setInterval(heartbeat, 3000);
