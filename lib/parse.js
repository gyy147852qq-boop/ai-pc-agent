'use strict';
/** 从网页 AI 的回复里解析出：要执行的脚本 / 任务完成 / 反问用户 */

const PS_LANGS = new Set(['powershell', 'ps1', 'pwsh', 'ps', 'psh', 'posh', 'powershell5', 'windowspowershell']);
const SH_LANGS = new Set(['cmd', 'bat', 'batch', 'bash', 'sh', 'shell', 'console', 'shell-session']);

const DONE_RE = /(^|\n)\s*(DONE|完成|任务完成|已结束)\s*($|\n)/i;

function extractFences(text) {
  const blocks = [];
  const re = /```([a-zA-Z0-9+#._-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ lang: (m[1] || '').toLowerCase().trim(), code: m[2].replace(/\r\n/g, '\n') });
  }
  return blocks;
}

function extractUnclosed(text) {
  const re = /```([a-zA-Z0-9+#._-]*)[ \t]*\r?\n([\s\S]*)$/;
  const m = text.match(re);
  if (!m) return null;
  return { lang: (m[1] || '').toLowerCase().trim(), code: m[2].replace(/\r\n/g, '\n') };
}

/**
 * @returns {{type:'script'|'done'|'question', scripts:Array<{lang:string,code:string,shell:'powershell'|'cmd'|'bash'}>, text:string}}
 */
function parseReply(raw) {
  const text = String(raw || '').trim();
  let blocks = extractFences(text);

  // 模型有时把代码块围栏写坏（缺结尾），兜底
  if (!blocks.length) {
    const u = extractUnclosed(text);
    if (u && (PS_LANGS.has(u.lang) || SH_LANGS.has(u.lang) || u.code.trim())) blocks = [u];
  }

  const scripts = [];
  for (const b of blocks) {
    const code = b.code.trim();
    if (!code) continue;
    let shell = 'powershell';
    if (SH_LANGS.has(b.lang)) shell = b.lang === 'bash' || b.lang === 'sh' || b.lang === 'shell' ? 'bash' : 'cmd';
    else if (!b.lang) {
      // 无语言标注：明显是 shell 片段才收，纯文本/输出示例忽略
      const looksScript = /^\s*(Get-|Set-|New-|Remove-|Write-|\$|cd |dir|ls|powershell|reg |net |sc |[A-Za-z]:\\)/m.test(code);
      if (!looksScript) continue;
    } else if (!PS_LANGS.has(b.lang)) {
      continue; // json / python / text 等一律不执行
    }
    scripts.push({ lang: b.lang || 'powershell', code, shell });
  }

  if (scripts.length) return { type: 'script', scripts, text };

  if (DONE_RE.test(text) || /\bDONE\b/.test(text)) return { type: 'done', scripts: [], text };
  if (/任务(已经)?完成|全部完成|已帮你完成|无需继续/.test(text)) return { type: 'done', scripts: [], text };

  return { type: 'question', scripts: [], text };
}

module.exports = { parseReply, extractFences };
