'use strict';
/**
 * 端到端测试：模拟网页端（扮演油猴脚本），验证 需求 → AI → 执行 → 回传 → 完成 的完整链路。
 * 需要服务已在 127.0.0.1:8787 运行。
 */
const fs = require('fs');
const path = require('path');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
const BASE = `http://127.0.0.1:${CFG.port}`;
const H = { 'X-Agent-Token': CFG.token, 'Content-Type': 'application/json' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
let cursor = -1; // 扮演网页端的接收游标

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + String(extra).slice(0, 300) : '')); }
}

async function j(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function state() {
  const r = await j('GET', '/api/state');
  return r.json;
}

/** 拿下一个待处理消息（跳过 init 握手） */
async function nextMsg(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await j('GET', `/api/bridge/poll?since=${cursor}&host=fake.deepseek.test`);
    const d = r.json || {};
    if (d.ok) {
      if (d.init) { cursor = d.seq; continue; }
      if (d.msg) { cursor = d.seq; return d.msg; }
    }
    await sleep(250);
  }
  return null;
}

async function waitPending(timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(250);
    const st = await state();
    if (st.state.pending) return st.state.pending;
  }
  return null;
}

async function waitQuestion(timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(250);
    const st = await state();
    if (st.state.question) return st.state.question;
  }
  return null;
}

async function main() {
  console.log('\n[E2E] 场景 0：桥接未连接时必须立刻失败（不能干等）');
  const pre = await state();
  if (pre.state.bridgeLastSeen) {
    console.log('  （这个服务已经连过桥接了，跳过本项；要测请先重启服务）');
  } else {
    const t0 = Date.now();
    await j('POST', '/api/task', { goal: '测试：没连桥接就开跑' });
    let st0 = null;
    for (let i = 0; i < 20; i++) {
      await sleep(200);
      const s = await state();
      if (s.state.status === 'error') { st0 = s; break; }
    }
    const cost = Date.now() - t0;
    ok('立刻报错而不是等超时', !!st0 && cost < 6000, '耗时 ' + cost + 'ms');
    ok('错误说明指向桥接', !!st0 && /桥接|脚本/.test(st0.state.statusText + JSON.stringify(st0.logs.map((l) => l.text))), st0 && st0.state.statusText);
    ok('日志给出修复步骤', !!st0 && (st0.logs || []).some((l) => /Tampermonkey|浏览器接管/.test(l.text)));
  }

  console.log('\n[E2E] 建立桥接握手（模拟油猴脚本一直在轮询）');
  const init = await j('GET', `/api/bridge/poll?since=-1&host=fake.deepseek.test`);
  cursor = init.json.seq;
  ok('握手成功', init.json.ok === true && init.json.init === true);

  console.log('\n[E2E] 场景 1：只读命令自动执行 → 完成');
  let s = await state();
  ok('当前没有任务在跑', s.state.running === false, s.state.status);

  let r = await j('POST', '/api/task', { goal: '测试：数一下当前目录有多少个文件，然后告诉我' });
  ok('任务已受理', r.status === 200 && r.json.ok, JSON.stringify(r.json));

  const m1 = await nextMsg();
  ok('收到首轮提示词', !!m1);
  const prompt = m1 ? m1.text : '';
  ok('提示词含需求', prompt.includes('数一下当前目录有多少个文件'));
  ok('提示词含电脑状态', /操作系统：|计算机名：/.test(prompt), prompt.slice(0, 120));
  ok('提示词含协议', prompt.includes('DONE') && prompt.includes('powershell'));

  await j('POST', '/api/bridge/reply', {
    id: m1.id,
    text: '先看看当前目录。\n```powershell\nGet-ChildItem | Measure-Object | Select-Object -ExpandProperty Count\n```',
  });

  const m2 = await nextMsg();
  ok('收到回传的执行结果', !!m2);
  const fb = m2 ? m2.text : '';
  ok('结果里带退出码 0', fb.includes('退出码：0'), fb.slice(0, 300));
  ok('结果里带真实输出', /输出：\s*\n?\s*\d+/.test(fb), fb.slice(0, 400));

  await j('POST', '/api/bridge/reply', { id: m2.id, text: 'DONE' });
  await sleep(800);

  s = await state();
  ok('状态变为完成', s.state.status === 'done', s.state.status);
  const kinds = (s.logs || []).map((l) => l.kind);
  ok('日志里有命令卡', kinds.includes('cmd'));
  ok('日志里有输出卡', kinds.includes('out'));
  ok('日志里有完成卡', kinds.includes('done'));

  console.log('\n[E2E] 场景 2：写操作被拦下 → 我拒绝');
  await j('POST', '/api/task', { goal: '测试：创建一个临时目录' });
  const q1 = await nextMsg();
  ok('收到首轮提示词', !!q1);

  await j('POST', '/api/bridge/reply', {
    id: q1.id,
    text: '【风险】会新建目录。\n```powershell\nNew-Item -ItemType Directory -Path "$env:TEMP\\ai-agent-selftest" -Force | Out-Null\n```',
  });

  const pending = await waitPending();
  ok('写操作被拦下等确认', !!pending);
  ok('标记为写操作', pending && pending.risk.level === 'confirm', pending && pending.risk.level);
  ok('给了解释理由', !!(pending && pending.risk.why.length), pending && JSON.stringify(pending.risk.why));

  if (pending) await j('POST', '/api/decision', { id: pending.id, allow: false });
  const q2 = await nextMsg();
  ok('拒绝后仍继续对话', !!q2);
  ok('AI 被告知被拒绝', q2 && q2.text.includes('拒绝'), q2 && q2.text.slice(0, 300));
  await j('POST', '/api/bridge/reply', { id: q2.id, text: 'DONE' });
  await sleep(700);

  console.log('\n[E2E] 场景 3：写操作 → 我同意 → 真的执行');
  await j('POST', '/api/task', { goal: '测试：创建临时目录并确认' });
  const w1 = await nextMsg();
  await j('POST', '/api/bridge/reply', {
    id: w1.id,
    text: '```powershell\nNew-Item -ItemType Directory -Path "$env:TEMP\\ai-agent-selftest" -Force | Out-Null\nTest-Path "$env:TEMP\\ai-agent-selftest"\n```',
  });
  const pend2 = await waitPending();
  ok('再次被拦下', !!pend2);
  if (pend2) await j('POST', '/api/decision', { id: pend2.id, allow: true });
  const w2 = await nextMsg();
  const wfb = w2 ? w2.text : '';
  ok('同意后执行成功（Test-Path 返回 True）', wfb.includes('True'), wfb.slice(0, 300));
  await j('POST', '/api/bridge/reply', { id: w2.id, text: 'DONE' });
  await sleep(700);

  console.log('\n[E2E] 场景 4：AI 反问 → 我回答');
  await j('POST', '/api/task', { goal: '测试：删除某个文件' });
  const v1 = await nextMsg();
  await j('POST', '/api/bridge/reply', { id: v1.id, text: '你要删哪个文件？' });

  const q = await waitQuestion();
  ok('反问被转成待回答', !!q && q.kind === 'ask');
  if (q) await j('POST', '/api/reply', { id: q.id, text: '算了，不用删了' });
  const v2 = await nextMsg();
  ok('回答被送回 AI', !!(v2 && v2.text.includes('算了，不用删了')), v2 && v2.text.slice(0, 200));
  await j('POST', '/api/bridge/reply', { id: v2.id, text: 'DONE' });
  await sleep(700);

  console.log('\n[E2E] 场景 5：中途停止');
  await j('POST', '/api/task', { goal: '测试：停止' });
  await nextMsg();
  await j('POST', '/api/stop');
  await sleep(1000);
  s = await state();
  ok('能停下来', ['stopped', 'idle'].includes(s.state.status), s.state.status);

  console.log('\n[E2E] 场景 6：权限与安全');
  const r1 = await fetch(BASE + '/api/state');
  ok('无 token 拒绝访问', r1.status === 403);
  const r2 = await fetch(BASE + '/api/task', {
    method: 'POST',
    headers: { 'X-Agent-Token': CFG.token, 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ goal: 'x' }),
  });
  ok('外部来源的写请求被拒', r2.status === 403, r2.status);

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('E2E 崩了：', e);
  process.exit(1);
});
