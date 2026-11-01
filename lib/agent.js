'use strict';
/** 代理主循环：需求 → 网页 AI → 解析命令 → 本机执行 → 结果回传 → 循环 */
const { parseReply } = require('./parse');
const { classify, runPowerShell } = require('./exec');
const P = require('./prompt');

function short(s, n = 4000) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '\n…(显示截断)' : s;
}

async function runTask(ctx) {
  const {
    goal,
    sysinfoText,
    bridge,
    opts = {},
    emit,
    ask,
    approve,
    signal,
  } = ctx;

  const maxRounds = opts.maxRounds || 25;
  const execTimeout = opts.execTimeoutMs || 120000;
  const autoSafe = opts.autoSafe !== false;

  const checkAbort = () => {
    if (signal && signal.aborted) throw new Error('已手动停止');
  };

  emit('sys', '正在把需求和电脑状态发给网页 AI…');
  let reply = await bridge.send(P.initialPrompt({ goal, sysinfo: sysinfoText }), {
    timeoutMs: opts.replyTimeoutMs || 240000,
  });
  checkAbort();
  emit('ai', short(reply));

  let round = 0;
  while (round < maxRounds) {
    checkAbort();
    round += 1;

    let parsed = parseReply(reply);

    // 模型没按协议来（纯聊天、没给代码块）
    if (parsed.type === 'question') {
      emit('ask', parsed.text);
      const answer = await ask(parsed.text);
      checkAbort();
      emit('user', answer);
      reply = await bridge.send(P.userAnswerPrompt(answer), {
        timeoutMs: opts.replyTimeoutMs || 240000,
      });
      emit('ai', short(reply));
      continue;
    }

    if (parsed.type === 'done') {
      emit('done', parsed.text || 'DONE');
      return { ok: true, rounds: round, summary: parsed.text };
    }

    // 有脚本 → 逐条过风险审查并执行
    const results = [];
    for (let i = 0; i < parsed.scripts.length; i++) {
      checkAbort();
      const s = parsed.scripts[i];
      const risk = classify(s.code);
      emit('cmd', s.code, { shell: s.shell, risk, index: i + 1, total: parsed.scripts.length });

      let allowed = true;
      if (risk.level === 'safe' && autoSafe) {
        emit('sys', '只读命令，自动执行');
      } else {
        const d = await approve({ code: s.code, shell: s.shell, risk });
        checkAbort();
        allowed = !!(d && d.allow);
        if (!allowed) emit('sys', '你拒绝了这条命令，已告知 AI');
      }

      if (!allowed) {
        results.push({ code: s.code, shell: s.shell, skipped: '用户拒绝执行这条命令', exitCode: null, stdout: '', stderr: '' });
        continue;
      }

      emit('sys', `执行中…（超时 ${Math.round(execTimeout / 1000)}s）`);
      const r = await runPowerShell(s.code, { timeoutMs: execTimeout });
      emit('out', r.stdout || r.stderr || '（无输出）', {
        exitCode: r.code,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
        hasErr: !!r.stderr,
      });
      results.push({
        code: s.code,
        shell: s.shell,
        exitCode: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        timedOut: r.timedOut,
      });
    }

    checkAbort();
    emit('sys', '把执行结果回传给 AI，等它给下一步…');
    reply = await bridge.send(
      P.followupPrompt({ goal, round, results }),
      { timeoutMs: opts.replyTimeoutMs || 240000 }
    );
    emit('ai', short(reply));
  }

  emit('warn', `已达到最大轮数 ${maxRounds}，自动停止。可以调高上限后继续。`);
  return { ok: false, rounds: round, summary: '超过最大轮数' };
}

module.exports = { runTask };
