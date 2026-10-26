const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PORT = Number(process.env.GAME_IMPORTER_PORT || 3218);
const APP_URL = `http://127.0.0.1:${PORT}/`;
const HEALTH_URL = `http://127.0.0.1:${PORT}/api/state`;
const STARTUP_LOG = path.join(__dirname, '启动器错误.log');

let mainWindow = null;
let serverProcess = null;
let ownsServer = false;

function writeStartupLog(message) {
  const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}\n`;
  try {
    fs.appendFileSync(STARTUP_LOG, line, 'utf8');
  } catch {
    // Startup logging must never prevent the app from opening.
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestHealth(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(HEALTH_URL, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode && res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

async function waitForServer(maxWaitMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    if (await requestHealth()) return true;
    await wait(500);
  }
  return false;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1060,
    minHeight: 680,
    title: '游戏导入台',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f6f7fb',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startServer() {
  const serverScript = path.join(__dirname, 'web-server.mjs');
  if (!fs.existsSync(serverScript)) {
    throw new Error(`缺少服务文件：${serverScript}`);
  }

  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    ELECTRON_RUN_AS_NODE: '1',
    GAME_IMPORTER_PORT: String(PORT),
  };

  const child = spawn(process.execPath, [serverScript], {
    cwd: __dirname,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (data) => writeStartupLog(`服务输出：${data.toString().trim()}`));
  child.stderr.on('data', (data) => writeStartupLog(`服务错误：${data.toString().trim()}`));
  child.on('error', (error) => writeStartupLog(`服务启动失败：${error.message}`));
  child.on('exit', (code, signal) => {
    writeStartupLog(`服务已退出：code=${code ?? ''} signal=${signal ?? ''}`);
    if (serverProcess === child) {
      serverProcess = null;
      ownsServer = false;
    }
  });

  serverProcess = child;
  ownsServer = true;
}

async function boot() {
  writeStartupLog('启动工具。');
  createWindow();

  let ready = await requestHealth();
  if (!ready) {
    writeStartupLog('本地服务未运行，准备使用内置运行时启动。');
    startServer();
    ready = await waitForServer();
  } else {
    writeStartupLog('检测到本地服务已运行，直接打开界面。');
  }

  if (!ready) {
    const message = `工具服务启动超时，请查看日志：${STARTUP_LOG}`;
    writeStartupLog(message);
    dialog.showErrorBox('游戏导入台启动失败', message);
    app.quit();
    return;
  }

  await mainWindow.loadURL(APP_URL);
}

function stopServer() {
  if (!serverProcess || !ownsServer) return;
  try {
    serverProcess.kill();
  } catch (error) {
    writeStartupLog(`关闭服务失败：${error.message}`);
  }
  serverProcess = null;
  ownsServer = false;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(boot).catch((error) => {
    const message = error?.stack || error?.message || String(error);
    writeStartupLog(message);
    dialog.showErrorBox('游戏导入台启动失败', `${message}\n\n日志：${STARTUP_LOG}`);
    app.quit();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    stopServer();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  });
}
