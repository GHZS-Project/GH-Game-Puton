@echo off
setlocal
chcp 65001 >nul
set "TOOL_DIR=%~dp0"
set "NODE=%TOOL_DIR%启动器资源\node.exe"
set "SERVER=%TOOL_DIR%web-server.mjs"
set "GAME_IMPORTER_HOST=0.0.0.0"
set "GAME_IMPORTER_PORT=3218"

if not exist "%NODE%" (
  echo 缺少内置运行环境：%NODE%
  pause
  exit /b 1
)
if not exist "%SERVER%" (
  echo 缺少服务文件：%SERVER%
  pause
  exit /b 1
)

echo 正在启动局域网服务...
curl.exe -s --max-time 2 "http://127.0.0.1:3218/api/state" >nul 2>&1
if errorlevel 1 start "游戏导入台局域网服务" /b "%NODE%" "%SERVER%"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:3218/"
echo.
echo 本机访问：http://127.0.0.1:3218/
echo 局域网地址如下，请把本机 IPv4 地址后的链接发给同事：
ipconfig | findstr /R /C:"IPv4 地址" /C:"IPv4 Address"
echo.
echo 例如：http://192.168.8.162:3218/
echo 服务已在后台运行，此窗口可以关闭。
pause
