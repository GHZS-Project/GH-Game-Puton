import http from 'node:http';
import path from 'node:path';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';

const toolRoot = path.resolve(import.meta.dirname);
const pageRoot = path.join(toolRoot, '页面');
const importScript = path.join(toolRoot, 'scripts', 'import-games.mjs');
const browserHelperScript = path.join(toolRoot, 'scripts', '浏览器登录助手.mjs');
const sessionDir = path.join(toolRoot, '浏览器登录状态');
const manualPath = path.join(toolRoot, '操作手册', '游戏后台批量导入工具-操作手册.docx');
const readmePath = path.join(toolRoot, 'README.md');
const cachePath = path.join(toolRoot, '工具缓存.json');
const port = Number(process.env.GAME_IMPORTER_PORT || 3218);
const host = process.env.GAME_IMPORTER_HOST || '127.0.0.1';
const cdpPort = Number(process.env.GAME_IMPORTER_CDP_PORT || 9222);
const cdpUrl = `http://127.0.0.1:${cdpPort}`;
const defaultGameDataRoot = 'E:\\新建文件夹\\游戏资料';
const registrationFileName = '游戏资料登记表.csv';
const registrationColumns = ['时间', '游戏名称', '游戏类型', '游戏ID', '显示状态', '状态', 'APK方式', 'APK链接', '平台', '合作方式', '错误原因'];

const defaultPreferences = {
  cacheVersion: 2,
  source: '',
  selectedBrowser: null,
  fetchApkInDryRun: true,
  autoShow: false,
  mode: 'test',
  concurrency: 1,
};

const state = {
  running: false,
  mode: '',
  logs: [],
  startedAt: '',
  lastResult: null,
  source: '',
  csvPath: '',
  taskLogPath: '',
  loginInfo: null,
  currentGame: '',
  progress: { total: 0, current: 0 },
  reviewOnFinish: false,
  preferences: readPreferences(),
};

const currentChildren = new Set();
let stopRequested = false;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return serveFile(res, path.join(pageRoot, 'index.html'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/style.css') {
      return serveFile(res, path.join(pageRoot, 'style.css'), 'text/css; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/app.js') {
      return serveFile(res, path.join(pageRoot, 'app.js'), 'application/javascript; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const targetPath = url.searchParams.get('path') || '';
      return serveFile(res, targetPath, guessMimeType(targetPath));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, snapshotState());
    }
    if (req.method === 'GET' && url.pathname === '/api/browsers') {
      const result = await runJsonCommand(browserHelperScript, ['--list', '--session-dir', sessionDir]);
      return json(res, 200, {
        candidates: result.data?.candidates || [],
        selectedBrowser: state.preferences.selectedBrowser,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/games') {
      const source = url.searchParams.get('source') || state.preferences.source || '';
      const payload = source ? scanGames(source) : { source: '', games: [], summary: emptySummary() };
      state.source = payload.source || state.source;
      state.csvPath = payload.source ? registrationCsvPath(payload.source) : state.csvPath;
      if (payload.source) savePreferences({ source: payload.source });
      return json(res, 200, payload);
    }
    if (req.method === 'GET' && url.pathname === '/api/registration') {
      const source = url.searchParams.get('source') || state.source || state.preferences.source;
      return json(res, 200, readRegistration(source));
    }
    if (req.method === 'GET' && url.pathname === '/api/registration-csv') {
      const source = url.searchParams.get('source') || state.source || state.preferences.source;
      const csvPath = registrationCsvPath(source);
      if (!csvPath || !existsSync(csvPath)) return json(res, 404, { error: '当前目录下还没有登记表。' });
      return serveFile(res, csvPath, 'text/csv; charset=utf-8');
    }
    if (req.method === 'POST' && url.pathname === '/api/select-folder') {
      const folder = await selectFolder();
      if (folder) savePreferences({ source: folder });
      return json(res, 200, { folder });
    }
    if (req.method === 'POST' && url.pathname === '/api/preferences') {
      const body = await readJson(req);
      savePreferences(body);
      return json(res, 200, { preferences: state.preferences });
    }
    if (req.method === 'POST' && url.pathname === '/api/save-game') {
      const body = await readJson(req);
      const saved = saveGameInfo(body);
      return json(res, 200, saved);
    }
    if (req.method === 'POST' && url.pathname === '/api/remove-imported-game') {
      const body = await readJson(req);
      const source = body.source || state.source || state.preferences.source;
      const removed = removeImportedGame(source, body.name);
      return json(res, 200, { ok: true, removed });
    }
    if (req.method === 'POST' && url.pathname === '/api/delete-registration-rows') {
      const body = await readJson(req);
      const source = body.source || state.source || state.preferences.source;
      const removed = deleteRegistrationRows(source, body.rowIndexes);
      return json(res, 200, { ok: true, removed });
    }
    if (req.method === 'POST' && url.pathname === '/api/open-path') {
      const body = await readJson(req);
      if (body.path) await openPath(body.path);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/check-login') {
      const result = await ensureCurrentBrowser();
      state.loginInfo = result;
      if (result.loggedIn) ensureRegistrationFile(state.preferences.source || state.source || defaultGameDataRoot);
      return json(res, 200, { ok: result.ok, data: result });
    }
    if (req.method === 'POST' && url.pathname === '/api/open-login') {
      if (state.running) return json(res, 409, { error: '已有任务正在执行，请先停止当前任务。' });
      const result = await ensureCurrentBrowser({ open: true });
      state.loginInfo = result;
      if (result.loggedIn) ensureRegistrationFile(state.preferences.source || state.source || defaultGameDataRoot);
      return json(res, 200, { ok: result.ok, data: result });
    }
    if (req.method === 'POST' && url.pathname === '/api/start-import') {
      if (state.running) return json(res, 409, { error: '已有任务正在执行，请先停止当前任务。' });
      const body = await readJson(req);
      if (!body.source) return json(res, 400, { error: '请先选择资料总文件夹。' });
      if (!Array.isArray(body.selectedGames) || !body.selectedGames.length) {
        return json(res, 400, { error: '请至少选择一个要导入的游戏。' });
      }
      if (body.selectedGames.length > 10) {
        return json(res, 400, { error: '一次最多选择 10 个游戏。请分批执行，完成后再导入剩余游戏。' });
      }
      const browserInfo = await ensureCurrentBrowser();
      state.loginInfo = browserInfo;
      if (!browserInfo.ok || !browserInfo.loggedIn) {
        return json(res, 409, {
          error: browserInfo.message || '未检测到后台登录状态，请先完成登录后再执行任务。',
          loginInfo: browserInfo,
        });
      }

      const scanned = scanGames(body.source);
      const selectedGames = scanned.games.filter((game) => body.selectedGames.includes(game.id));

      const blocking = selectedGames.flatMap((game) => [
        ...game.blockingIssues.map((message) => `${game.name}：${message}`),
        ...game.missingFields.map((field) => `${game.name}：缺少${field}`),
      ]);
      if (!selectedGames.length) return json(res, 400, { error: '请至少选择一个要导入的游戏。' });
      if (blocking.length) {
        return json(res, 400, {
          error: `还有资料未补齐：${blocking[0]}`,
          missingGames: selectedGames
            .filter((game) => game.blockingIssues.length || game.missingFields.length)
            .map((game) => ({
              id: game.id,
              name: game.name,
              infoPath: game.infoPath,
              missingFields: game.missingFields,
              blockingIssues: game.blockingIssues,
              data: game.data,
            })),
        });
      }

      savePreferences({
        source: body.source,
        fetchApkInDryRun: true,
        autoShow: body.noAutoShow ? false : true,
        mode: body.submit ? 'submit' : 'test',
        concurrency: clampConcurrency(body.concurrency),
      });

      void runImportQueue({
        source: body.source,
        selectedGames,
        submit: Boolean(body.submit),
        uploadInDryRun: Boolean(body.uploadInDryRun),
        fetchApkInDryRun: true,
        noAutoShow: Boolean(body.noAutoShow),
        concurrency: clampConcurrency(body.concurrency),
      });
      return json(res, 200, { ok: true, count: selectedGames.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/stop-task') {
      stopCurrentTask();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: '未找到对应接口。' });
  } catch (error) {
    return json(res, 500, { error: String(error?.message || error) });
  }
});

server.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? '局域网地址' : host;
  console.log(`游戏后台批量导入工具已启动：http://${displayHost}:${port}`);
});

function snapshotState() {
  return {
    running: state.running,
    mode: state.mode,
    logs: state.running || state.lastResult ? state.logs.slice(-80) : [],
    startedAt: state.startedAt,
    lastResult: state.lastResult,
    source: state.source,
    csvPath: state.csvPath,
    taskLogPath: state.taskLogPath,
    loginInfo: state.loginInfo,
    manualPath: existsSync(manualPath) ? manualPath : readmePath,
    readmePath,
    currentGame: state.currentGame,
    progress: state.progress,
    preferences: { ...state.preferences, source: state.preferences.source || state.source || '' },
  };
}

function serveFile(res, filePath, contentType) {
  if (!filePath || !existsSync(filePath)) return json(res, 404, { error: '文件不存在。' });
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(readFileSync(filePath));
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
    });
    req.on('end', () => {
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function readPreferences() {
  try {
    if (!existsSync(cachePath)) return { ...defaultPreferences };
    const data = JSON.parse(readFileSync(cachePath, 'utf8'));
    if (data.cacheVersion !== defaultPreferences.cacheVersion) {
      return {
        ...defaultPreferences,
        ...data,
        cacheVersion: defaultPreferences.cacheVersion,
        fetchApkInDryRun: true,
        autoShow: false,
        mode: 'test',
      };
    }
    return normalizePreferences({ ...defaultPreferences, ...data });
  } catch {
    return { ...defaultPreferences };
  }
}

function normalizePreferences(preferences) {
  return {
    ...preferences,
    mode: preferences.mode === 'submit' ? 'submit' : 'test',
    concurrency: clampConcurrency(preferences.concurrency),
  };
}

function savePreferences(partial) {
  state.preferences = normalizePreferences({ ...state.preferences, ...partial });
  writeFileSync(cachePath, JSON.stringify(state.preferences, null, 2), 'utf8');
}

function clampConcurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.max(1, Math.min(10, Math.round(number)));
}

function browserArgs(browser) {
  if (!browser) return [];
  const args = [];
  if (browser.browser) args.push('--browser-name', browser.browser);
  if (browser.profileName) args.push('--profile-name', browser.profileName);
  if (browser.executablePath) args.push('--executable-path', browser.executablePath);
  if (browser.userDataDir) args.push('--user-data-dir', browser.userDataDir);
  return args;
}

async function ensureCurrentBrowser({ open = false } = {}) {
  const connected = await canConnectCdp();
  if (!connected) {
    if (!open) {
      return {
        ok: false,
        loggedIn: false,
        message: '未检测到可自动操作的后台窗口，请先打开登录入口并登录后台。',
        cdpUrl,
      };
    }
    openCurrentBrowserWindow();
    await waitForCdpReady(15000);
  }
  const targets = await getCdpJson('/json/list').catch(() => []);
  const pages = Array.isArray(targets) ? targets.filter((item) => item?.type === 'page') : [];
  const adminPage = pages.find((item) => String(item.url || '').includes('and-admin.ghzs.com'));
  const loginPage = pages.find((item) => /sso\.ghzs\.com|Authelia|login/i.test(`${item.url || ''} ${item.title || ''}`));
  if (!adminPage || loginPage) {
    return {
      ok: false,
      loggedIn: false,
      message: loginPage
        ? '后台窗口当前仍在登录页，请先完成登录后再执行任务。'
        : '未检测到已登录的后台游戏信息页面，请先打开后台并完成登录。',
      cdpUrl,
    };
  }
  return {
    ok: true,
    loggedIn: true,
    message: connected
      ? `已连接当前可自动操作的后台窗口。`
      : `已打开可自动操作的后台窗口。若页面显示登录，请先登录一次。`,
    cdpUrl,
  };
}

function canConnectCdp() {
  return new Promise((resolve) => {
    const req = http.get(`${cdpUrl}/json/version`, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForCdpReady(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canConnectCdp()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('当前浏览器调试窗口没有启动成功，请关闭旧的后台窗口后重试。');
}

function openCurrentBrowserWindow() {
  mkdirSync(sessionDir, { recursive: true });
  const executablePath = findBrowserExecutable();
  if (!executablePath) throw new Error('未找到 Edge 或 Chrome 浏览器。');
  const child = spawn(executablePath, [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${sessionDir}`,
    '--profile-directory=Default',
    '--new-window',
    '--window-position=80,80',
    '--window-size=1280,900',
    'https://and-admin.ghzs.com/#/games-manage/games-info?href=games_info_menu',
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

function findBrowserExecutable() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];
  return candidates.find((item) => item && existsSync(item)) || '';
}

function scanGames(sourcePath) {
  const resolved = path.resolve(sourcePath);
  if (!existsSync(resolved)) throw new Error(`资料目录不存在：${resolved}`);

  const games = [];
  if (statSync(resolved).isFile()) {
    games.push(buildGameRecord(path.dirname(resolved), path.basename(resolved)));
  } else {
    collectGameRecords(resolved, games, 0);
  }

  const importedNames = importedGameNames(resolved);
  const markedGames = games.map((game) => ({
    ...game,
    imported: importedNames.has(game.name),
  }));

  return {
    source: resolved,
    games: markedGames,
    importedGames: markedGames.filter((game) => game.imported),
    summary: summarizeGames(markedGames),
  };
}

function collectGameRecords(dir, games, depth) {
  const infoFiles = findInfoFiles(dir);
  if (infoFiles.length) {
    games.push(buildGameRecord(dir, chooseInfoFile(dir, infoFiles)));
    return;
  }
  if (depth >= 3) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!safeIsDirectory(full)) continue;
    collectGameRecords(full, games, depth + 1);
  }
}

function buildGameRecord(dir, infoFileName) {
  const infoPath = path.join(dir, infoFileName);
  const rawText = readFileSync(infoPath, 'utf8').replace(/^\uFEFF/, '');
  const data = parseInfo(rawText);
  const files = readdirSync(dir).map((name) => path.join(dir, name));
  const imageGuess = classifyImages(files);
  const icon = imageGuess.icon;
  const apk = files.find((file) => /\.apk$/i.test(path.basename(file))) || '';
  const homeImage = imageGuess.homeImage;
  const coverImage = imageGuess.coverImage;
  const gallery = findGalleryImages(dir, files, { icon, homeImage, coverImage });
  const apkLink = getApkLink(data);
  const apkMode = apkLink ? '填写' : apk ? '上传' : '待补充';
  const validation = validateGame({ data, icon, apk, apkLink, gallery, homeImage, guessedAssets: imageGuess.guessed });

  return {
    id: safeId(`${dir}::${infoFileName}`),
    dir,
    name: data['游戏名称'] || path.basename(dir),
    infoFileName,
    infoPath,
    icon,
    iconUrl: icon ? `/api/file?path=${encodeURIComponent(icon)}` : '',
    apk,
    apkMode,
    apkLink,
    gallery,
    galleryCount: gallery.length,
    homeImage,
    coverImage,
    guessedAssets: imageGuess.guessed,
    data,
    missingFields: validation.missingFields,
    warnings: validation.warnings,
    blockingIssues: validation.blockingIssues,
  };
}

function validateGame(game) {
  const missingFields = [];
  const warnings = [];
  const blockingIssues = [];
  applyDefaultFields(game.data);
  const required = ['游戏名称', '游戏类型', '标签', '简介', '游戏介绍', '开测时间', '发布时间', '名称', '地区', '供应商', '统一社会信用代码', 'ICP备案号'];
  for (const key of required) {
    if (!String(game.data[key] || '').trim()) missingFields.push(key);
  }
  if (game.apkLink && !game.apk) blockingIssues.push('有 APK 链接，但缺少用于权限获取解析的本地 APK');
  if (!game.apkLink && !game.apk) blockingIssues.push('缺少 APK 下载链接或安装包');
  if (!game.icon) warnings.push('未找到 ICON 图标');
  if (game.guessedAssets?.icon) warnings.push(`未找到明确命名的 ICON，已按图片比例推测：${path.basename(game.icon)}`);
  if (game.guessedAssets?.homeImage) warnings.push(`未找到明确命名的首页大图，已按横图比例推测：${path.basename(game.homeImage)}`);
  if (!game.gallery.length) blockingIssues.push('缺少图集图片，请放入“图集”文件夹或使用 1.webp、2.webp 这类编号图片');
  if (!game.homeImage) warnings.push('未找到首页大图，已按非必填跳过');
  if (!getApkLink(game.data) && !game.apk) blockingIssues.push('APK 方式无法判断');
  return { missingFields, warnings, blockingIssues };
}

function applyDefaultFields(data) {
  if (!String(data['测试类型'] || '').trim()) data['测试类型'] = '公测';
  if (!String(data['下载状态'] || '').trim()) data['下载状态'] = '开启';
  if (!String(data['开发者类型'] || '').trim()) data['开发者类型'] = '企业开发者';
  if (!String(data['平台'] || '').trim()) data['平台'] = defaultPlatform(data);
  if (!String(data['合作方式'] || '').trim()) data['合作方式'] = defaultCooperation(data['平台']);
  if (/^无$/.test(String(data['合作方式'] || '').trim())) data['合作方式'] = '无合作';
  if (!Object.prototype.hasOwnProperty.call(data, '备注')) data['备注'] = '';
}

function defaultPlatform(data) {
  const text = Object.values(data || {}).join(' ');
  if (/九游/.test(text)) return '九游';
  if (/指趣/.test(text)) return '指趣';
  return '官方';
}

function defaultCooperation(platform) {
  if (/^官方$/.test(String(platform || '').trim())) return '无合作';
  if (/九游|指趣/.test(String(platform || ''))) return 'S';
  return '无合作';
}

function getApkLink(data) {
  const keys = ['填写', '链接', 'APK链接', 'APK下载链接', '下载链接', '下载地址', '安装包链接', '安装包下载链接'];
  for (const key of keys) {
    const value = String(data[key] || '').trim();
    if (/^https?:\/\//i.test(value)) return value;
  }
  return '';
}

function findGalleryImages(dir, files, knownImages) {
  const galleryDir = path.join(dir, '图集');
  if (existsSync(galleryDir) && safeIsDirectory(galleryDir)) {
    const fromFolder = readdirSync(galleryDir)
      .map((name) => path.join(galleryDir, name))
      .filter(isImage)
      .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
    if (fromFolder.length) return fromFolder;
  }

  const numbered = files
    .filter((file) => isImage(file) && /^\d+\./.test(path.basename(file)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  if (numbered.length) return numbered;

  const excluded = new Set(Object.values(knownImages).filter(Boolean).map((file) => path.resolve(file).toLowerCase()));
  return files
    .filter(isImage)
    .filter((file) => !excluded.has(path.resolve(file).toLowerCase()))
    .filter((file) => !/icon|图标|首页大图|专题封面/i.test(path.basename(file)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
}

function classifyImages(files) {
  const images = files.filter(isImage).map((file) => ({ file, size: readImageSize(file) }));
  const gifIcon = images.find(({ file }) => /\.gif$/i.test(path.basename(file)));
  const namedIcon = gifIcon
    || images.find(({ file }) => /^icon\.(png|jpg|jpeg|webp)$/i.test(path.basename(file)))
    || images.find(({ file }) => /icon|图标|头像|logo/i.test(path.basename(file)));
  const namedHome = images.find(({ file }) => /首页大图|大图|横幅|banner|banner图/i.test(path.basename(file)));
  const namedCover = images.find(({ file }) => /专题封面|封面/i.test(path.basename(file)));
  const used = new Set([namedIcon?.file, namedHome?.file, namedCover?.file].filter(Boolean));
  const square = images
    .filter(({ file }) => !used.has(file))
    .filter(({ size }) => size && size.width >= 96 && size.height >= 96)
    .map((item) => ({ ...item, score: Math.abs(item.size.width / item.size.height - 1) }))
    .sort((a, b) => a.score - b.score || path.basename(a.file).localeCompare(path.basename(b.file), 'zh-CN', { numeric: true }))[0];
  if (square) used.add(square.file);
  const wide = images
    .filter(({ file }) => !used.has(file))
    .filter(({ size }) => size && size.width / size.height >= 1.35)
    .sort((a, b) => (b.size.width * b.size.height) - (a.size.width * a.size.height))[0];
  return {
    icon: namedIcon?.file || square?.file || '',
    homeImage: namedHome?.file || wide?.file || '',
    coverImage: namedCover?.file || '',
    guessed: {
      icon: !namedIcon && Boolean(square),
      gifIcon: Boolean(gifIcon),
      homeImage: !namedHome && Boolean(wide),
    },
  };
}

function readImageSize(file) {
  try {
    const buffer = readFileSync(file);
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xFF) break;
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xC0 && marker <= 0xC3) return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        offset += 2 + length;
      }
    }
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
      if (buffer.toString('ascii', 12, 16) === 'VP8X') {
        return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
      }
      if (buffer.toString('ascii', 12, 16) === 'VP8 ') {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      }
      if (buffer.toString('ascii', 12, 16) === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {}
  return null;
}

function isImage(file) {
  return /\.(png|jpe?g|webp|gif)$/i.test(file);
}

function summarizeGames(games) {
  return {
    total: games.length,
    ready: games.filter((game) => game.blockingIssues.length === 0).length,
    needFix: games.filter((game) => game.blockingIssues.length > 0 || game.missingFields.length > 0).length,
  };
}

function emptySummary() {
  return { total: 0, ready: 0, needFix: 0 };
}

function findInfoFiles(dir) {
  return readdirSync(dir)
    .filter((name) => /^游戏资料.*\.txt$/i.test(name))
    .filter((name) => !/元素/.test(name));
}

function chooseInfoFile(dir, names) {
  const linked = names.find((name) => {
    const text = readFileSync(path.join(dir, name), 'utf8');
    return /(?:填写|链接|APK链接|APK下载链接|下载链接|下载地址|安装包链接|安装包下载链接)：\s*https?:\/\//.test(text);
  });
  if (linked) return linked;
  if (names.includes('游戏资料.txt')) return '游戏资料.txt';
  return names.sort((left, right) => left.localeCompare(right, 'zh-CN'))[0];
}

function parseInfo(text) {
  const data = {};
  let currentKey = null;
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([^：:]+)[：:]\s*(.*)$/);
    if (match) {
      currentKey = match[1].trim();
      data[currentKey] = match[2].trim();
    } else if (currentKey) {
      data[currentKey] = `${data[currentKey]}\n${line}`.trim();
    }
  }
  normalizeInfoAliases(data);
  return data;
}

function normalizeInfoAliases(data) {
  const aliases = {
    游戏名称: ['游戏名', '游戏'],
    游戏类型: ['类型', '游戏分类', '分类'],
    适龄等级: ['适龄', '年龄', '年龄等级', '适龄提示'],
    简介: ['游戏简介', '短简介', '一句话简介'],
    游戏介绍: ['介绍', '详情', '游戏详情', '描述'],
    标签: ['游戏标签', 'tag', 'tags'],
    平台: ['渠道', '平台名称'],
    合作方式: ['合作', '合作类型'],
    填写: ['链接', 'APK链接', 'APK下载链接', '下载链接', '下载地址'],
  };
  for (const [target, keys] of Object.entries(aliases)) {
    if (data[target]) continue;
    const key = keys.find((item) => data[item]);
    if (key) data[target] = data[key];
  }
}

function saveGameInfo(body) {
  if (!body.infoPath || !existsSync(body.infoPath)) throw new Error('资料文件不存在，无法保存。');
  const original = buildGameRecord(path.dirname(body.infoPath), path.basename(body.infoPath));
  const merged = { ...original.data, ...(body.data || {}) };
  const content = serializeInfo(merged);
  writeFileSync(body.infoPath, content, 'utf8');
  return buildGameRecord(path.dirname(body.infoPath), path.basename(body.infoPath));
}

function serializeInfo(data) {
  const order = [
    '游戏名称', '游戏类型', '标签', '游戏副标题', '副标题生效时间', '适龄等级', '简介', '游戏介绍',
    '测试类型', '开测时间', '发布时间', '下载状态',
    '安装包管理', '填写', '平台', '合作方式',
    '开发者类型', '名称', '地区', '供应商', '统一社会信用代码', 'ICP备案号',
    '备注',
  ];
  const lines = [];
  for (const key of order) {
    if (key === '开发者类型' || key === '安装包管理') {
      lines.push(`${key}：${data[key] || ''}`);
      continue;
    }
    if (key === '填写' && !String(data[key] || '').trim()) {
      lines.push('填写：');
      continue;
    }
    lines.push(`${key}：${data[key] || ''}`);
    if (['游戏介绍', '下载状态', '合作方式'].includes(key)) lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

async function runImportQueue(config) {
  state.running = true;
  state.mode = config.submit ? '\u6b63\u5f0f\u6267\u884c' : '\u6267\u884c\u4e0d\u63d0\u4ea4';
  state.logs = [];
  state.startedAt = new Date().toISOString();
  state.lastResult = null;
  state.source = config.source;
  state.csvPath = registrationCsvPath(config.source);
  state.taskLogPath = path.join(toolRoot, '\u5bfc\u5165\u7ed3\u679c', `\u4efb\u52a1\u65e5\u5fd7-${timestampForFile()}.txt`);
  state.currentGame = '';
  state.progress = { total: config.selectedGames.length, current: 0, active: 0, currentName: '' };
  state.reviewOnFinish = false;
  stopRequested = false;
  let hadFailure = false;
  let successCount = 0;
  let failureCount = 0;
  let disconnected = false;
  const concurrency = 1;

  appendLog(`\u5df2\u51c6\u5907\u5f00\u59cb\uff0c\u5171 ${config.selectedGames.length} \u4e2a\u6e38\u620f\u3002`);
  appendLog(`\u5f53\u524d\u6a21\u5f0f\uff1a${state.mode}`);
  appendLog('执行方式：顺序执行');
  appendLog(`APK \u94fe\u63a5\u9ed8\u8ba4\u4f1a\u6267\u884c\u6743\u9650\u83b7\u53d6\uff1a${config.fetchApkInDryRun ? '\u662f' : '\u5426'}`);

  try {
    const browserInfo = await ensureCurrentBrowser();
    state.loginInfo = browserInfo;
    appendLog(browserInfo.message);
    if (!browserInfo.ok) {
      appendLog('\u4efb\u52a1\u672a\u5f00\u59cb\uff1a\u8bf7\u5148\u70b9\u51fb\u767b\u5f55\u5165\u53e3\u6253\u5f00\u540e\u53f0\u5e76\u5b8c\u6210\u767b\u5f55\u3002');
      finishTask(1);
      return;
    }
    if (!(await canConnectCdp())) {
      appendLog('\u540e\u53f0\u7a97\u53e3\u5df2\u65ad\u5f00\uff0c\u4efb\u52a1\u672a\u5f00\u59cb\u3002');
      finishTask(1, { successCount, failureCount, disconnected: true, message: '\u540e\u53f0\u7a97\u53e3\u5df2\u65ad\u5f00' });
      return;
    }
    if (config.submit) await hideAutomationBrowserWindow();
    const pending = config.selectedGames.map((game, index) => ({ game, index }));
    let completedCount = 0;
    let nextWorkerId = 1;

    const runWorker = async (workerId) => {
      while (!stopRequested && !disconnected) {
        const item = pending.shift();
        if (!item) return;
        if (!(await canConnectCdp())) {
          disconnected = true;
          appendLog('\u540e\u53f0\u7a97\u53e3\u5df2\u65ad\u5f00\uff0c\u5df2\u505c\u6b62\u540e\u7eed\u6e38\u620f\u6267\u884c\u3002');
          return;
        }
        const { game, index } = item;
        state.reviewOnFinish = true;
        state.progress = {
          total: config.selectedGames.length,
          current: completedCount,
          active: index + 1,
          currentName: game.name,
        };
        state.currentGame = `正在处理：${index + 1}/${config.selectedGames.length} ${game.name}`;
        appendLog(`开始处理 ${index + 1}/${config.selectedGames.length}：${game.name}`);
        appendLog(`APK \u65b9\u5f0f\uff1a${game.apkMode}${game.apkLink ? '\uff08\u5df2\u4f18\u5148\u4f7f\u7528\u94fe\u63a5\uff09' : ''}`);

        const result = await runSingleGameImport(game, config, workerId);
        const row = buildRegistrationRow(game, result);
        writeRegistrationRow(config.source, row);
        completedCount += 1;
        state.progress = {
          total: config.selectedGames.length,
          current: completedCount,
          active: Math.min(completedCount + 1, config.selectedGames.length),
          currentName: game.name,
        };

        if (result.code === 0) {
          successCount += 1;
          appendLog(`\u5df2\u5b8c\u6210\uff1a${game.name}${row['\u6e38\u620fID'] ? `\uff0c\u6e38\u620fID\uff1a${row['\u6e38\u620fID']}` : ''}\uff0c\u663e\u793a\u72b6\u6001\uff1a${row['\u663e\u793a\u72b6\u6001'] || '\u672a\u663e\u793a'}`);
        } else {
          if (isBrowserDisconnectedResult(result)) {
            disconnected = true;
            failureCount += 1;
            appendLog(`\u5904\u7406\u5931\u8d25\uff1a${game.name}\uff0c\u539f\u56e0\uff1a\u540e\u53f0\u7a97\u53e3\u5df2\u65ad\u5f00`);
            return;
          }
          hadFailure = true;
          failureCount += 1;
          appendLog(`\u5904\u7406\u5931\u8d25\uff1a${game.name}${result.summary ? `\uff0c\u539f\u56e0\uff1a${result.summary}` : ''}`);
          appendLog('\u5df2\u8df3\u8fc7\u8be5\u6e38\u620f\uff0c\u7ee7\u7eed\u5904\u7406\u5176\u4ed6\u6e38\u620f\u3002');
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => runWorker(nextWorkerId++)));

    if (stopRequested) {
      appendLog('\u4efb\u52a1\u5df2\u505c\u6b62\u3002');
      finishTask(2, { successCount, failureCount });
    } else if (disconnected) {
      appendLog('\u540e\u53f0\u7a97\u53e3\u5df2\u65ad\u5f00\uff0c\u5df2\u505c\u6b62\u672a\u5f00\u59cb\u7684\u6e38\u620f\u3002');
      finishTask(1, { successCount, failureCount, disconnected: true, message: '\u540e\u53f0\u7a97\u53e3\u5df2\u65ad\u5f00' });
    } else if (hadFailure) {
      appendLog(`\u5168\u90e8\u4efb\u52a1\u5df2\u6267\u884c\u5b8c\u6210\uff0c\u5176\u4e2d\u6210\u529f ${successCount} \u4e2a\uff0c\u5931\u8d25 ${failureCount} \u4e2a\u3002`);
      finishTask(1, { successCount, failureCount });
    } else {
      appendLog('\u5168\u90e8\u4efb\u52a1\u5df2\u6267\u884c\u5b8c\u6210\u3002');
      finishTask(0, { successCount, failureCount });
    }
  } catch (error) {
    appendLog(`\u4efb\u52a1\u5f02\u5e38\u4e2d\u6b62\uff1a${String(error?.message || error)}`);
    finishTask(1, { successCount, failureCount });
  } finally {
    currentChildren.clear();
    state.currentGame = '';
  }
}
function runSingleGameImport(game, config, workerId = 1) {
  return new Promise((resolve) => {
    const noProgressTimeoutMs = Number(process.env.GAME_IMPORTER_NO_PROGRESS_TIMEOUT_MS || 180000);
    const args = [
      importScript,
      '--current-browser',
      '--cdp-url', cdpUrl,
      '--source', game.dir,
      '--info-file', game.infoFileName,
      '--session-dir', sessionDir,
      '--new-page',
    ];
    if (config.submit) args.push('--submit');
    if (config.uploadInDryRun) args.push('--upload-in-dry-run');
    if (config.fetchApkInDryRun) args.push('--fetch-apk-in-dry-run');
    if (config.noAutoShow) args.push('--no-auto-show');

    const child = spawn(process.execPath, args, {
      cwd: toolRoot,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    currentChildren.add(child);
    const hideAutomationTimer = config.submit ? startAutomationBrowserHider() : null;

    let settled = false;
    let lastProgress = '';
    let importEntry = null;
    let stdout = '';
    let stderr = '';
    let noProgressTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(noProgressTimer);
      if (hideAutomationTimer) clearInterval(hideAutomationTimer);
      currentChildren.delete(child);
      resolve(result);
    };

    const resetNoProgressTimer = () => {
      if (settled) return;
      clearTimeout(noProgressTimer);
      noProgressTimer = setTimeout(() => {
        const reason = `超过 ${Math.round(noProgressTimeoutMs / 1000)} 秒没有新的执行进度，已自动暂停。最后进度：${lastProgress || '尚未输出进度'}`;
        appendLog(reason);
        stderr += `\n${reason}`;
        child.kill();
        finish({ code: 124, summary: reason, entry: importEntry, stdout });
      }, noProgressTimeoutMs);
    };

    const consumeLines = (chunk, onLine) => {
      String(chunk || '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach(onLine);
    };

    resetNoProgressTimer();

    child.stdout.on('data', (data) => {
      stdout += data.toString();
      consumeLines(data, (line) => {
        if (line.startsWith('__GAME_IMPORT_RESULT__')) {
          try {
            importEntry = JSON.parse(line.slice('__GAME_IMPORT_RESULT__'.length));
            finish({
              code: isSuccessfulImportEntry(importEntry) ? 0 : 1,
              summary: importEntry.error || '',
              entry: importEntry,
              stdout,
            });
            child.kill();
          } catch {}
          return;
        }
        const clean = line.replace(/^\[[^\]]+\]\s*/, '');
        lastProgress = clean;
        appendProgressLog(clean);
      });
      resetNoProgressTimer();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
      consumeLines(data, (line) => {
        const clean = summarizeFailure(line) || line;
        if (clean) appendLog(`错误提示：${game.name}：${clean}`);
      });
      resetNoProgressTimer();
    });

    child.on('error', (error) => {
      finish({ code: 1, summary: `启动导入脚本失败：${String(error?.message || error)}` });
    });

    child.on('close', (code) => {
      if (stopRequested) {
        finish({ code: 2, summary: '任务已停止', stdout });
        return;
      }
      finish({
        code: code ?? 0,
        summary: summarizeFailure(stderr) || summarizeProgressFailure(stdout),
        entry: importEntry,
        stdout,
      });
    });
  });
}

function summarizeFailure(stderr) {
  const lines = String(stderr || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== '^')
    .filter((line) => line !== 'Browser logs:')
    .filter((line) => !/^<launching>|^<launched>|^- <launching>|^- <launched>|^\[pid=/.test(line))
    .filter((line) => !/^at /.test(line))
    .filter((line) => !/node:internal|triggerUncaughtException|Node\.js|browserContext\.close|Target page, context or browser has been closed/i.test(line));
  if (lines.some((line) => /GHZS_ADMIN_USER|GHZS_ADMIN_PASS|独立静默浏览器尚未登录/.test(line))) {
    return '独立静默浏览器尚未登录，请先点击登录入口完成一次后台登录后再执行。';
  }
  const cdpError = lines.find((line) => /ECONNREFUSED.*9222|connectOverCDP/i.test(line));
  if (cdpError) return '自动执行浏览器连接已断开，请点击“打开后台窗口”重新登录后再执行。';
  const usefulError = lines.find((line) => /原因[:：]|步骤失败|提交后页面出现错误提示|找不到|超时|失败/i.test(line));
  if (usefulError) return usefulError;
  const directError = lines.find((line) => /Error|失败|超时|找不到|Cannot|Timeout|ReferenceError|TypeError/i.test(line));
  if (directError && !/^name:\s*'Error'/.test(directError)) return directError;
  return lines[0] || '';
}

function summarizeProgressFailure(stdout) {
  const lines = String(stdout || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const failed = [...lines].reverse().find((line) => /步骤失败|步骤超时|失败：/.test(line));
  return failed ? failed.replace(/^\[[^\]]+\]\s*/, '') : '';
}

function isBrowserDisconnectedResult(result) {
  const text = `${result?.summary || ''}\n${result?.stdout || ''}`;
  return /后台窗口已断开|自动执行浏览器连接已断开|ECONNREFUSED.*9222|connectOverCDP|Target page, context or browser has been closed/i.test(text);
}

function appendProgressLog(line) {
  if (!line) return;
  if (/^开始：填写|^完成：填写|^开始：选择|^完成：选择/.test(line)) return;
  if (/^开始：|^完成：/.test(line) && !/上传|权限获取|提交|游戏ID|显示|APK|安装包|平台|合作方式|图集|图标/.test(line)) return;
  appendLog(line);
}

function writeRegistrationRow(source, row) {
  const csvPath = ensureRegistrationFile(source);
  appendFileSync(csvPath, `${registrationColumns.map((column) => csvCell(row[column] || '')).join(',')}\n`, 'utf8');
}

function ensureRegistrationFile(source) {
  const csvPath = registrationCsvPath(source);
  if (!csvPath) return '';
  mkdirSync(path.dirname(csvPath), { recursive: true });
  if (existsSync(csvPath)) {
    ensureRegistrationEncoding(csvPath, registrationColumns);
    return csvPath;
  }
  appendFileSync(csvPath, `\uFEFF${registrationColumns.join(',')}\n`, 'utf8');
  return csvPath;
}

function buildRegistrationRow(game, result) {
  const entry = result.entry || {};
  const gameId = entry.gameId || extractGameIdFromText(result.stdout || result.summary || '');
  const completed = result.code === 0 && gameId && !entry.error && !result.summary && !/failed|error/i.test(String(entry.status || ''));
  return {
    时间: formatLocalDateTime(entry.finishedAt || new Date()),
    游戏名称: game.name,
    游戏类型: entry.gameType || game.data['游戏类型'] || '',
    游戏ID: gameId,
    显示状态: normalizeShowStatus(entry.showStatus, Boolean(completed)),
    状态: completed ? '完成' : '失败',
    APK方式: entry.apkMode || game.apkMode,
    APK链接: entry.apkLink || game.apkLink || '',
    平台: entry.platform || game.data['平台'] || '',
    合作方式: entry.cooperation || game.data['合作方式'] || '',
    错误原因: completed ? '' : result.summary || entry.error || '执行链路未完整完成',
  };
}

function isSuccessfulImportEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.error) return false;
  if (/failed|error/i.test(String(entry.status || ''))) return false;
  return Boolean(entry.gameId);
}

function normalizeShowStatus(value, submitted) {
  const text = String(value || '');
  if (/已执行|成功|显示/.test(text) && !/跳过|未找到|失败|未显示/.test(text)) return '显示';
  return submitted ? '未显示' : '';
}

function extractGameIdFromText(text) {
  const match = String(text || '').match(/(?:游戏ID|gameId|ID)["'：:\s]*(\d{2,}|[a-f0-9]{16,})/i);
  return match?.[1] || '';
}

function formatLocalDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function readRegistration(source) {
  const csvPath = registrationCsvPath(source);
  if (!csvPath || !existsSync(csvPath)) return { csvPath, exists: false, rows: [], updatedAt: '' };
  ensureRegistrationEncoding(csvPath, registrationColumns);
  const raw = readRegistrationText(csvPath).replace(/^\uFEFF/, '');
  return {
    csvPath,
    exists: true,
    rows: parseCsv(raw).map(normalizeRegistrationRow),
    updatedAt: new Date().toISOString(),
  };
}

function importedGameNames(source) {
  const data = readRegistration(source);
  return new Set((data.rows || [])
    .filter(isSuccessfulRegistrationRow)
    .map((row) => String(row.游戏名称 || '').trim())
    .filter(Boolean));
}

function removeImportedGame(source, gameName) {
  const name = String(gameName || '').trim();
  if (!name) throw new Error('缺少要移除的游戏名称。');
  const csvPath = registrationCsvPath(source);
  if (!csvPath || !existsSync(csvPath)) return 0;
  ensureRegistrationEncoding(csvPath, registrationColumns);
  const raw = readRegistrationText(csvPath).replace(/^\uFEFF/, '');
  const rows = parseCsv(raw);
  let removed = 0;
  const kept = rows.filter((row) => {
    const matched = String(row.游戏名称 || '').trim() === name && isSuccessfulRegistrationRow(row);
    if (matched) removed += 1;
    return !matched;
  });
  const lines = [
    `\uFEFF${registrationColumns.join(',')}`,
    ...kept.map((row) => registrationColumns.map((column) => csvCell(row[column] || '')).join(',')),
  ];
  writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf8');
  return removed;
}

function deleteRegistrationRows(source, rowIndexes) {
  const indexes = [...new Set((Array.isArray(rowIndexes) ? rowIndexes : [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0))];
  if (!indexes.length) throw new Error('请先选择要删除的登记信息。');
  const csvPath = registrationCsvPath(source);
  if (!csvPath || !existsSync(csvPath)) return 0;
  ensureRegistrationEncoding(csvPath, registrationColumns);
  const raw = readRegistrationText(csvPath).replace(/^\uFEFF/, '');
  const rows = parseCsv(raw);
  const removeSet = new Set(indexes);
  const kept = rows.filter((_, index) => !removeSet.has(index));
  const removed = rows.length - kept.length;
  const headers = rows.length ? Object.keys(rows[0]) : registrationColumns;
  const lines = [
    `\uFEFF${headers.join(',')}`,
    ...kept.map((row) => headers.map((column) => csvCell(row[column] || '')).join(',')),
  ];
  writeFileSync(csvPath, `${lines.join('\n')}\n`, 'utf8');
  return removed;
}

function isSuccessfulRegistrationRow(row) {
  const status = String(row.状态 || row.status || '').trim();
  const gameId = String(row.游戏ID || row.gameId || '').trim();
  const error = String(row.错误原因 || row.error || '').trim();
  if (/失败|异常|未完成|跳过/.test(status)) return false;
  return status === '完成' && Boolean(gameId) && !error;
}

function registrationCsvPath(source) {
  const root = findGameDataRoot(source || defaultGameDataRoot);
  return root ? path.join(root, registrationFileName) : '';
}

function findGameDataRoot(source) {
  const resolved = path.resolve(source || defaultGameDataRoot);
  const marker = `${path.sep}游戏资料`;
  const index = resolved.lastIndexOf(marker);
  if (index >= 0) return resolved.slice(0, index + marker.length);
  if (path.basename(resolved) === '游戏资料') return resolved;
  return existsSync(defaultGameDataRoot) ? defaultGameDataRoot : resolved;
}

function normalizeRegistrationRow(row) {
  return {
    ...row,
    时间: row.时间 || row.完成时间 || '',
    显示状态: normalizeShowStatus(row.显示状态, row.状态 === '完成' || Boolean(row.游戏ID)),
  };
}

function readRegistrationText(csvPath) {
  const bytes = readFileSync(csvPath);
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return bytes.toString('utf8');
  const lines = splitBufferLines(bytes);
  if (lines.length > 1) return lines.map(decodeCsvLineBuffer).join('\n');
  const utf8 = decodeCsvLineBuffer(bytes);
  if (!utf8.includes('�') && !/���/.test(utf8)) return utf8;
  try {
    return new TextDecoder('gb18030').decode(bytes);
  } catch {
    return utf8;
  }
}

function splitBufferLines(buffer) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0A) continue;
    let end = index;
    if (end > start && buffer[end - 1] === 0x0D) end -= 1;
    lines.push(buffer.subarray(start, end));
    start = index + 1;
  }
  if (start < buffer.length) lines.push(buffer.subarray(start));
  return lines;
}

function decodeCsvLineBuffer(buffer) {
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('gb18030').decode(buffer);
  } catch {
    return utf8;
  }
}

function ensureRegistrationEncoding(csvPath, columns) {
  if (!existsSync(csvPath)) return;
  const bytes = readFileSync(csvPath);
  const text = readRegistrationText(csvPath).replace(/^\uFEFF/, '');
  const rows = parseCsv(text);
  const currentHeaders = text.split(/\r?\n/, 1)[0]?.split(',').map((item) => item.replace(/^"|"$/g, '')) || [];
  const alreadyCurrent = bytes[0] === 0xEF
    && bytes[1] === 0xBB
    && bytes[2] === 0xBF
    && columns.every((column, index) => currentHeaders[index] === column);
  if (alreadyCurrent) return;
  if (!rows.length) {
    writeFileSync(csvPath, `\uFEFF${columns.join(',')}\n`, 'utf8');
    return;
  }
  const allColumns = [...new Set([...columns, ...Object.keys(rows[0]).filter((column) => column !== '完成时间')])];
  const content = [
    allColumns.join(','),
    ...rows.map((row) => allColumns.map((column) => csvCell(column === '时间' ? (row[column] || row['完成时间'] || '') : row[column] || '')).join(',')),
  ].join('\n');
  writeFileSync(csvPath, `\uFEFF${content}\n`, 'utf8');
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] || '']));
  });
}

function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function stopCurrentTask() {
  stopRequested = true;
  for (const child of currentChildren) {
    try { child.kill(); } catch {}
  }
  currentChildren.clear();
  void closeAutomationPages();
  appendLog('已发送停止请求。');
}

function finishTask(code, extra = {}) {
  state.running = false;
  state.lastResult = {
    code,
    finishedAt: new Date().toISOString(),
    csvPath: state.csvPath,
    taskLogPath: state.taskLogPath,
    ...extra,
  };
  state.reviewOnFinish = false;
  if (state.startedAt) void closeAutomationPages();
}

async function hideAutomationBrowserWindow() {
  try {
    const targets = await getCdpJson('/json/list').catch(() => []);
    const target = targets.find((item) => String(item.url || '').includes('and-admin.ghzs.com')) || targets[0];
    if (!target?.id) return;
    await setWindowBoundsViaWebSocket(target.id, { left: -32000, top: -32000, width: 1440, height: 960 });
    appendLog('执行浏览器已切换到后台运行。');
  } catch (error) {
    appendLog(`后台运行提示：${String(error?.message || error)}`);
  }
}

function startAutomationBrowserHider() {
  let logged = false;
  const hideQuietly = async () => {
    try {
      const targets = await getCdpJson('/json/list').catch(() => []);
      const adminTarget = targets.find((item) => String(item.url || '').includes('and-admin.ghzs.com')) || targets[0];
      if (!adminTarget?.id) return;
      await setWindowBoundsViaWebSocket(adminTarget.id, { left: -32000, top: -32000, width: 1440, height: 960 });
      if (!logged) {
        logged = true;
        appendLog('执行浏览器已保持后台运行。');
      }
    } catch {}
  };
  void hideQuietly();
  return setInterval(hideQuietly, 1200);
}

async function setWindowBoundsViaWebSocket(targetId, bounds) {
  const version = await getCdpJson('/json/version').catch(() => null);
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl) return;
  const WebSocket = globalThis.WebSocket;
  if (!WebSocket) return;
  await new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    let nextId = 1;
    let windowId = null;
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      try { socket.close(); } catch {}
      resolve();
    };
    const send = (method, params = {}) => socket.send(JSON.stringify({ id: nextId++, method, params }));
    socket.onopen = () => send('Browser.getWindowForTarget', { targetId });
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data || '{}'));
      if (message.result?.windowId && !windowId) {
        windowId = message.result.windowId;
        send('Browser.setWindowBounds', { windowId, bounds });
      } else if (windowId && message.id >= 2) {
        done();
      }
    };
    socket.onerror = done;
    socket.onclose = done;
    setTimeout(done, 3000);
  });
}

async function cleanupAndOpenReviewPage() {
  try {
    await closeAutomationPages();
    openReviewBrowserWindow();
    appendLog('已关闭自动执行窗口，并打开游戏信息页面供核对。');
  } catch (error) {
    appendLog(`任务收尾提示：${String(error?.message || error)}`);
  }
}

async function closeAutomationPages() {
  const targets = await getCdpJson('/json/list').catch(() => []);
  for (const target of targets) {
    if (!target?.id || !String(target.url || '').includes('and-admin.ghzs.com')) continue;
    await getCdpJson(`/json/close/${target.id}`).catch(() => {});
  }
}

function getCdpJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${cdpUrl}${pathname}`, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch {
          resolve(text);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error('CDP 请求超时'));
    });
  });
}

function openReviewBrowserWindow() {
  const executablePath = findBrowserExecutable();
  if (!executablePath) return;
  const child = spawn(executablePath, [
    '--new-window',
    'https://and-admin.ghzs.com/#/games-manage/games-info?href=games_info_menu',
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

function appendLog(message) {
  state.logs.push(message);
  if (state.logs.length > 300) state.logs = state.logs.slice(-300);
  if (state.taskLogPath) {
    mkdirSync(path.dirname(state.taskLogPath), { recursive: true });
    appendFileSync(state.taskLogPath, `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}\n`, 'utf8');
  }
}

function timestampForFile() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
}

function runJsonCommand(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: toolRoot,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('close', (code) => {
      let data = null;
      try {
        data = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        data = null;
      }
      resolve({ code, data, stdout, stderr });
    });
  });
}

function selectFolder() {
  const command = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择游戏资料总文件夹'
$dialog.UseDescriptionForTitle = $true
$null = $dialog.ShowDialog()
if ($dialog.SelectedPath) {
  Write-Output $dialog.SelectedPath
}
`;

  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-Command', command], {
      windowsHide: false,
      cwd: toolRoot,
    });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.on('close', () => resolve(output.trim()));
    child.on('error', reject);
  });
}

function openPath(targetPath) {
  const escaped = String(targetPath).replace(/'/g, "''");
  const ps = `Start-Process -FilePath explorer.exe -ArgumentList @('${escaped}')`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-Command', ps], {
      windowsHide: true,
      cwd: toolRoot,
    });
    child.on('close', () => resolve());
    child.on('error', reject);
  });
}

function safeId(value) {
  return Buffer.from(String(value)).toString('base64url');
}

function safeFileName(value) {
  return String(value || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.csv': 'text/csv; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  }[ext] || 'application/octet-stream';
}

function safeIsDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}
