'use strict';
/** 采集本机状态，打包成一段紧凑文本喂给网页 AI */
const { runPowerShell } = require('./exec');

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$os   = Get-CimInstance Win32_OperatingSystem
$cs   = Get-CimInstance Win32_ComputerSystem
$cpu  = Get-CimInstance Win32_Processor | Select-Object -First 1
$drv  = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
          [pscustomobject]@{ d=$_.DeviceID; sizeGB=[math]::Round($_.Size/1GB,1); freeGB=[math]::Round($_.FreeSpace/1GB,1) } }
$proc = Get-Process | Sort-Object WS -Descending | Select-Object -First 8 | ForEach-Object {
          [pscustomobject]@{ n=$_.ProcessName; mb=[math]::Round($_.WS/1MB,1) } }
$ip   = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=1" | ForEach-Object { $_.IPAddress } | Where-Object { $_ -match '^\d+\.' }
$adm  = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$tools = @('node','npm','git','python','code','winget','docker','pwsh','7z','ffmpeg') | ForEach-Object {
          if (Get-Command $_ -ErrorAction SilentlyContinue) { $_ } }
$o = [ordered]@{
  os        = $os.Caption
  osVersion = $os.Version
  arch      = $os.OSArchitecture
  host      = $env:COMPUTERNAME
  user      = "$env:USERDOMAIN\$env:USERNAME"
  admin     = $adm
  uptimeH   = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours,1)
  cpu       = $cpu.Name.Trim()
  cores     = $cpu.NumberOfCores
  ramGB     = [math]::Round($cs.TotalPhysicalMemory/1GB,1)
  ramFreeGB = [math]::Round($os.FreePhysicalMemory/1MB,1)
  desktop   = [Environment]::GetFolderPath('Desktop')
  profile   = $env:USERPROFILE
  cwd       = (Get-Location).Path
  psVersion = $PSVersionTable.PSVersion.ToString()
  culture   = (Get-Culture).Name
  drives    = @($drv)
  topProcs  = @($proc)
  ips       = @($ip)
  tools     = @($tools)
}
$o | ConvertTo-Json -Depth 6 -Compress
`;

function fmt(got) {
  if (!got) return '（状态采集失败）';
  const L = [];
  L.push(`操作系统：${got.os} (${got.osVersion}, ${got.arch})`);
  L.push(`计算机名：${got.host}　当前用户：${got.user}　管理员权限：${got.admin ? '是' : '否'}`);
  L.push(`已开机：${got.uptimeH} 小时　CPU：${got.cpu} (${got.cores} 核)　内存：${got.ramGB}GB，可用 ${got.ramFreeGB}GB`);
  L.push(`PowerShell：${got.psVersion}　系统语言：${got.culture}`);
  L.push(`用户目录：${got.profile}　桌面：${got.desktop}`);
  L.push(`工作目录：${got.cwd}`);
  if (Array.isArray(got.drives) && got.drives.length) {
    L.push('磁盘：' + got.drives.map((d) => `${d.d} 总${d.sizeGB}GB/剩${d.freeGB}GB`).join('；'));
  }
  if (Array.isArray(got.ips) && got.ips.length) L.push('内网 IP：' + got.ips.join(', '));
  if (Array.isArray(got.tools) && got.tools.length) L.push('已装工具：' + got.tools.join(', '));
  if (Array.isArray(got.topProcs) && got.topProcs.length) {
    L.push('内存占用前 8 进程：' + got.topProcs.map((p) => `${p.n}(${p.mb}MB)`).join(', '));
  }
  return L.join('\n');
}

async function collect() {
  const r = await runPowerShell(SCRIPT, { timeoutMs: 25000 });
  let data = null;
  try {
    const t = r.stdout.trim();
    data = JSON.parse(t.slice(t.indexOf('{')));
  } catch (e) {
    data = null;
  }
  return { data, text: fmt(data), raw: r };
}

module.exports = { collect, SCRIPT };
