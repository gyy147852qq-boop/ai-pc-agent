'use strict';
/**
 * AI 电脑代理 · 本地服务
 *  - 面板 UI（默认用 Edge/Chrome 的 app 窗口打开，像个桌面软件）
 *  - 网页桥接（油猴脚本 / CDP / 手动）
 *  - 代理主循环调度
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const { runTask } = require('./lib/agent');
const { classify } = require('./lib/exec');
const { collect: collectSysinfo } = require('./lib/sysinfo');
const { Outbox } = require('./lib/outbox');
const { CdpBridge, findBrowser } = require('./lib/cdp');

const APP_DIR = __dirname;
const DATA_DIR = path.join(APP_DIR, 'data');
const PUB_DIR = path.join(APP_DIR, 'public');
const CFG_PATH = path.join(DATA_DIR, 'config.json');
const PAGE_AGENT_PATH = path.join(APP_DIR, 'lib', 'page-agent.src.js');
const USCRIPT_TPL = path.join(APP_DIR, 'lib', 'userscript.tpl.js');

fs.mkdirSync(DATA_DIR, { recursive: true });

/* 日志同时写一份到 data/server.log，方便无窗口启动时排查 */
const LOG_PATH = path.join(DATA_DIR, 'server.log');
try {
  const st = fs.statSync(LOG_PATH);
  if (st.size > 2 * 1024 * 1024) fs.writeFileSync(LOG_PATH, '');
} catch (e) {}
let logStream = null;
try { logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' }); } catch (e) {}
const rawLog = console.log.bind(console);
console.log = function (...args) {
  rawLog(...args);
  if (!logStream) return;
  try {
    logStream.write(new Date().toISOString().replace('T', ' ').slice(0, 19) + '  ' + args.join(' ') + '\n');
  } catch (e) {}
};

/* ------------------------------ 配置 ------------------------------ */
const DEFAULTS = {
  port: 8787,
  token: '',
  bridgeMode: 'cdp',           // cdp | userscript | manual（cdp 是实测在 DeepSeek 上可用的那条路）
  autoSafe: true,             // 只读命令自动跑
  maxRounds: 25,
  execTimeoutMs: 120000,
  replyTimeoutMs: 240000,
  cdpPort: 9222,
  cdpUrl: 'https://chat.deepseek.com',
  openUi: true,
};

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); } catch (e) {}
  cfg = Object.assign({}, DEFAULTS, cfg);
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(12).toString('hex');
    saveConfig(cfg);
  }
  return cfg;
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2), 'utf8'); } catch (e) {}
}

let CFG = loadConfig();

/* ------------------------------ 状态 ------------------------------ */
const S = {
  status: 'idle',
  statusText: '空闲',
  goal: '',
  round: 0,
  startedAt: 0,
  logs: [],
  pending: null,
  question: null,
  sysinfo: '',
  sysinfoData: null,
};

let logId = 0;
let cmdSeq = 0;
let userSeq = 0;
let approvalWaiter = null;
let userWaiter = null;
let currentAbort = null;
let running = false;

const outbox = new Outbox();
const sseClients = new Set();

function broadcast(obj) {
  const data = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of sseClients) {
    try { res.write(data); } catch (e) { sseClients.delete(res); }
  }
}

function emit(kind, text, meta) {
  const item = { id: ++logId, ts: Date.now(), kind, text: String(text == null ? '' : text), meta: meta || null };
  S.logs.push(item);
  if (S.logs.length > 1000) S.logs = S.logs.slice(-1000);
  broadcast({ t: 'log', item });
  return item;
}

function setStatus(status, text) {
  S.status = status;
  S.statusText = text || status;
  broadcast({ t: 'state', state: publicState() });
}

function publicState() {
  return {
    status: S.status,
    statusText: S.statusText,
    goal: S.goal,
    round: S.round,
    pending: S.pending,
    question: S.question,
    bridgeMode: CFG.bridgeMode,
    bridgeConnected: CFG.bridgeMode === 'userscript' ? outbox.connected : CFG.bridgeMode === 'cdp' ? !!(cdpBridge && cdpBridge.ready) : true,
    bridgeHost: outbox.lastHost,
    bridgeLastSeen: outbox.lastSeen,
    running,
  };
}

function waitForApproval(req) {
  return new Promise((resolve) => {
    const id = 'c' + ++cmdSeq;
    S.pending = { id, code: req.code, shell: req.shell, risk: req.risk, ts: Date.now() };
    setStatus('waiting_approval', '等待你确认命令');
    approvalWaiter = { id, resolve };
  });
}

function waitForUser(payload) {
  return new Promise((resolve) => {
    const id = 'u' + ++userSeq;
    S.question = Object.assign({ id, ts: Date.now() }, payload);
    setStatus('waiting_user', payload.kind === 'manual' ? '手动模式：等 AI 的回复' : 'AI 在问你问题');
    userWaiter = { id, resolve };
  });
}

/* ------------------------------ 桥接 ------------------------------ */
const cdpBridge = new CdpBridge({
  cdpPort: CFG.cdpPort,
  cdpUrl: CFG.cdpUrl,
  profileDir: path.join(DATA_DIR, 'browser-profile'),
  pageAgentPath: PAGE_AGENT_PATH,
  emit: (kind, text) => emit(kind, text),
});

function makeBridge() {
  if (CFG.bridgeMode === 'cdp') {
    return {
      name: 'cdp',
      send: (text, o) => cdpBridge.sendAndWait(text, { timeoutMs: (o && o.timeoutMs) || CFG.replyTimeoutMs }),
    };
  }
  if (CFG.bridgeMode === 'manual') {
    return {
      name: 'manual',
      send: async (text) => {
        emit('prompt', text);
        emit('sys', '手动模式：复制上面这段发给网页 AI，再把它的回复粘贴到右下角输入框');
        const ans = await waitForUser({ kind: 'manual', text: '把网页 AI 的回复粘贴到这里' });
        return ans;
      },
    };
  }
  return {
    name: 'userscript',
    send: (text, o) => outbox.send(text, (o && o.timeoutMs) || CFG.replyTimeoutMs),
  };
}

/* ------------------------------ 主流程 ------------------------------ */
async function startTask(goal) {
  if (running) throw new Error('已有任务在跑，先停止再开始');
  running = true;
  S.goal = goal;
  S.round = 0;
  S.logs = [];
  S.pending = null;
  S.question = null;
  S.startedAt = Date.now();
  currentAbort = { aborted: false };
  outbox.clearStale();
  broadcast({ t: 'reset' });
  setStatus('running', '启动中');

  emit('user', goal);

  try {
    const bridge = makeBridge();

    // 开跑前先确认通道通不通，别让用户干等 4 分钟
    if (bridge.name === 'userscript' && !outbox.connected) {
      emit('err', '油猴桥接脚本没连上，任务已中止（没有把需求发出去）。');
      emit('sys', '怎么修：① 浏览器装 Tampermonkey → ② 面板「接入步骤」里点安装桥接脚本 → ③ 打开 chat.deepseek.com 登录，页面右下角出现「AI 代理：已连接」→ ④ 回来再点开始。');
      emit('sys', '不想装扩展的话，把「桥接方式」改成「浏览器接管」，点「重连浏览器」，在弹出来的窗口里登录一次 DeepSeek。');
      setStatus('error', '桥接未连接');
      return;
    }

    emit('sys', '正在读取本机状态…');
    const info = await collectSysinfo();
    S.sysinfo = info.text;
    S.sysinfoData = info.data;
    emit('sys', '本机状态已获取（' + (info.data ? 'OK' : '部分失败，继续') + '）');

    if (bridge.name === 'cdp') {
      emit('sys', '正在接管浏览器…');
    }

    const r = await runTask({
      goal,
      sysinfoText: S.sysinfo,
      bridge,
      opts: {
        maxRounds: CFG.maxRounds,
        execTimeoutMs: CFG.execTimeoutMs,
        replyTimeoutMs: CFG.replyTimeoutMs,
        autoSafe: CFG.autoSafe,
      },
      emit,
      ask: (text) => waitForUser({ kind: 'ask', text }),
      approve: waitForApproval,
      signal: currentAbort,
    });

    setStatus(r.ok ? 'done' : 'idle', r.ok ? '任务完成' : '已停止');
    if (r.ok) emit('sys', `任务完成，共 ${r.rounds} 轮。`);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/已手动停止|已中止/.test(msg)) {
      emit('warn', '已停止');
      setStatus('stopped', '已停止');
    } else {
      emit('err', msg);
      setStatus('error', '出错：' + msg.slice(0, 60));
    }
  } finally {
    running = false;
    S.pending = null;
    S.question = null;
    approvalWaiter = null;
    userWaiter = null;
    currentAbort = null;
    broadcast({ t: 'state', state: publicState() });
  }
}

function stopTask() {
  if (!running) return;
  if (currentAbort) currentAbort.aborted = true;
  if (approvalWaiter) { const w = approvalWaiter; approvalWaiter = null; w.resolve({ allow: false }); }
  if (userWaiter) { const w = userWaiter; userWaiter = null; w.resolve('（用户中止）'); }
  S.pending = null;
  S.question = null;
  outbox.abortAll('已中止');
  emit('warn', '收到停止指令');
}

/* ------------------------------ HTTP ------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8');
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function tokenOk(req, url) {
  const t = req.headers['x-agent-token'] || url.searchParams.get('token');
  return t && t === CFG.token;
}

function originOk(req) {
  const o = req.headers.origin || req.headers.referer || '';
  if (!o) return true;
  try {
    const u = new URL(o);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch (e) {
    return false;
  }
}

function buildUserscript() {
  let tpl = fs.readFileSync(USCRIPT_TPL, 'utf8');
  const agent = fs.readFileSync(PAGE_AGENT_PATH, 'utf8');
  return tpl
    .replaceAll('@@AGENT_PORT@@', String(CFG.port))
    .replaceAll('@@AGENT_TOKEN@@', CFG.token)
    .replace('/*__PAGE_AGENT__*/', () => agent);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    /* ---------- 静态 ---------- */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      let html = fs.readFileSync(path.join(PUB_DIR, 'index.html'), 'utf8');
      // 注意：占位符必须和 JS 里的属性名区分开，否则 replace 会先命中属性名
      html = html.replaceAll('@@AGENT_TOKEN@@', CFG.token);
      if (html.includes('@@AGENT_TOKEN@@')) throw new Error('token 注入失败');
      return send(res, 200, html, MIME['.html']);
    }
    if (req.method === 'GET' && (p === '/app.js' || p === '/style.css')) {
      const f = path.join(PUB_DIR, p.slice(1));
      if (!fs.existsSync(f)) return send(res, 404, 'not found');
      return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'text/plain');
    }
    if (req.method === 'GET' && p === '/bridge.user.js') {
      return send(res, 200, buildUserscript(), 'text/javascript; charset=utf-8');
    }

    /* ---------- SSE ---------- */
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify({ t: 'init', state: publicState(), logs: S.logs, config: publicConfig() }) + '\n\n');
      sseClients.add(res);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 20000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
      return;
    }

    /* ---------- 网页桥接（只认 token） ---------- */
    if (p.startsWith('/api/bridge/')) {
      if (!tokenOk(req, url)) return sendJson(res, 403, { ok: false, error: 'token 不对' });

      if (p === '/api/bridge/poll' && req.method === 'GET') {
        const r = await outbox.poll(url.searchParams.get('since'), url.searchParams.get('host') || '');
        if (r.init) broadcast({ t: 'state', state: publicState() });
        return sendJson(res, 200, r);
      }
      if (p === '/api/bridge/reply' && req.method === 'POST') {
        const b = await readBody(req);
        const ok = outbox.reply(b.id, { text: b.text, error: b.error });
        broadcast({ t: 'state', state: publicState() });
        return sendJson(res, 200, { ok });
      }
      if (p === '/api/bridge/status' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, connected: outbox.connected, host: outbox.lastHost, waiting: outbox.waitingCount });
      }
      return sendJson(res, 404, { ok: false, error: 'unknown bridge api' });
    }

    /* ---------- 面板 API（token + 同源） ---------- */
    if (!tokenOk(req, url)) return sendJson(res, 403, { ok: false, error: 'token 不对，请刷新面板' });
    if (req.method !== 'GET' && !originOk(req)) return sendJson(res, 403, { ok: false, error: '来源被拒绝' });

    if (p === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, state: publicState(), logs: S.logs, config: publicConfig() });
    }

    if (p === '/api/task' && req.method === 'POST') {
      const b = await readBody(req);
      const goal = String(b.goal || '').trim();
      if (!goal) return sendJson(res, 400, { ok: false, error: '需求不能为空' });
      if (running) return sendJson(res, 409, { ok: false, error: '已有任务在跑' });
      startTask(goal);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/stop' && req.method === 'POST') {
      stopTask();
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/quit' && req.method === 'POST') {
      sendJson(res, 200, { ok: true });
      setTimeout(() => {
        try { stopTask(); } catch (e) {}
        console.log('收到退出指令，软件关闭');
        setTimeout(() => process.exit(0), 300);
      }, 150);
      return;
    }

    if (p === '/api/decision' && req.method === 'POST') {
      const b = await readBody(req);
      if (!S.pending || S.pending.id !== b.id) return sendJson(res, 409, { ok: false, error: '这条命令已经失效' });
      const allow = !!b.allow;
      const w = approvalWaiter;
      approvalWaiter = null;
      S.pending = null;
      setStatus('running', allow ? '执行中' : '你拒绝了，正在告知 AI');
      if (w) w.resolve({ allow });
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/reply' && req.method === 'POST') {
      const b = await readBody(req);
      if (!S.question || S.question.id !== b.id) return sendJson(res, 409, { ok: false, error: '提问已失效' });
      const text = String(b.text || '');
      const w = userWaiter;
      userWaiter = null;
      S.question = null;
      setStatus('running', '已收到你的回答');
      if (w) w.resolve(text);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const next = Object.assign({}, CFG);
      if (typeof b.bridgeMode === 'string' && ['userscript', 'cdp', 'manual'].includes(b.bridgeMode)) next.bridgeMode = b.bridgeMode;
      if (typeof b.autoSafe === 'boolean') next.autoSafe = b.autoSafe;
      if (Number.isFinite(+b.maxRounds)) next.maxRounds = Math.max(1, Math.min(80, +b.maxRounds));
      if (Number.isFinite(+b.execTimeoutMs)) next.execTimeoutMs = Math.max(5000, Math.min(900000, +b.execTimeoutMs));
      if (typeof b.cdpUrl === 'string' && b.cdpUrl.trim()) next.cdpUrl = b.cdpUrl.trim();
      next.token = CFG.token;
      next.port = CFG.port;
      CFG = next;
      saveConfig(CFG);
      cdpBridge.url = CFG.cdpUrl;
      emit('sys', '设置已保存');
      broadcast({ t: 'state', state: publicState() });
      return sendJson(res, 200, { ok: true, config: publicConfig() });
    }

    if (p === '/api/inspect' && req.method === 'GET') {
      try {
        const info = await cdpBridge.inspect();
        return sendJson(res, 200, { ok: true, info });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    if (p === '/api/auto-bridge' && req.method === 'POST') {
      // 一键接入：切到浏览器接管 + 拉起/接管浏览器 + 探一次页面状态
      CFG.bridgeMode = 'cdp';
      saveConfig(CFG);
      cdpBridge.url = CFG.cdpUrl;
      broadcast({ t: 'state', state: publicState() });
      emit('sys', '正在接管浏览器…（第一次会自动打开一个窗口，需要你在里面登录 DeepSeek）');
      try {
        await cdpBridge.connect();
      } catch (e) {
        emit('err', '接管浏览器失败：' + e.message);
        return sendJson(res, 500, { ok: false, error: e.message });
      }
      const st = await cdpBridge.probe();
      await cdpBridge.focus();
      broadcast({ t: 'state', state: publicState() });
      if (st && st.hasComposer) {
        emit('sys', `接管成功：已识别聊天输入框（${st.host}，页面模板 ${st.profile}），可以开始用了。`);
        return sendJson(res, 200, { ok: true, ready: true, status: st });
      }
      if (st && /sign_in|login|passport/i.test(st.href || '')) {
        emit('warn', '浏览器停在 DeepSeek 登录页 —— 请在刚弹出的那个窗口里用手机号收验证码（或密码）登录，登录好回到面板点「重新检查」。');
        return sendJson(res, 200, { ok: true, ready: false, reason: 'login', status: st });
      }
      emit('warn', '浏览器窗口已经打开了，但没找到聊天输入框 —— 请在那个窗口里打开 chat.deepseek.com 的对话页，然后点「重新检查」。');
      return sendJson(res, 200, { ok: true, ready: false, reason: 'no-composer', status: st || null });
    }

    if (p === '/api/bridge/reconnect' && req.method === 'POST') {
      if (CFG.bridgeMode !== 'cdp') return sendJson(res, 400, { ok: false, error: '当前不是浏览器接管模式' });
      cdpBridge.ws = null;
      cdpBridge.injected = false;
      try {
        await cdpBridge.connect();
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        emit('err', '连接浏览器失败：' + e.message);
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }

    if (p === '/api/sysinfo' && req.method === 'GET') {
      const info = await collectSysinfo();
      S.sysinfo = info.text;
      S.sysinfoData = info.data;
      return sendJson(res, 200, { ok: true, text: info.text, data: info.data });
    }

    if (p === '/api/test-exec' && req.method === 'POST') {
      const b = await readBody(req);
      const code = String(b.code || '');
      const risk = classify(code);
      const { runPowerShell } = require('./lib/exec');
      const r = await runPowerShell(code, { timeoutMs: 30000 });
      return sendJson(res, 200, { ok: true, risk, result: r });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    try { return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch (x) {}
  }
});

function publicConfig() {
  return {
    bridgeMode: CFG.bridgeMode,
    autoSafe: CFG.autoSafe,
    maxRounds: CFG.maxRounds,
    execTimeoutMs: CFG.execTimeoutMs,
    cdpUrl: CFG.cdpUrl,
    port: CFG.port,
  };
}

/* ------------------------------ 启动 ------------------------------ */
function openUi(url) {
  const exe = findBrowser();
  if (!exe) {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  try {
    spawn(
      exe,
      ['--app=' + url, '--window-size=1320,900', '--user-data-dir=' + path.join(DATA_DIR, 'ui-profile'), '--no-first-run'],
      { detached: true, stdio: 'ignore' }
    ).unref();
  } catch (e) {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    const url = `http://127.0.0.1:${CFG.port}/`;
    console.log('\n端口 ' + CFG.port + ' 已被占用 —— 软件可能已经在运行了。');
    console.log('直接打开：' + url + '\n');
    if (CFG.openUi) openUi(url);
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  console.error(e);
});

server.listen(CFG.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${CFG.port}/`;
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║        AI 电脑代理  ·  已启动                ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  面板地址：' + url);
  console.log('  油猴脚本：' + url + 'bridge.user.js');
  console.log('  桥接方式：' + CFG.bridgeMode);
  console.log('');
  console.log('  关软件：点面板右上角「退出」。');
  console.log('  想放到桌面：双击本目录的「创建桌面快捷方式.vbs」，只跑一次。');
  console.log('');
  if (CFG.openUi && !process.argv.includes('--no-open')) openUi(url);

  // 自检：确认面板页面和油猴脚本里的占位符都被正确替换了
  setTimeout(async () => {
    try {
      const html = await (await fetch(url)).text();
      const okHtml = html.includes(CFG.token) && !html.includes('@@AGENT_TOKEN@@');
      const js = await (await fetch(url + 'bridge.user.js')).text();
      const okJs = js.includes(CFG.token) && !js.includes('@@AGENT_TOKEN@@') && !js.includes('/*__PAGE_AGENT__*/');
      if (okHtml && okJs) {
        console.log('  自检通过：面板与桥接脚本的 token 注入正常。');
      } else {
        console.log('  ⚠ 自检失败：token 注入异常（面板 ' + okHtml + '，脚本 ' + okJs + '）');
        console.log('    面板会一直显示「连不上软件后端」，请检查 public/index.html 里的 @@AGENT_TOKEN@@。');
      }
    } catch (e) {
      console.log('  ⚠ 自检未完成：' + e.message);
    }
  }, 400);
});
