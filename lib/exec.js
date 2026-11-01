'use strict';
/** 执行 PowerShell 脚本 + 风险分级 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PS_EXE = (() => {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const p = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : 'powershell.exe';
})();

const PREAMBLE = [
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$OutputEncoding = [System.Text.Encoding]::UTF8',
  "$ProgressPreference = 'SilentlyContinue'",
  "$ErrorActionPreference = 'Continue'",
  // $PSStyle 只有 PowerShell 7+ 才有，5.1 里直接赋值会往 stderr 吐一条无意义的错误
  'if (Get-Variable PSStyle -ErrorAction SilentlyContinue) { $PSStyle.OutputRendering = "PlainText" }',
].join('\n');

const MAX_OUT = 9000;

function clip(s) {
  if (!s) return '';
  s = s.replace(/\r\n/g, '\n');
  if (s.length <= MAX_OUT) return s;
  const head = s.slice(0, MAX_OUT - 2500);
  const tail = s.slice(-2000);
  return `${head}\n\n…（中间省略 ${s.length - head.length - tail.length} 字符）…\n\n${tail}`;
}

function runPowerShell(script, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : process.env.USERPROFILE || process.cwd();
  const full = PREAMBLE + '\n' + script;
  const b64 = Buffer.from(full, 'utf16le').toString('base64');
  const t0 = Date.now();

  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let finished = false;
    let child;
    try {
      child = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
        cwd,
        windowsHide: true,
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
      });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: String(e), timedOut: false, durationMs: 0 });
    }

    const timer = setTimeout(() => {
      if (finished) return;
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch (e) {}
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (out.length < 400000) out += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (err.length < 200000) err += d.toString('utf8');
    });
    child.on('error', (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout: clip(out), stderr: String(e), timedOut: false, durationMs: Date.now() - t0 });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const timedOut = Date.now() - t0 >= timeoutMs - 150;
      resolve({
        code: code == null ? -1 : code,
        stdout: clip(out),
        stderr: clip(err),
        timedOut,
        durationMs: Date.now() - t0,
      });
    });
  });
}

/* ---------------------------- 风险分级 ---------------------------- */

const SAFE_VERBS = [
  'get-', 'dir', 'ls', 'gci', 'cat', 'type', 'test-path', 'resolve-path', 'split-path', 'join-path',
  'select-', 'where-', 'sort-', 'group-', 'measure-', 'format-', 'out-string', 'out-host', 'out-null',
  'write-output', 'write-host', 'echo', 'whoami', 'hostname', 'ipconfig', 'systeminfo', 'tasklist',
  'getmac', 'ver', 'set-location', 'cd', 'push-location', 'pop-location', 'compare-',
  'findstr', 'where', 'tree', 'more', 'convertto-json', 'convertfrom-json', 'foreach-object', '%',
  'test-connection', 'get-volume', 'get-psdrive', 'get-disk', 'get-partition',
];

/**
 * PowerShell 控制流关键字。它们不是命令，只是语句壳子；
 * 壳子里真正的写操作会被 WRITE_HINTS 在全文里扫到，所以这里可以安全跳过。
 */
const CONTROL_WORDS = new Set([
  'if', 'elseif', 'else', 'foreach', 'for', 'while', 'do', 'until', 'switch', 'try', 'catch',
  'finally', 'function', 'filter', 'param', 'begin', 'process', 'end', 'return', 'break',
  'continue', 'throw', 'trap', 'exit', 'in',
]);

const WRITE_HINTS = [
  /Remove-(Item|ItemProperty|Variable|CimInstance|Service|LocalUser|Adm|WebSite)/i,
  /(^|[\s;|(])Set-(Item|ItemProperty|Content|Service|ExecutionPolicy|LocalUser|MpPreference|Win|CimInstance|Adm)/i,
  /(^|[\s;|(])New-(Item|ItemProperty|LocalUser|Service|Object.*-Type\s+File)/i,
  /Add-(Content|Type|LocalUser|MpPreference|CimInstance|Member)/i,
  /Clear-(Content|Item|Disk|RecycleBin)/i,
  /(^|[\s;|(])(Copy|Move|Rename)-(Item|ItemProperty)/i,
  /Start-Process/i, /Invoke-Expression/i, /(^|[\s;|(])iex(\s|$)/i,
  /Stop-(Process|Service|Computer)/i, /Restart-(Computer|Service)/i, /Suspend-/i,
  /Out-File/i, /Export-(Csv|ClrXml|Pfx|Module)/i, /Import-Module/i,
  /(Install|Uninstall)-(Module|Package|PackageProvider)/i,
  /(Enable|Disable)-(WindowsOptionalFeature|NetFirewallRule|ScheduledTask|LocalUser|PnpDevice)/i,
  /(Register|Unregister)-(ScheduledTask|ObjectEvent|CimIndicationEvent)/i,
  /(^|[\s;|(])(rm|del|erase|rd|rmdir|mkdir|md|move|copy|xcopy|robocopy|attrib|takeown|icacls)(\s|$)/i,
  /(^|[\s;|(])reg(\s|\.exe\s+)(add|delete|import|copy)/i,
  /(^|[\s;|(])schtasks(\s|\.exe)/i,
  /(^|[\s;|(])sc(\.exe)?\s+(create|delete|config|stop|start)/i,
  /(^|[\s;|(])net(\.exe)?\s+(user|localgroup|share|stop|start)/i,
  /(^|[\s;|(])netsh(\s|\.exe)/i,
  /(^|[\s;|(])taskkill(\s|\.exe)/i,
  /(^|[\s;|(])(winget|choco|scoop|pip|pip3|npm|yarn|pnpm)(\s|\.exe)/i,
  /(^|[\s;|(])git\s+(clone|pull|push|checkout|reset|clean)/i,
  /(^|[\s;|(])dotnet\s+(new|add|build)/i,
  /Stop-Transcript|Start-Transcript/i,
];

const DANGER_PATTERNS = [
  { re: /(^|[\s;|(])format(\.com)?\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /Initialize-Disk|Clear-Disk|Remove-Partition|Format-Volume|New-Partition|Resize-Partition/i, why: '改动磁盘分区' },
  { re: /(^|[\s;|(])diskpart(\s|\.exe|$)/i, why: '磁盘分区工具' },
  { re: /bcdedit/i, why: '修改启动配置' },
  { re: /cipher(\.exe)?\s+\/w/i, why: '擦除磁盘空闲空间' },
  { re: /vssadmin\s+delete|wbadmin\s+delete/i, why: '删除卷影/备份' },
  { re: /(^|[\s;|(])(shutdown|logoff)(\s|\.exe|$)/i, why: '关机/注销' },
  { re: /Restart-Computer|Stop-Computer/i, why: '重启/关机' },
  { re: /Remove-(Item|ItemProperty)[^\n]*(-Recurse[^\n]*(\\|:)\s*$|-Recurse[^\n]*[A-Z]:\\?\s*$)/i, why: '递归删除盘符根目录' },
  { re: /Remove-Item[^\n]*(C:\\Windows|C:\\Program Files|C:\\Users\\[^\\]+\s*$)/i, why: '删除系统关键目录' },
  { re: /(^|[\s;|(])(rd|rmdir)\s+\/s\s+\/q\s+[a-z]:\\?\s*$/i, why: '递归删除盘符根目录' },
  { re: /(^|[\s;|(])rm\s+-rf?\s+(\/|\/\*|[a-z]:\\)/i, why: '递归删除根目录' },
  { re: /Remove-LocalUser|net\s+user\s+\S+\s+\/delete|net\s+localgroup\s+administrators/i, why: '删除/改动账户' },
  { re: /reg\s+delete\s+HKLM/i, why: '删除系统注册表项' },
  { re: /Set-MpPreference|Add-MpPreference[^\n]*Exclusion/i, why: '改动杀毒设置' },
  { re: /Set-ExecutionPolicy\s+(Unrestricted|Bypass)/i, why: '放宽脚本执行策略' },
  { re: /(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget)[^\n|]*\|\s*(iex|Invoke-Expression)/i, why: '从网络下载并直接执行代码' },
  { re: /FromBase64String[^\n]*(iex|Invoke-Expression)/i, why: '解码并执行混淆代码' },
  { re: /Set-WindowsProductKey|slmgr/i, why: '改动激活信息' },
  { re: /Disable-WindowsOptionalFeature|Remove-WindowsCapability/i, why: '卸载系统组件' },
  { re: /takeown[^\n]*\/f\s+[a-z]:\\windows/i, why: '夺取系统目录所有权' },
];

function normalize(script) {
  return script
    .replace(/\r\n/g, '\n')
    .replace(/\d?>&\d/g, '')          // 2>&1 之类
    .replace(/`\n/g, ' ');            // 续行
}

function segments(script) {
  const s = normalize(script);
  return s
    .split(/[\n;]|\|\||&&/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** @returns {{level:'safe'|'confirm'|'danger', why:string[]}} */
function classify(script) {
  const src = normalize(script);
  const why = [];

  for (const d of DANGER_PATTERNS) {
    if (d.re.test(src)) why.push(d.why);
  }
  if (why.length) return { level: 'danger', why };

  // 重定向写文件
  const redirect = /(?<![0-9&])>{1,2}(?!&)\s*\S/.test(src.replace(/2>&1/g, ''));
  if (redirect) why.push('重定向写入文件');

  const hits = [];
  for (const w of WRITE_HINTS) {
    const m = src.match(w);
    if (m) hits.push(m[0].trim());
  }
  if (hits.length) {
    why.push('包含写操作：' + Array.from(new Set(hits)).slice(0, 5).join(', '));
    return { level: 'confirm', why };
  }
  if (redirect) return { level: 'confirm', why };

  // 全部语句必须是只读动词
  const segs = segments(src);
  if (!segs.length) return { level: 'confirm', why: ['空脚本'] };
  const offenders = [];
  for (const seg of segs) {
    let cmd = seg
      .replace(/^[\s{(]+/, '')
      .replace(/^\$[\w:.]+\s*=\s*/, '')   // $x = Get-Item
      .replace(/^\[[\w.]+\]\s*/, '')      // [Console]::...
      .trim();
    if (!cmd) continue;
    if (/^[\$@{(]/.test(cmd)) continue;    // 纯表达式/变量赋值
    if (/^[A-Za-z_]\w*\s*=/.test(cmd)) continue; // 哈希表 / 对象的「键 = 值」
    const word = (cmd.match(/^[A-Za-z_][\w.-]*/) || [''])[0].toLowerCase();
    if (!word) continue;
    if (CONTROL_WORDS.has(word)) continue; // if / else / foreach… 只是语句壳子
    const ok = SAFE_VERBS.some((v) => (v.endsWith('-') ? word.startsWith(v) : word === v));
    if (!ok) offenders.push(word);
  }
  if (offenders.length) {
    return { level: 'confirm', why: ['含未知/可能修改系统的命令：' + Array.from(new Set(offenders)).slice(0, 5).join(', ')] };
  }
  return { level: 'safe', why: ['只读命令'] };
}

module.exports = { runPowerShell, classify, clip, PS_EXE };
