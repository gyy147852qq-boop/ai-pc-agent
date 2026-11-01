'use strict';
/** 给网页 AI 的提示词：定义「电脑代理」协议 */

function initialPrompt({ goal, sysinfo }) {
  return `你现在是我的 Windows 电脑操作代理（Agent）。我们之间有一个中转程序在转发消息：

· 我发给你的文字 = 中转程序发来的
· 你回复里的 \`\`\`powershell 代码块 = 会被自动提取、在我的电脑上真实执行
· 执行结果（stdout/stderr/退出码）= 会被自动回传给你

所以你不需要我手动复制粘贴，直接输出命令即可。

━━━━━━ 你必须遵守的协议 ━━━━━━

1. 每次回复只做一件事，二选一：
   (a) 输出【一个】\`\`\`powershell 代码块，用来获取信息或执行下一步操作；
   (b) 如果任务已经全部完成，只输出一行：DONE
2. 代码块外可以有简短说明（一两句话），但不要长篇大论。
3. 代码必须是可直接执行的完整 PowerShell 脚本，不要写伪代码，不要在代码块里写注释式的"说明"。
4. 禁止交互式命令（Read-Host、Pause、more）、禁止启动会阻塞的前台程序、禁止 Start-Sleep 超过 5 秒。
5. 输出会被截断到约 9000 字符。可能输出很多时，请用 Select-Object -First 20 / Measure-Object / Group-Object 先做汇总。
6. 需要更多信息时，就输出一条只读命令去取，不要靠猜。
7. 有风险的操作（删除、覆盖、改注册表、装软件、改系统设置）在代码块前用一行【风险】说明理由，程序会把它交给我确认。
8. 一次只前进一步。不要在一个代码块里塞完整套流程，除非每一步都无风险。
9. 遇到需要我本人决定的事（选哪个目录、用哪个版本、要不要删），直接问，不要执行。
10. 中文回答。

━━━━━━ 电脑当前状态 ━━━━━━
${sysinfo}

━━━━━━ 我的需求 ━━━━━━
${goal}

请给出第一步。`;
}

function followupPrompt({ goal, round, results }) {
  const L = [];
  L.push(`【第 ${round} 步执行结果】`);
  for (const r of results) {
    L.push('');
    L.push(`▶ 命令（${r.shell}）：`);
    L.push('```');
    L.push(r.code.length > 1500 ? r.code.slice(0, 1500) + '\n…(截断)' : r.code);
    L.push('```');
    if (r.skipped) {
      L.push(`结果：未执行（${r.skipped}）`);
      continue;
    }
    L.push(`退出码：${r.code === 0 ? '0（成功）' : r.exitCode}`);
    if (r.stdout) L.push('输出：\n' + r.stdout);
    if (r.stderr) L.push('错误输出：\n' + r.stderr);
    if (r.timedOut) L.push('（超时被强制结束）');
    if (!r.stdout && !r.stderr) L.push('（无输出）');
  }
  L.push('');
  L.push('请给下一步：一个 ```powershell 代码块，或输出 DONE 表示完成。');
  return L.join('\n');
}

function userAnswerPrompt(text) {
  return `【我的回答】${text}

请继续：给下一步命令，或输出 DONE。`;
}

function nudgePrompt() {
  return `请继续。只输出一个 \`\`\`powershell 代码块，或输出 DONE。`;
}

module.exports = { initialPrompt, followupPrompt, userAnswerPrompt, nudgePrompt };
