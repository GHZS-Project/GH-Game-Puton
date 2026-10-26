$ErrorActionPreference = 'Stop'

$toolDir = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$toolUrl = 'http://127.0.0.1:3218/'
$stateUrl = 'http://127.0.0.1:3218/api/state'
$logPath = Join-Path $PSScriptRoot '启动器错误.log'
$bundledNode = Join-Path $PSScriptRoot 'node.exe'
$edgeCandidates = @(
  "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe"
)

function Write-LauncherLog {
  param([string]$Message)
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Test-ServiceReady {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $stateUrl -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Get-NodePath {
  if (Test-Path -LiteralPath $bundledNode) { return $bundledNode }
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $command -and $command.Source) { return $command.Source }
  throw "未找到 Node.js。请确认 启动器资源\node.exe 存在，或在电脑上安装 Node.js。"
}

try {
  if (-not (Test-ServiceReady)) {
    if (-not (Test-Path -LiteralPath $toolDir)) {
      throw "工具目录不存在：$toolDir"
    }

    $node = Get-NodePath
    Start-Process -FilePath $node -WindowStyle Hidden -WorkingDirectory $toolDir -ArgumentList @('web-server.mjs') | Out-Null

    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline) {
      if (Test-ServiceReady) { break }
      Start-Sleep -Milliseconds 500
    }
  }

  $edgePath = $edgeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($edgePath) {
    Start-Process -FilePath $edgePath -ArgumentList $toolUrl | Out-Null
  } else {
    Start-Process $toolUrl | Out-Null
  }
} catch {
  Write-LauncherLog $_.Exception.Message
  try {
    $shell = New-Object -ComObject WScript.Shell
    $shell.Popup("启动失败：$($_.Exception.Message)`n`n请查看：$logPath", 0, "光环上架启动器", 16) | Out-Null
  } catch {}
}
