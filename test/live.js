'use strict';
/**
 * 实跑工具：对着真实的网页 AI 跑一个任务，把过程实时打出来。
 * 用法：node test/live.js "看看我的 C 盘还剩多少空间" [超时秒数]
 */
const fs = require('fs');
const path = require('path');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
const BASE = `http://127.0.0.1:${CFG.port}`;
const H = { 'X-Agent-Token': CFG.token, 'Content-Type': 'application/json' };

const goal = process.argv[2] || '看看我的 C 盘还剩多少空间';
const limitMs = (Number(process.argv[3]) || 240) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

const ICON = { user: '▶', ai: '🤖', sys: '·', cmd: '$', out: '#', warn: '!', err: '✗', done: '✓', ask: '?' };

(async () => {
  const st0 = await j('GET', '/api/state');
  if (st0.json.state.running) {
    console.log('已有任务在跑，先停止…');
    await j('POST', '/api/stop');
    await sleep(1200);
  }

  console.log('需求：' + goal);
  console.log('─'.repeat(70));
  const r = await j('POST', '/api/task', { goal });
  if (!r.json.ok) {
    console.log('任务没受理：' + r.json.error);
    process.exit(1);
  }

  let seen = 0;
  const t0 = Date.now();
  let approved = 0;
  while (Date.now() - t0 < limitMs) {
    await sleep(1200);
    const s = (await j('GET', '/api/state')).json;

    // LIVE_APPROVE=1 时自动同意待确认命令，方便无人值守跑通写操作链路
    if (process.env.LIVE_APPROVE === '1' && s.state.pending) {
      approved += 1;
      console.log('\n[自动同意 #' + approved + '] ' + (s.state.pending.risk.why || []).join('；'));
      await j('POST', '/api/decision', { id: s.state.pending.id, allow: true });
    }

    const logs = s.logs || [];
    for (const l of logs) {
      if (l.id <= seen) continue;
      seen = l.id;
      if (l.kind === 'sys') {
        console.log('  ' + ICON.sys + ' ' + l.text);
      } else if (l.kind === 'cmd') {
        const lv = (l.meta && l.meta.risk && l.meta.risk.level) || '?';
        console.log('\n' + ICON.cmd + ' [命令/' + lv + ']\n' + l.text.split('\n').map((x) => '    ' + x).join('\n'));
      } else if (l.kind === 'out') {
        const t = l.text.length > 700 ? l.text.slice(0, 700) + '\n    …(截断)' : l.text;
        console.log(ICON.out + ' [输出] ' + t.split('\n').map((x) => '    ' + x).join('\n'));
      } else if (l.kind === 'ai') {
        const t = l.text.length > 400 ? l.text.slice(0, 400) + ' …' : l.text;
        console.log('\n' + ICON.ai + ' [AI] ' + t);
      } else if (l.kind === 'user') {
        console.log(ICON.user + ' [需求] ' + l.text);
      } else if (l.kind === 'done') {
        console.log('\n' + ICON.done + ' [完成] ' + l.text);
      } else if (l.kind === 'warn') {
        console.log(ICON.warn + ' [提示] ' + l.text);
      } else if (l.kind === 'err') {
        console.log(ICON.err + ' [错误] ' + l.text);
      } else if (l.kind === 'ask') {
        console.log(ICON.ask + ' [AI 提问] ' + l.text);
      }
    }
    if (!s.state.running) {
      console.log('─'.repeat(70));
      console.log('结束状态：' + s.state.status + ' / ' + s.state.statusText);
      process.exit(s.state.status === 'done' ? 0 : 2);
    }
  }
  console.log('─'.repeat(70));
  console.log('超时未结束，仍在运行（状态：' + (await j('GET', '/api/state')).json.state.statusText + '）');
  process.exit(3);
})().catch((e) => {
  console.error('崩了：', e);
  process.exit(1);
});
