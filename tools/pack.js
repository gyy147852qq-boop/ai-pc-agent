'use strict';
/**
 * 打包：把整个项目整理成一个干净、可分发的文件夹。
 *
 * 会剔除运行时垃圾：data/（两个 Edge 配置目录约 1GB）、日志、快捷方式、node_modules。
 * 保留：源码、面板、图标、启动脚本、测试、工具。
 *
 * 用法：node tools/pack.js [目标文件夹名]
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..');
const NAME = process.argv[2] || 'AI电脑代理';
const DEST = path.join(path.dirname(SRC), NAME);

// 要带走的
const KEEP_FILES = [
  'server.js',
  'package.json',
  'start.bat',
  'launch.vbs',
  '创建桌面快捷方式.vbs',
  'README.md',
];
const KEEP_DIRS = ['lib', 'public', 'assets', 'tools', 'test'];

// 明确不要的（目录名 / 文件名匹配）
const SKIP_DIRS = new Set(['data', 'node_modules', '.git', '.workbuddy-ai']);
const SKIP_FILES = new Set(['server.log']);

const QUICKSTART = `AI 电脑代理 · 首次使用
================================

这是完整可用的分发包。运行不需要装 Python，不需要 npm install，
只需要 Node.js 22 或更新版本（https://nodejs.org/ 下载即可）。

【三步跑起来】

1) 双击 start.bat
   会自动打开一个 Edge 应用窗口，那就是软件面板。
   控制台里出现「自检通过：面板与桥接脚本的 token 注入正常」即表示就绪。

2) 在面板右侧「接入步骤」里点「一键接管浏览器（不用装扩展）」
   会自动弹出另一个 Edge 窗口。在那个窗口里登录一次 DeepSeek（手机号收验证码即可），
   登录完回到面板再点一次那个按钮（此时显示「重新检查」）。
   顶栏变成绿色的「浏览器接管 已连接」就表示接通了。

   （默认已经是「浏览器接管」模式，不用改设置。油猴脚本那条路在 DeepSeek 上
     没法发消息——它发的是合成事件，而 DeepSeek 的发送按钮只认真实事件。）

3) 在面板左边写需求，点「开始」。
   AI 会一步步给出 PowerShell 命令：
     · 只读命令（Get-*、dir 之类）自动执行
     · 写操作（删除、新建、改注册表…）会停下来等你点「允许 / 拒绝」
     · 高危操作（格式化、关机、删系统目录…）标红，仍然要你确认

【关软件】

点面板右上角「退出」。不要用任务管理器。

【做成桌面图标】

双击本文件夹里的「创建桌面快捷方式.vbs」，只在桌面生成一个图标，
以后双击图标就能启动（不会弹黑窗口）。

【说明】

· data/ 文件夹是运行时自动生成的（配置、日志、浏览器登录态），
  首次启动后才会出现，里面有两个 Edge 配置目录可能有几百 MB，属正常现象。
· 想换台电脑用：把这个文件夹整个拷过去，双击 start.bat，
  然后重新走一遍第 2 步登录即可。
· 排障：面板右侧「看看软件读到的电脑状态」，或看 data/server.log。
`;

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d, skip);
    else if (!SKIP_FILES.has(e.name) && !e.name.endsWith('.lnk')) fs.copyFileSync(s, d);
  }
}

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else n += fs.statSync(f).size;
    }
  };
  if (fs.existsSync(p)) walk(p);
  return n;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

/**
 * 判断某个目录是不是本脚本生成的包。
 * 用「特征文件」而不是隐藏标记文件——标记文件容易在拷贝/解压时丢失，
 * 而且会出现在分发包里不好看。这三个文件同时存在基本不会误判。
 */
function looksLikePackage(dir) {
  return ['server.js', 'package.json', '首次使用.txt'].every((f) =>
    fs.existsSync(path.join(dir, f))
  );
}

// 只删我们自己打的包，不碰别的东西
if (fs.existsSync(DEST)) {
  if (!looksLikePackage(DEST)) {
    console.error('目标目录已存在且不像本脚本生成的包，为安全起见不覆盖：');
    console.error('  ' + DEST);
    process.exit(1);
  }
  rmrf(DEST);
}

fs.mkdirSync(DEST, { recursive: true });
for (const f of KEEP_FILES) {
  const s = path.join(SRC, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(DEST, f));
  else console.warn('缺少文件，跳过：' + f);
}
for (const d of KEEP_DIRS) {
  const s = path.join(SRC, d);
  if (fs.existsSync(s)) copyDir(s, path.join(DEST, d), SKIP_DIRS);
  else console.warn('缺少目录，跳过：' + d);
}
fs.writeFileSync(path.join(DEST, '首次使用.txt'), QUICKSTART, 'utf8');

const count = (function walk(d) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) n += walk(path.join(d, e.name));
    else n++;
  }
  return n;
})(DEST);

console.log('打包完成：' + DEST);
console.log('  文件数：' + count);
console.log('  体积  ：' + (dirSize(DEST) / 1024).toFixed(0) + ' KB');
console.log('  已剔除：data/（Edge 配置目录）、日志、.lnk');
