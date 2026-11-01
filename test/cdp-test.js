'use strict';
/** CDP 通道自测：起一个一次性浏览器实例，验证 连接 / 注入 / 执行页面脚本 / 找不到输入框时的降级 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { CdpBridge } = require('../lib/cdp');

const PORT = 9333;
const PROFILE = path.join(os.tmpdir(), 'ai-agent-cdp-test-' + Date.now());

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

(async () => {
  const b = new CdpBridge({
    cdpPort: PORT,
    cdpUrl: 'https://example.com',
    profileDir: PROFILE,
    pageAgentPath: path.join(__dirname, '..', 'lib', 'page-agent.src.js'),
    emit: (k, t) => console.log('   · [' + k + '] ' + t),
  });

  console.log('\n[CDP] 启动并连接');
  try {
    await b.connect();
    ok('浏览器拉起并连上调试端口', !!b.ws);
  } catch (e) {
    ok('浏览器拉起并连上调试端口', false, e.message);
  }

  if (b.ws) {
    const two = await b.evaluate('1+1');
    ok('能在页面里执行 JS', two === 2, String(two));

    const has = await b.evaluate('!!window.__AIAgent');
    ok('页面代理已注入', has === true, String(has));

    const st = await b.evaluate('window.__AIAgent.status()');
    ok('status() 可用', !!st && st.profile === 'generic', JSON.stringify(st));
    ok('示例页没有聊天框（符合预期）', st && st.hasComposer === false);

    const setRes = await b.evaluate('window.__AIAgent.setInput("hello")');
    ok('找不到输入框时给出明确错误', setRes && setRes.ok === false && /输入框/.test(setRes.error), JSON.stringify(setRes));

    const snap = await b.evaluate('window.__AIAgent.snapshot()');
    ok('snapshot() 可用', !!snap && typeof snap.count === 'number', JSON.stringify(snap));
  }

  console.log('\n[CDP] 收尾');
  try {
    if (b.browserProc && b.browserProc.pid) {
      spawn('taskkill', ['/PID', String(b.browserProc.pid), '/T', '/F'], { windowsHide: true });
      ok('测试浏览器已关闭', true);
    }
  } catch (e) {
    ok('测试浏览器已关闭', false, e.message);
  }
  setTimeout(() => {
    try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
    process.exit(fail ? 1 : 0);
  }, 1500);
})().catch((e) => {
  console.error('CDP 测试崩了：', e);
  process.exit(1);
});
