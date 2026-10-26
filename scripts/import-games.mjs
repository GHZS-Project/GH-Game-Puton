import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ADMIN_URL = 'https://and-admin.ghzs.com/#/games-manage/games-info?href=games_info_menu';
const SSO_HOST = 'sso.ghzs.com';

const args = parseArgs(process.argv.slice(2));
const source = path.resolve(args.source || 'E:/新建文件夹/游戏资料');
const submit = Boolean(args.submit);
const dryRun = !submit;
const canUpload = submit || Boolean(args['upload-in-dry-run']);
const canFetchApk = submit || Boolean(args['fetch-apk-in-dry-run']);
const manualLogin = Boolean(args['manual-login']);
const currentBrowser = Boolean(args['current-browser']);
const manualRecover = args['manual-recover'] !== 'false';
const noAutoShow = Boolean(args['no-auto-show']);
const newPage = Boolean(args['new-page']);
const headed = manualLogin ? true : !args.headless;
const stepTimeoutMs = Number(args['step-timeout-ms'] || 30000);

class StepTimeoutError extends Error {
  constructor(label, timeout) {
    super(`步骤超时：${label}，已等待 ${Math.round(timeout / 1000)} 秒`);
    this.name = 'StepTimeoutError';
  }
}

const root = path.resolve(import.meta.dirname, '..');
const outputDir = path.join(root, '导入结果');
const screenshotDir = path.join(outputDir, '失败截图');
mkdirSync(screenshotDir, { recursive: true });
const jsonlPath = path.join(outputDir, '导入结果明细.jsonl');
const csvPath = path.join(outputDir, '导入登记表.csv');
const sessionDir = path.resolve(args['session-dir'] || path.join(root, '浏览器登录状态'));

const user = process.env.GHZS_ADMIN_USER;
const pass = process.env.GHZS_ADMIN_PASS;

const typeMap = new Map([
  ['网络游戏', '网游游戏'],
  ['网游', '网游游戏'],
  ['单机', '单机游戏'],
  ['单机游戏', '单机游戏'],
  ['福利游戏', '福利游戏'],
  ['gj单机', 'gj单机'],
  ['gj网游', 'gj网游'],
  ['模拟器游戏', '模拟器游戏'],
]);

const statusMap = new Map([
  ['开启', '开启'],
  ['打开', '开启'],
  ['关闭', '关闭'],
  ['预约', '预约'],
  ['试玩', '试玩'],
  ['H5链接', 'H5链接'],
  ['H5', 'H5链接'],
]);

const validTestTypes = ['公测', '不删档内测', '删档内测', 'demo'];
const validDeveloperTypes = ['企业开发者', '个人开发者'];
const validPlatforms = ['九游', '官方', '小米', '百度', '果盘', '当乐', '指趣', 'TT语音', '360', '安锋', '偶玩', '联想', '汉风', '说玩', '游戏fan', '乐游', '猎宝', '应用宝', '熊猫玩', '乐嗨嗨', 'igs', '优趣'];
const validCooperations = ['无合作', 'S', 'A', 'D'];

const games = discoverGames(source);
if (!games.length) throw new Error(`没有找到游戏资料：${source}`);

const browser = currentBrowser
  ? await chromium.connectOverCDP(args['cdp-url'] || 'http://127.0.0.1:9222')
  : null;
const context = currentBrowser
  ? (browser.contexts()[0] || await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true }))
  : await chromium.launchPersistentContext(sessionDir, {
      channel: 'msedge',
      headless: !headed,
      viewport: { width: 1440, height: 960 },
      acceptDownloads: true,
      args: ['--disable-extensions', '--disable-sync', '--no-first-run'],
    });
const page = currentBrowser && newPage ? await context.newPage() : currentBrowser ? await getOrCreateAdminPage(context) : context.pages()[0] || await context.newPage();
let failures = 0;

try {
  await login(page);
  for (let index = 0; index < games.length; index += 1) {
    const game = games[index];
    const startedAt = new Date().toISOString();
    progress(`开始处理 ${index + 1}/${games.length}：${game.data['游戏名称'] || game.dirName}`);
    try {
      const result = await importOne(page, game);
      const entry = {
        game: game.data['游戏名称'] || game.dirName,
        status: dryRun ? 'test-filled' : 'submitted',
        apkMode: result.apkMode,
        apkLink: result.apkLink,
        packageName: result.packageName,
        version: result.version,
        size: result.size,
        apkFetchStatus: result.apkFetchStatus,
        apkFetchMessage: result.apkFetchMessage,
        gameId: result.gameId,
        showStatus: result.showStatus,
        platform: normalizePlatform(game.data['平台']),
        cooperation: normalizeCooperation(game.data['合作方式'], game.data['平台']),
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      record(entry);
      console.log(`__GAME_IMPORT_RESULT__${JSON.stringify(entry)}`);
      progress(`完成：${entry.game} -> ${entry.status}`);
    } catch (error) {
      failures += 1;
      const shot = path.join(screenshotDir, `${safeName(game.data['游戏名称'] || game.dirName)}-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      const entry = { game: game.data['游戏名称'] || game.dirName, status: 'failed', error: String(error?.message || error), screenshot: shot, startedAt, finishedAt: new Date().toISOString() };
      record(entry);
      progress(`失败：${entry.game} -> ${entry.error}`);
      await closeAddDialog(page).catch(() => {});
    }
  }
} finally {
  if (!args.keepOpen) {
    if (currentBrowser) await page.close().catch(() => {});
    if (!currentBrowser) await context.close();
    if (browser && !currentBrowser) await browser.close().catch(() => {});
  }
}

if (failures > 0) process.exitCode = 1;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item.startsWith('--')) {
      const key = item.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

function discoverGames(sourcePath) {
  if (!existsSync(sourcePath)) throw new Error(`资料路径不存在：${sourcePath}`);
  if (statSync(sourcePath).isFile()) return [readGameDir(path.dirname(sourcePath), path.basename(sourcePath))];
  const infoFile = args['info-file'] || '游戏资料.txt';
  if (existsSync(path.join(sourcePath, infoFile))) return [readGameDir(sourcePath, infoFile)];

  return readdirSync(sourcePath)
    .map((name) => path.join(sourcePath, name))
    .filter((entry) => statSync(entry).isDirectory() && existsSync(path.join(entry, infoFile)))
    .map((entry) => readGameDir(entry, infoFile));
}

function readGameDir(dir, infoFile = '游戏资料.txt') {
  const data = parseInfo(readFileSync(path.join(dir, infoFile), 'utf8'));
  const files = readdirSync(dir).map((name) => path.join(dir, name));
  const imageGuess = classifyImages(files);
  const icon = imageGuess.icon;
  const homeImage = imageGuess.homeImage;
  const coverImage = imageGuess.coverImage;
  const gallery = findGalleryImages(dir, files, { icon, homeImage, coverImage });

  return {
    dir,
    dirName: path.basename(dir),
    infoFile,
    data,
    icon,
    gallery: gallery.sort(naturalCompare),
    homeImage,
    coverImage,
    apk: files.find((file) => /\.apk$/i.test(file)),
  };
}

function findGalleryImages(dir, files, knownImages) {
  const galleryDir = path.join(dir, '图集');
  if (existsSync(galleryDir) && statSync(galleryDir).isDirectory()) {
    const fromFolder = readdirSync(galleryDir)
      .map((name) => path.join(galleryDir, name))
      .filter(isImage)
      .sort(naturalCompare);
    if (fromFolder.length) return fromFolder;
  }

  const excluded = new Set(Object.values(knownImages).filter(Boolean).map((file) => path.resolve(file).toLowerCase()));
  const folderImages = files
    .filter(isImage)
    .filter((file) => !excluded.has(path.resolve(file).toLowerCase()))
    .filter((file) => !/icon|图标|首页大图|专题封面/i.test(path.basename(file)))
    .sort(naturalCompare);
  if (folderImages.length) return folderImages;

  return files
    .filter(isImage)
    .filter((file) => !excluded.has(path.resolve(file).toLowerCase()))
    .filter((file) => !/icon|图标|首页大图|专题封面/i.test(path.basename(file)))
    .sort(naturalCompare);
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
    .sort((a, b) => a.score - b.score || naturalCompare(a.file, b.file))[0];
  if (square) used.add(square.file);
  const wide = images
    .filter(({ file }) => !used.has(file))
    .filter(({ size }) => size && size.width / size.height >= 1.35)
    .sort((a, b) => (b.size.width * b.size.height) - (a.size.width * a.size.height))[0];
  return {
    icon: namedIcon?.file || square?.file || '',
    homeImage: namedHome?.file || wide?.file || '',
    coverImage: namedCover?.file || '',
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
      if (buffer.toString('ascii', 12, 16) === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
      if (buffer.toString('ascii', 12, 16) === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      if (buffer.toString('ascii', 12, 16) === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
  } catch {}
  return null;
}

function parseInfo(text) {
  const data = {};
  let currentKey = null;
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (currentKey) data[currentKey] += '\n';
      continue;
    }
    const match = line.match(/^([^：:]+)[：:]\s*(.*)$/);
    if (match) {
      currentKey = match[1].trim();
      data[currentKey] = match[2].trim();
    } else if (currentKey) {
      data[currentKey] += `${data[currentKey] ? '\n' : ''}${line}`;
    }
  }
  for (const key of Object.keys(data)) data[key] = data[key].trim();
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

function isImage(file) {
  return /\.(png|jpe?g|webp|gif)$/i.test(file);
}

function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-CN', { numeric: true });
}

async function login(page) {
  await cleanupBlockingOverlays(page).catch(() => {});
  if (!page.url().includes('/games-manage/games-info')) {
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForTimeout(1500);
  if (manualLogin || currentBrowser) {
    if (new URL(page.url()).host === SSO_HOST || /Authelia/i.test(await page.title())) {
      progress('请在打开的浏览器窗口中手动登录后台，登录成功后工具会继续执行');
      await page.waitForURL((url) => url.host === 'and-admin.ghzs.com', { timeout: 300000 });
    }
    await openGamesInfo(page);
    return;
  }
  if (new URL(page.url()).host === SSO_HOST || /Authelia/i.test(await page.title())) {
    if (!user || !pass) {
      throw new Error('独立静默浏览器尚未登录，请先点击“检查登录状态/登录入口”完成一次登录后再执行。');
    }
    await page.fill('input[name="username"], input[autocomplete="username"], input[type="text"]', user);
    await page.fill('input[name="password"], input[autocomplete="current-password"], input[type="password"]', pass);
    await page.click('button:has-text("SIGN IN"), button[type="submit"]');
    await page.waitForURL((url) => url.host === 'and-admin.ghzs.com', { timeout: 60000 });
  }
  await openGamesInfo(page);
}

async function getOrCreateAdminPage(context) {
  const pages = context.pages();
  const page = pages.find((item) => item.url().includes('and-admin.ghzs.com')) || pages[0] || await context.newPage();
  await page.bringToFront().catch(() => {});
  return page;
}

async function keepAutomationWindowOutOfTheWay(page) {
  const session = await page.context().newCDPSession(page);
  const { windowId } = await session.send('Browser.getWindowForTarget').catch(() => ({}));
  if (!windowId) return;
  await session.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: 2200, top: 80, width: 1280, height: 900, windowState: 'normal' },
  }).catch(() => {});
}

async function openGamesInfo(page) {
  await cleanupBlockingOverlays(page).catch(() => {});
  if (page.url().includes('/games-manage/games-info')) {
    const addButton = page.getByRole('button', { name: '添加游戏' });
    if (await addButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      progress('当前已在游戏信息页面，直接继续');
      return;
    }
  }

  await page.goto('https://and-admin.ghzs.com/#/welcome/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1000);
  if (!page.url().includes('/games-manage/games-info')) {
    const gameManageTitle = page.locator('.el-submenu__title').filter({ hasText: '游戏管理' }).first();
    if (await gameManageTitle.count()) {
      const infoLink = page.locator('a[href="#/games-manage/games-info?href=games_info_menu"]').filter({ hasText: '游戏信息' }).first();
      if (!(await infoLink.isVisible().catch(() => false))) await gameManageTitle.click();
      await infoLink.click();
    } else {
      await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' });
    }
  }
  await page.waitForSelector('button:has-text("添加游戏")', { timeout: 60000 });
}

async function importOne(page, game) {
  await cleanupBlockingOverlays(page).catch(() => {});
  await withStep(page, '打开游戏信息列表', () => openGamesInfo(page));
  await withStep(page, '点击添加游戏', () => page.getByRole('button', { name: '添加游戏' }).click());
  await withStep(page, '等待新增游戏表单出现', () => page.locator('.game-edit-form').or(page.getByText('基础信息设置')).first().waitFor({ state: 'visible', timeout: 30000 }), 35000);

  const data = game.data;
  applyDefaultImportFields(data);
  let apkResult = {};
  const apkConfig = getApkConfig(game);
  await withStep(page, '填写游戏名称', () => fillByLabel(page, '游戏名称', data['游戏名称']));
  await withStep(page, '选择游戏类型', () => selectByLabelStrict(page, '游戏类型', typeMap.get(data['游戏类型']) || data['游戏类型']));
  if (data['游戏副标题']) await withStep(page, '填写游戏副标题', () => fillByLabel(page, '游戏副标题', data['游戏副标题']));
  if (data['适龄等级']) await withStep(page, '选择适龄等级', () => selectByLabel(page, '适龄等级', data['适龄等级']));
  if (canUpload && game.icon) await withStep(page, '上传游戏图标', () => setFileByLabel(page, '游戏图标', game.icon), 120000);
  await withStep(page, '选择标签', () => applyTags(page, data['标签']));
  await withStep(page, '填写简介', () => fillByLabel(page, '简介', data['简介']));
  await withStep(page, '填写游戏介绍', () => fillByLabel(page, '游戏介绍', data['游戏介绍']));
  if (canUpload && game.gallery.length) await withStep(page, `上传图集（${game.gallery.length} 张）`, () => setFileByLabel(page, '图集', game.gallery), 180000);

  if (data['测试类型']) await withStep(page, '选择测试类型', () => selectByLabelStrict(page, '测试类型', normalizeChoice(data['测试类型'], validTestTypes, '公测')));
  await withStep(page, '填写开测时间', () => fillByLabel(page, '开测时间', normalizeDate(data['开测时间'])));
  await withStep(page, '填写发布时间', () => fillByLabel(page, '发布时间', normalizeDate(data['发布时间'])));
  if (data['下载状态']) await withStep(page, '选择下载状态', () => selectByLabelStrict(page, '下载状态', statusMap.get(data['下载状态']) || data['下载状态']));

  await withStep(page, '选择开发者类型', () => selectDeveloperType(page, normalizeChoice(data['开发者类型'], validDeveloperTypes, '企业开发者')));
  await withStep(page, '填写开发者名称', () => fillDeveloperField(page, '名称', data['名称']));
  await withStep(page, '填写地区', () => fillDeveloperField(page, '地区', data['地区']));
  await withStep(page, '填写供应商', () => fillDeveloperField(page, '供应商', data['供应商']));
  await withStep(page, '填写统一社会信用代码', () => fillDeveloperField(page, '统一社会信用代码', data['统一社会信用代码']));
  await withStep(page, '填写 ICP 备案号', () => fillDeveloperField(page, 'ICP备案号', data['ICP备案号']));

  if (canUpload && game.homeImage) await withStep(page, '上传首页大图', () => setFileByLabel(page, '首页大图', game.homeImage), 120000);
  if (canUpload && game.coverImage) await withStep(page, '上传专题封面图', () => setFileByLabel(page, '专题封面图', game.coverImage), 120000);
  if (apkConfig.link) {
    apkResult = await configureApk(page, game);
  } else if (apkConfig.mode.includes('上传')) {
    await withStep(page, '预设 APK 方式：上传', () => presetUploadApkMode(page));
  }

  if (dryRun) {
    if (!apkConfig.link && apkConfig.mode.includes('上传')) {
      progress('当前是测试执行：上传 APK 需要先保存游戏并进入详情页，因此本次不会上传 APK。正式导入时会在保存后自动进入详情页上传。');
    }
    progress('测试执行：表单和可测试上传步骤已完成，不点击最终提交保存');
    await page.waitForTimeout(1000);
    return apkResult;
  }

  await withStep(page, '点击提交并离开', () => page.getByRole('button', { name: '提交并离开' }).click());
  await withStep(page, '等待提交结果', () => waitForSubmitResult(page, 25000), 30000);
  await withStep(page, '关闭无关弹窗', () => cleanupUnrelatedOverlays(page), 10000);
  if (!apkConfig.link && apkConfig.mode.includes('上传')) {
    apkResult = await configureUploadedApkAfterSave(page, game);
  }
  const postSubmit = await withStep(page, '提交后获取游戏ID并处理显示状态', () => finalizeSubmittedGame(page, game), 45000)
    || { gameId: '', showStatus: noAutoShow ? '已跳过自己显示' : '未处理显示', postSubmitWarning: '已提交，但未获取到游戏ID' };
  return { ...apkResult, ...postSubmit };
}

async function configureApk(page, game) {
  const apkConfig = getApkConfig(game);
  const mode = apkConfig.mode;
  let apkFetchStatus = '';
  let apkFetchMessage = '';
  await withStep(page, '滚动到下载和安装包区域', () => scrollToSection(page, 'download-install'));
  progress(`APK方式：${mode}`);
  await withStep(page, `确认 APK 方式：${mode}`, () => ensureApkMode(page, mode));

  if (mode.includes('上传')) {
    if (!game.apk) throw new Error('资料中选择上传安装包，但没有找到 .apk 文件。');
    if (canUpload) {
      await withStep(page, '上传 APK 安装包', () => setFileByLabel(page, 'APK包', game.apk), 300000);
    } else {
      return { apkMode: mode };
    }
  } else if (apkConfig.link) {
    await withStep(page, '填写 APK 下载链接', () => fillByPlaceholder(page, '填写APK下载链接', apkConfig.link));
    if (canFetchApk) {
      progress('准备权限获取：已填写 APK 链接，本地 APK 仅用于解析包名、版本和包体大小，不作为安装包上传');
      if (game.apk) {
        progress(`权限获取解析文件：${game.apk}`);
      } else {
        progress('当前游戏文件夹未找到用于权限获取的 APK，稍后会暂停并请你手动选择 APK 后继续');
      }
      await withStep(page, '触发权限获取并选择本地 APK 解析信息', () => setApkPermissionFile(page, game.apk), 180000);
      const fetchResult = await withStep(page, '等待后台自动回填包名、版本和包体大小', () => waitForApkMetadata(page), 130000) || { status: 'manual', message: '已手动处理后继续' };
      apkFetchStatus = fetchResult.status;
      apkFetchMessage = fetchResult.message;
      if (fetchResult.status !== 'ok') {
        progress(`权限获取未完成：${fetchResult.message}`);
        if (submit) throw new Error(`权限获取失败：${fetchResult.message}`);
      }
    }
  }

  if (game.data['平台']) await withStep(page, '选择 APK 平台', () => selectApkField(page, '平台', game.data['平台']));
  if (game.data['合作方式']) await withStep(page, '选择 APK 合作方式', () => selectApkField(page, '合作方式', game.data['合作方式']));
  const metadata = await withStep(page, '读取 APK 回填信息', () => readApkMetadata(page).catch(() => ({}))) || {};
  return { apkMode: mode, apkLink: apkConfig.link || '', apkFetchStatus, apkFetchMessage, ...metadata };
}

async function presetUploadApkMode(page) {
  await scrollToSection(page, 'download-install');
  progress('未填写 APK 链接，新增页先把 APK 包方式切换为“上传”，保存后再进入详情页上传安装包');
  await ensureApkMode(page, '上传');
}

async function configureUploadedApkAfterSave(page, game) {
  if (!game.apk) throw new Error('资料中选择上传安装包，但没有找到 .apk 文件。');
  await withStep(page, '保存后打开游戏详情页', () => openSavedGameDetail(page, game), 60000);
  await withStep(page, '滚动到下载和安装包区域', () => scrollToSection(page, 'download-install'));
  if (canUpload) {
    await withStep(page, '打开安装包管理', () => openApkPackageManager(page), 60000);
    await withStep(page, '上传 APK 安装包并等待完成', () => uploadApkInPackageManager(page, game.apk), 420000);
  }
  const returnedToManagerList = await apkManagerListHasUploadedRow(page);
  if (returnedToManagerList) {
    if (game.data['平台']) await withStep(page, '确认上传包平台', () => ensureApkManagerTableField(page, '平台', game.data['平台']));
    if (game.data['合作方式']) await withStep(page, '确认上传包合作方式', () => ensureApkManagerTableField(page, '合作方式', game.data['合作方式']));
  } else {
    if (game.data['平台']) await withStep(page, '填写上传包平台', () => selectApkUploadAddDialogField(page, '平台', game.data['平台']));
    if (game.data['合作方式']) await withStep(page, '填写上传包合作方式', () => selectApkUploadAddDialogField(page, '合作方式', game.data['合作方式']));
  }
  const metadata = await withStep(page, '读取上传包信息', () => readApkManagerMetadata(page).catch(() => ({}))) || {};
  await withStep(page, '保存上传包信息并关闭弹窗', () => saveAndCloseApkPackageManager(page), 45000);
  await withStep(page, '保存安装包设置并离开详情页', () => submitAndLeaveAfterApkUpload(page), 70000);
  return { apkMode: '上传', apkLink: '', ...metadata };
}

async function ensureApkMode(page, mode) {
  const section = page.locator('.apk-info, .api-package-container').filter({ hasText: 'APK包' }).last();
  await section.waitFor({ state: 'visible', timeout: 10000 });
  const input = section.locator('.apk-option .el-select input[placeholder="请选择"], .apk-option input[name="label-select"]').first();
  await input.waitFor({ state: 'attached', timeout: 10000 });
  const current = (await input.inputValue().catch(() => '')).trim();
  if (current === mode) {
    progress(`APK方式已是${mode}，无需切换`);
    return;
  }
  if (mode === '填写' && !current) {
    progress('APK方式为空，页面默认按填写处理');
    return;
  }
  await selectByLabel(page, 'APK包', mode);
}

async function openApkPackageManager(page) {
  await scrollToSection(page, 'download-install');
  const button = await findApkManagerButton(page);
  await button.scrollIntoViewIfNeeded();
  await button.evaluate((node) => node.click()).catch(async () => button.click({ force: true }));
  await waitForApkManagerOpened(page);
}

async function findApkManagerButton(page) {
  const section = await findApkSection(page);
  const roleButton = section.getByRole('button', { name: /安装包管理|已设置/ }).first();
  if (await roleButton.isVisible().catch(() => false)) return roleButton;

  const marked = await page.evaluate(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    document.querySelectorAll('[data-game-importer-apk-manager]').forEach((node) => node.removeAttribute('data-game-importer-apk-manager'));
    const nodes = Array.from(document.querySelectorAll('button.el-button--success, .el-button.el-button--success, button, .el-button, a'))
      .filter(visible)
      .filter((node) => /安装包管理|已设置/.test((node.innerText || node.textContent || '').replace(/\s+/g, '')));
    for (const node of nodes) {
      const button = node.closest('button, .el-button, [role="button"], a') || node;
      if (!visible(button)) continue;
      const text = (button.innerText || button.textContent || '').replace(/\s+/g, '');
      if (!/安装包管理|已设置/.test(text)) continue;
      button.setAttribute('data-game-importer-apk-manager', 'true');
      return true;
    }
    return false;
  }).catch(() => false);
  if (marked) {
    const domButton = page.locator('[data-game-importer-apk-manager="true"]').last();
    if (await domButton.isVisible().catch(() => false)) return domButton;
  }

  const textButton = section.locator('button, .el-button, span, div').filter({ hasText: /安装包管理|已设置/ }).first();
  if (await textButton.isVisible().catch(() => false)) return textButton;
  throw new Error('详情页中找不到“安装包管理”按钮。');
}

async function waitForApkManagerOpened(page) {
  await page.waitForFunction(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('button, .el-button, a, span, div')).filter(visible);
    const hasUploadPackage = nodes.some((node) => /上传安装包/.test((node.innerText || node.textContent || '').replace(/\s+/g, '')));
    const hasHistoryTitle = nodes.some((node) => /历史版本|安装包管理/.test((node.innerText || node.textContent || '').replace(/\s+/g, '')));
    const stillOnlyEditPage = nodes.some((node) => /安装包管理/.test((node.innerText || node.textContent || '').replace(/\s+/g, '')))
      && !hasUploadPackage
      && document.querySelector('.game-edit-form, #download-install');
    return hasUploadPackage || (hasHistoryTitle && !stillOnlyEditPage && location.href.includes('package'));
  }, {}, { timeout: 30000 });
}

async function findApkSection(page) {
  const candidates = [
    page.locator('#download-install'),
    page.locator('.apk-info, .api-package-container').filter({ hasText: /安装包管理|APK包|权限获取|填写APK下载链接/ }).last(),
    page.locator('.el-form-item, section, div').filter({ hasText: /安装包管理/ }).last(),
  ];
  for (const candidate of candidates) {
    if (await candidate.isVisible({ timeout: 3000 }).catch(() => false)) return candidate;
  }
  throw new Error('详情页中找不到安装包区域，请确认是否已进入该游戏的编辑页。');
}

async function uploadApkInPackageManager(page, apkPath) {
  const dialog = apkManagerDialog(page);
  await dialog.waitFor({ state: 'visible', timeout: 30000 });
  const uploadButton = await findUploadPackageButton(page, dialog);
  await uploadButton.scrollIntoViewIfNeeded();
  progress('点击“上传安装包”，打开添加弹窗');
  await uploadButton.evaluate((node) => node.click()).catch(async () => uploadButton.click({ force: true }));
  const addDialog = await waitForApkUploadAddDialog(page);
  await closeWindowsFileDialogs().catch(() => {});
  progress('自动选择当前游戏文件夹 APK，等待后台识别并上传');
  await setApkUploadAddDialogFile(page, apkPath);
  await closeWindowsFileDialogs(8000).catch(() => {});
  await waitForApkManagerUploadDone(page, addDialog);
  await closeWindowsFileDialogs(3000).catch(() => {});
}

async function setApkUploadAddDialogFile(page, apkPath) {
  const selectors = [
    '.el-dialog input[type=file][accept*=".apk"]',
    '.el-overlay-dialog input[type=file][accept*=".apk"]',
    '.v-modal + div input[type=file][accept*=".apk"]',
    'input[type=file][accept*=".apk"]',
    'input[type=file]',
  ];
  let lastError = null;
  for (const selector of selectors) {
    try {
      await setLocalFileInputBySelector(page, selector, apkPath);
      progress(`已选择 APK：${path.basename(apkPath)}`);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('添加弹窗中找不到 APK 文件选择控件');
}

async function waitForApkUploadAddDialog(page) {
  const dialog = page.locator('.el-dialog, .el-overlay-dialog, .v-modal + div')
    .filter({ hasText: /添加|上传|压缩上传|下载链接|更新时间/ })
    .last();
  await dialog.waitFor({ state: 'visible', timeout: 30000 });
  return dialog;
}

async function findInnerApkUploadButton(page, dialog) {
  const roleButton = dialog.getByRole('button', { name: /^上传$/ }).first();
  if (await roleButton.isVisible().catch(() => false)) return roleButton;
  const marked = await dialog.evaluate((root) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    root.querySelectorAll('[data-game-importer-inner-upload]').forEach((node) => node.removeAttribute('data-game-importer-inner-upload'));
    const buttons = Array.from(root.querySelectorAll('button, .el-button, [role="button"]'))
      .filter(visible)
      .filter((node) => /^上传$/.test((node.innerText || node.textContent || '').replace(/\s+/g, '').trim()));
    const picked = buttons[0];
    if (!picked) return false;
    picked.setAttribute('data-game-importer-inner-upload', 'true');
    return true;
  }).catch(() => false);
  if (marked) {
    const button = dialog.locator('[data-game-importer-inner-upload="true"]').first();
    if (await button.isVisible().catch(() => false)) return button;
  }
  throw new Error('添加弹窗中找不到“上传”按钮');
}

async function nativeClickLocator(page, locator) {
  const point = await locator.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      x: Math.round(window.screenX + rect.left + rect.width / 2),
      y: Math.round(window.screenY + rect.top + rect.height / 2 + (window.outerHeight - window.innerHeight)),
    };
  });
  await bringPageWindowToFront(page);
  await nativeClickAt(point.x, point.y);
}

async function bringPageWindowToFront(page) {
  const session = await page.context().newCDPSession(page);
  const { windowId } = await session.send('Browser.getWindowForTarget').catch(() => ({}));
  if (windowId) {
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
  }
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(300);
}

async function nativeClickAt(x, y) {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NativeMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@
[NativeMouse]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
Start-Sleep -Milliseconds 120
[NativeMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[NativeMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
`;
  await runPowerShell(script, 10000);
}

async function chooseFileInWindowsDialog(filePath) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NativeWindowTools {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
$target = @'
${filePath.replace(/'/g, "''")}
'@
$deadline = (Get-Date).AddSeconds(20)
$dialog = $null
while ((Get-Date) -lt $deadline) {
  $dialog = Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and $_.ProcessName -in @('msedge','chrome','explorer') -and $_.MainWindowTitle -match '打开|Open|选择|Choose|文件|File Upload'
  } | Sort-Object StartTime -Descending | Select-Object -First 1
  if ($dialog) { break }
  Start-Sleep -Milliseconds 200
}
if (-not $dialog) { throw '没有检测到 Windows 文件选择窗口' }
[NativeWindowTools]::ShowWindow($dialog.MainWindowHandle, 5) | Out-Null
[NativeWindowTools]::SetForegroundWindow($dialog.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 300
[System.Windows.Forms.Clipboard]::SetText($target)
[System.Windows.Forms.SendKeys]::SendWait('%n')
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
`;
  await runPowerShell(script, 30000);
}

function runPowerShell(script, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message || String(error)).trim()));
      else resolve(stdout);
    });
  });
}

async function closeWindowsFileDialogs(durationMs = 3000) {
  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class NativeDialogCloser {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam);
}
"@
$deadline = (Get-Date).AddMilliseconds(${Math.max(500, Number(durationMs) || 3000)})
while ((Get-Date) -lt $deadline) {
  [NativeDialogCloser]::EnumWindows({
    param($hWnd, $lParam)
    if (-not [NativeDialogCloser]::IsWindowVisible($hWnd)) { return $true }
    $titleBuilder = New-Object System.Text.StringBuilder 512
    $classBuilder = New-Object System.Text.StringBuilder 128
    [void][NativeDialogCloser]::GetWindowText($hWnd, $titleBuilder, $titleBuilder.Capacity)
    [void][NativeDialogCloser]::GetClassName($hWnd, $classBuilder, $classBuilder.Capacity)
    $windowPid = 0
    [void][NativeDialogCloser]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
    $process = Get-Process -Id $windowPid -ErrorAction SilentlyContinue
    $title = $titleBuilder.ToString()
    $className = $classBuilder.ToString()
    $isBrowserDialog = $process -and $process.ProcessName -in @('msedge','chrome','explorer') -and $className -eq '#32770'
    $isFileDialog = $title -match '打开|Open|选择|Choose|文件上传|File Upload|上传|Upload'
    if ($isBrowserDialog -or $isFileDialog) {
      [NativeDialogCloser]::PostMessage($hWnd, 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 250
}
`;
  await runPowerShell(script, Math.max(4000, Number(durationMs) + 3000));
}

async function findUploadPackageButton(page, dialog) {
  const roleButton = dialog.getByRole('button', { name: /上传安装包/ }).first();
  if (await roleButton.isVisible().catch(() => false)) return roleButton;

  const marked = await page.evaluate(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    document.querySelectorAll('[data-game-importer-upload-package]').forEach((node) => node.removeAttribute('data-game-importer-upload-package'));
    const nodes = Array.from(document.querySelectorAll('button, .el-button, a, span, div'))
      .filter(visible)
      .filter((node) => /上传安装包/.test((node.innerText || node.textContent || '').replace(/\s+/g, '')));
    for (const node of nodes) {
      const button = node.closest('button, .el-button, [role="button"], a') || node;
      if (!visible(button)) continue;
      button.setAttribute('data-game-importer-upload-package', 'true');
      return true;
    }
    return false;
  }).catch(() => false);
  if (marked) {
    const button = page.locator('[data-game-importer-upload-package="true"]').last();
    if (await button.isVisible().catch(() => false)) return button;
  }
  throw new Error('安装包管理中找不到“上传安装包”按钮。');
}

async function waitForApkManagerUploadDone(page, dialog) {
  await page.waitForFunction(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const text = document.body.innerText || '';
    if (/上传失败|文件大小|格式不支持|失败|错误/.test(text)) return 'UPLOAD_ERROR:' + text.slice(-300);
    const dialogs = Array.from(document.querySelectorAll('.el-dialog, .el-overlay-dialog, .v-modal + div')).filter(visible);
    const active = dialogs.reverse().find((node) => /添加|下载链接|更新时间|更新说明/.test(node.innerText || node.textContent || '')) || document;
    const activeText = active.innerText || active.textContent || '';
    const uploading = Array.from(active.querySelectorAll('.el-progress, .el-progress-bar, .el-upload-list__item.is-uploading, [role="progressbar"]')).some(visible)
      || /取消/.test(activeText)
      || /\b(?:[1-9]|[1-9]\d)%\b/.test(activeText)
      || /上传中|正在上传/.test(activeText);
    if (uploading) return false;
    const configurableSelects = Array.from(active.querySelectorAll('.el-select input, input[readonly], input[name="label-select"]'))
      .filter(visible)
      .filter((input) => !input.disabled);
    const canConfigure = configurableSelects.length >= 2 && /平台|合作方式/.test(activeText);
    if (canConfigure) return true;
    const hasDownloadLink = Array.from(active.querySelectorAll('input'))
      .filter(visible)
      .some((input) => /^https?:\/\//i.test(input.value || ''));
    const rows = Array.from(active.querySelectorAll('.el-table__body tr, tbody tr, .el-table__row'))
      .filter(visible)
      .filter((row) => !/暂无数据/.test(row.innerText || row.textContent || ''));
    const dataRows = rows.filter((row) => {
      const rowText = (row.innerText || row.textContent || '').replace(/\s+/g, ' ');
      const hasFile = /\.apk/i.test(rowText);
      const hasPackage = /\b[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,}\b/i.test(rowText) || /包名/.test(rowText);
      const hasSize = /\d+(?:\.\d+)?\s*(?:MB|GB|KB)/i.test(rowText);
      const selects = row.querySelectorAll('.el-select input, input[readonly], input[name="label-select"]');
      return hasFile && hasPackage && hasSize && selects.length >= 2;
    });
    return !uploading && hasDownloadLink && dataRows.length > 0;
  }, {}, { timeout: 360000 }).catch(async (error) => {
    const text = await dialog.innerText().catch(() => '');
    if (/暂无数据/.test(text)) throw new Error('安装包上传后列表仍为空，请检查上传是否成功。');
    throw error;
  });
}

async function selectApkManagerTableField(page, columnName, value) {
  value = cleanValue(value);
  if (!value) return;
  const dialog = apkManagerDialog(page);
  await dialog.waitFor({ state: 'visible', timeout: 30000 });
  const input = await findInputInTableColumn(dialog, columnName);
  if (!input) throw new Error(`安装包管理弹窗中找不到“${columnName}”选择框`);
  await selectStrictInputValue(page, input, `安装包管理 ${columnName}`, value);
}

async function ensureApkManagerTableField(page, columnName, value) {
  value = cleanValue(value);
  if (!value) return;
  const dialog = apkManagerDialog(page);
  await dialog.waitFor({ state: 'visible', timeout: 30000 });
  if (await apkManagerTableAlreadyHasValue(dialog, columnName, value)) {
    progress(`安装包管理 ${columnName} 已是 ${value}，无需切换`);
    return;
  }
  await selectApkManagerTableField(page, columnName, value);
}

async function apkManagerListHasUploadedRow(page) {
  const dialog = apkManagerDialog(page);
  if (!(await dialog.isVisible().catch(() => false))) return false;
  return dialog.evaluate((root) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const text = root.innerText || root.textContent || '';
    if (!/历史版本|安装包管理/.test(text)) return false;
    if (/添加|下载链接|更新时间|更新说明/.test(text) && !/列表/.test(text)) return false;
    return Array.from(root.querySelectorAll('.el-table__body tr, tbody tr, .el-table__row'))
      .filter(visible)
      .some((row) => {
        const rowText = (row.innerText || row.textContent || '').replace(/\s+/g, ' ');
        return /\.apk/i.test(rowText)
          && /\d+(?:\.\d+)?\s*(?:MB|GB|KB)/i.test(rowText)
          && (/\b[a-z][a-z0-9_]*(?:\.[a-z0-9_]+){2,}\b/i.test(rowText) || /包名/.test(rowText));
      });
  }).catch(() => false);
}

async function apkManagerTableAlreadyHasValue(dialog, columnName, value) {
  const aliases = selectAliases(value);
  return dialog.evaluate((root, payload) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, '').trim();
    const aliases = payload.aliases.map(normalize).filter(Boolean);
    const rows = Array.from(root.querySelectorAll('.el-table__body tr, tbody tr, .el-table__row'));
    for (const row of rows) {
      const text = normalize(row.innerText || row.textContent || '');
      if (!/\.apk/i.test(row.innerText || row.textContent || '')) continue;
      if (aliases.some((item) => item && text.includes(item))) return true;
    }
    return false;
  }, { columnName, aliases }).catch(() => false);
}

async function selectApkUploadAddDialogField(page, columnName, value) {
  value = cleanValue(value);
  if (!value) return;
  const dialog = await waitForApkUploadAddDialog(page);
  if (await apkUploadAddDialogAlreadyHasValue(dialog, columnName, value)) {
    progress(`上传包 ${columnName} 已是 ${value}，无需切换`);
    return;
  }
  const input = await findInputInTableColumn(dialog, columnName);
  if (!input) throw new Error(`上传安装包添加弹窗中找不到“${columnName}”选择框`);
  await selectStrictInputValue(page, input, `上传包 ${columnName}`, value);
}

async function apkUploadAddDialogAlreadyHasValue(dialog, columnName, value) {
  const aliases = selectAliases(value);
  return dialog.evaluate((root, payload) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const normalize = (text) => String(text || '').replace(/\s+/g, '').trim();
    const aliases = payload.aliases.map(normalize).filter(Boolean);
    const headers = Array.from(root.querySelectorAll('.el-table__header-wrapper th, .el-table__header th, thead th, th'));
    const headerIndex = headers.findIndex((header) => {
      if (!visible(header)) return false;
      const text = normalize(header.innerText || header.textContent || '');
      if (payload.columnName === '平台') return text === '平台';
      if (payload.columnName === '合作方式') return text === '合作方式';
      return text.includes(normalize(payload.columnName));
    });
    const rows = Array.from(root.querySelectorAll('.el-table__body tr, tbody tr, .el-table__row')).filter(visible);
    for (const row of rows) {
      if (/暂无数据/.test(row.innerText || row.textContent || '')) continue;
      const cells = Array.from(row.children).filter((node) => /^(TD|TH)$/i.test(node.tagName));
      const target = headerIndex >= 0 ? cells[headerIndex] : null;
      const source = target || row;
      const inputs = Array.from(source.querySelectorAll('.el-select input, input[readonly], input[name="label-select"]')).filter(visible);
      if (inputs.some((input) => aliases.includes(normalize(input.value || input.getAttribute('value') || '')))) return true;
      const text = normalize(source.innerText || source.textContent || '');
      if (aliases.some((item) => item && text.includes(item))) return true;
    }
    return false;
  }, { columnName, aliases }).catch(() => false);
}

async function findInputInTableColumn(dialog, columnName) {
  const marked = await dialog.evaluate((root, name) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const normalize = (text) => String(text || '').replace(/\s+/g, '');
    const matchName = (text) => {
      const clean = normalize(text);
      if (name === '平台') return /(^|[:：])平台/.test(clean) || /^平台$/.test(clean);
      if (name === '合作方式') return /合作方式/.test(clean);
      return clean.includes(name);
    };
    const headers = Array.from(root.querySelectorAll('.el-table__header-wrapper th, .el-table__header th, thead th, th'));
    const headerIndex = headers.findIndex((header) => visible(header) && matchName(header.innerText || header.textContent || ''));
    const rows = Array.from(root.querySelectorAll('.el-table__body tr, tbody tr, .el-table__row')).filter(visible);
    for (const row of rows) {
      if (/暂无数据/.test(row.innerText || row.textContent || '')) continue;
      const cells = Array.from(row.children).filter((node) => /^(TD|TH)$/i.test(node.tagName));
      let target = headerIndex >= 0 ? cells[headerIndex] : cells.find((cell) => matchName(cell.innerText || cell.textContent || ''));
      if (!target && name === '平台') target = cells.find((cell) => /官方|九游|小米|百度|果盘|当乐|指趣|gf|jy/i.test(cell.innerText || cell.textContent || ''));
      if (!target && name === '合作方式') target = cells.find((cell) => /无合作|S|A|D/.test((cell.innerText || cell.textContent || '').trim()));
      const input = target?.querySelector?.('.el-select input, input[readonly], input[name="label-select"], input');
      if (input && visible(input)) {
        input.setAttribute('data-game-importer-manager-field', name);
        return true;
      }
    }
    const fallback = Array.from(root.querySelectorAll('.el-form-item, .flex, td')).find((node) => visible(node) && matchName(node.innerText || node.textContent || ''));
    const input = fallback?.querySelector?.('.el-select input, input[readonly], input[name="label-select"], input');
    if (input && visible(input)) {
      input.setAttribute('data-game-importer-manager-field', name);
      return true;
    }
    return false;
  }, columnName).catch(() => false);
  if (!marked) return null;
  const input = dialog.locator(`input[data-game-importer-manager-field="${columnName}"]`).last();
  return (await input.count()) ? input : null;
}

async function readApkManagerMetadata(page) {
  const dialog = apkManagerDialog(page);
  return dialog.evaluate((root) => {
    const text = root.innerText || '';
    const find = (label) => {
      const match = text.match(new RegExp(`${label}\\\\s*[:：]?\\\\s*([^\\\\s]+)`));
      return match?.[1] || '';
    };
    return {
      packageName: find('包名'),
      version: find('版本'),
      size: find('大小'),
    };
  });
}

async function saveAndCloseApkPackageManager(page) {
  await closeWindowsFileDialogs().catch(() => {});
  if (await apkManagerListHasUploadedRow(page)) {
    progress('安装包已在管理列表中，关闭安装包管理弹窗并继续');
    await closeApkManagerDialog(page);
    await waitForReturnToGameEditAfterApkManager(page);
    return;
  }
  const addDialog = page.locator('.el-dialog, .el-overlay-dialog, .v-modal + div')
    .filter({ hasText: /添加|下载链接|更新时间|更新说明/ })
    .last();
  if (await addDialog.isVisible().catch(() => false)) {
    const confirm = addDialog.getByRole('button', { name: /确定|确认/ }).last();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
      await waitForApkAddDialogSavedOrClosable(page, addDialog);
    }
  }

  const dialog = apkManagerDialog(page);
  await closeApkManagerDialog(page);
  await waitForReturnToGameEditAfterApkManager(page);
  const stillOpen = await realApkManagerModalVisible(page);
  if (stillOpen) throw new Error('安装包管理页面未关闭，请确认上传包信息已点确定并关闭管理弹窗。');
}

async function waitForApkAddDialogSavedOrClosable(page, addDialog, timeoutMs = 30000) {
  const started = Date.now();
  let lastMessage = '';
  while (Date.now() - started < timeoutMs) {
    if (!(await addDialog.isVisible().catch(() => false))) return;
    if (await apkManagerListHasUploadedRow(page)) return;
    if (await apkAddDialogHasUploadedRow(addDialog)) {
      const closed = await clickDialogCloseButton(addDialog);
      if (closed) {
        await addDialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
        return;
      }
    }
    const message = await readVisibleFormErrors(page);
    if (message) lastMessage = message;
    if (/上传安装包模式在上传后会直接关联游戏|直接关联游戏/.test(message)) {
      const closed = await clickDialogCloseButton(addDialog);
      if (closed) {
        await addDialog.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
        return;
      }
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`添加弹窗点击确定后未关闭${lastMessage ? `：${lastMessage}` : '，可能上传仍未完成或必填项未通过'}`);
}

async function clickDialogCloseButton(dialog) {
  const close = dialog.getByRole('button', { name: /^关闭$/ }).first()
    .or(dialog.locator('button, .el-button').filter({ hasText: /^关闭$/ }).first())
    .or(dialog.locator('.el-dialog__headerbtn').first());
  if (!(await close.isVisible().catch(() => false))) return false;
  await close.click();
  return true;
}

async function closeApkManagerDialog(page) {
  if (await clickPrimaryApkManagerCloseButton(page)) {
    return;
  }
  const dialog = apkManagerDialog(page);
  await dialog.waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  const close = dialog.getByRole('button', { name: /^关闭$/ }).last()
    .or(dialog.locator('button, .el-button').filter({ hasText: /^关闭$/ }).first())
    .or(dialog.locator('.el-dialog__headerbtn, .el-drawer__close-btn').first());
  if (await close.isVisible().catch(() => false)) {
    await close.click();
    await dialog.waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
  }
  if (await realApkManagerModalVisible(page)) {
    const clicked = await page.evaluate(() => {
      const visible = (node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const roots = Array.from(document.querySelectorAll('.el-dialog, .el-overlay-dialog, .v-modal + div, [role="dialog"]'))
        .filter(visible)
        .filter((root) => /历史版本|安装包管理|上传安装包/.test(root.innerText || root.textContent || ''));
      const root = roots[roots.length - 1];
      if (!root) return false;
      const buttons = Array.from(root.querySelectorAll('button, .el-button, .el-dialog__headerbtn, .el-drawer__close-btn'))
        .filter(visible);
      const closeButton = buttons.find((button) => /^关闭$/.test((button.innerText || button.textContent || '').trim()))
        || buttons.find((button) => button.className && /headerbtn|close/.test(String(button.className)));
      if (!closeButton) return false;
      closeButton.click();
      return true;
    }).catch(() => false);
    if (clicked) await page.waitForTimeout(1200);
  }
}

async function clickPrimaryApkManagerCloseButton(page) {
  const clicked = await page.evaluate(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const roots = Array.from(document.querySelectorAll('.el-dialog, .el-overlay-dialog, .v-modal + div, [role="dialog"]'))
      .filter(visible)
      .filter((root) => /历史版本|安装包管理|上传安装包/.test(root.innerText || root.textContent || ''));
    const root = roots[roots.length - 1];
    if (!root) return false;
    const buttons = Array.from(root.querySelectorAll('button.el-button--primary.el-button--small, button.el-button--primary, button, .el-button'))
      .filter(visible)
      .filter((button) => /^关闭$/.test((button.innerText || button.textContent || '').trim()));
    const button = buttons.find((item) => item.classList?.contains('el-button--primary')) || buttons[buttons.length - 1];
    if (!button) return false;
    button.click();
    return true;
  }).catch(() => false);
  if (clicked) {
    progress('已点击安装包管理弹窗右上角“关闭”');
    await page.waitForTimeout(1500);
  }
  return clicked;
}

async function waitForReturnToGameEditAfterApkManager(page) {
  await page.waitForFunction(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const hasEditPage = Array.from(document.querySelectorAll('.game-edit-form, #download-install, .app-main, main'))
      .filter(visible)
      .some((node) => /基础信息设置|下载和安装包|提交并离开|APK包/.test(node.innerText || node.textContent || ''));
    const hasBlockingApkModal = Array.from(document.querySelectorAll('.el-dialog, .el-overlay-dialog, .v-modal + div, [role="dialog"]'))
      .filter(visible)
      .some((node) => {
        const text = node.innerText || node.textContent || '';
        return /历史版本|上传安装包|安装包管理/.test(text) && !/基础信息设置|提交并离开/.test(text);
      });
    return hasEditPage && !hasBlockingApkModal;
  }, {}, { timeout: 30000 }).catch(async () => {
    if (await page.locator('.game-edit-form').or(page.getByText('基础信息设置')).first().isVisible().catch(() => false)) return;
    throw new Error('安装包管理关闭后未回到游戏详情页。');
  });
}

async function realApkManagerModalVisible(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return Array.from(document.querySelectorAll('.el-dialog, .el-overlay-dialog, .v-modal + div, [role="dialog"]'))
      .filter(visible)
      .some((node) => {
        const text = node.innerText || node.textContent || '';
        return /历史版本|上传安装包|安装包管理/.test(text) && !/基础信息设置|提交并离开/.test(text);
      });
  }).catch(() => false);
}

async function apkAddDialogHasUploadedRow(dialog) {
  return dialog.evaluate((root) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const text = root.innerText || root.textContent || '';
    if (/上传中|正在上传|取消|\b(?:[1-9]|[1-9]\d)%\b/.test(text)) return false;
    const hasDownloadLink = Array.from(root.querySelectorAll('input'))
      .filter(visible)
      .some((input) => /^https?:\/\//i.test(input.value || ''));
    const hasApkRow = Array.from(root.querySelectorAll('.el-table__body tr, tbody tr, .el-table__row'))
      .filter(visible)
      .some((row) => /\.apk/i.test(row.innerText || row.textContent || ''));
    return hasDownloadLink && hasApkRow;
  }).catch(() => false);
}

async function readVisibleFormErrors(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return Array.from(document.querySelectorAll('.el-form-item__error, .el-message, .el-alert, .el-notification'))
      .filter(visible)
      .map((node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('；')
      .slice(0, 300);
  }).catch(() => '');
}

async function submitAndLeaveAfterApkUpload(page) {
  await page.locator('.game-edit-form').or(page.getByText('基础信息设置')).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {});
  await cleanupUnrelatedOverlays(page, 2000);
  const submitLeave = page.getByRole('button', { name: '提交并离开' }).last();
  if (await submitLeave.isVisible().catch(() => false)) {
    await submitLeave.click();
    await waitForSubmitResult(page, 30000);
    await cleanupUnrelatedOverlays(page);
    return;
  }
  const save = page.getByRole('button', { name: /保存|提交/ }).last();
  await save.click();
  await waitForSubmitResult(page, 30000);
  await cleanupUnrelatedOverlays(page);
}

function apkManagerDialog(page) {
  return page.locator('.el-dialog, .el-overlay-dialog, .v-modal + div, [role="dialog"], .app-main, main')
    .filter({ hasText: /历史版本|安装包管理|上传安装包/ })
    .last();
}

async function openSavedGameDetail(page, game) {
  const gameName = game.data['游戏名称'] || game.dirName;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await refreshBackToGamesInfo(page, `重新定位 ${gameName}`);
    else await openGamesInfo(page);
    await cleanupUnrelatedOverlays(page, 1500);
    await trySearchGameInList(page, gameName).catch((error) => {
      progress(`搜索游戏列表失败，将刷新后继续定位：${String(error?.message || error)}`);
    });
    await cleanupUnrelatedOverlays(page, 2500);
    const row = await findGameRowInList(page, gameName, { search: false, timeout: attempt ? 15000 : 8000 }).catch(() => null);
    if (row) {
      await openGameDetailFromRow(page, row, gameName);
      return;
    }
  }
  throw new Error(`保存后没有自动找到游戏详情入口：${gameName}。请手动打开该游戏详情页后点击“继续执行”。`);
}

async function finalizeSubmittedGame(page, game) {
  const gameName = game.data['游戏名称'] || game.dirName;
  try {
    await openGamesInfo(page);
    await cleanupUnrelatedOverlays(page, 1500);
    const row = await findGameRowInList(page, gameName);
    const gameId = await readGameIdFromList(page, row, gameName).catch((error) => {
      progress(`游戏ID获取失败，但游戏已提交：${String(error?.message || error)}`);
      return '';
    });
    progress(gameId ? `游戏ID：${gameId}` : '未获取到游戏ID');
    let showStatus = noAutoShow ? '已跳过自己显示' : '';
    if (!noAutoShow) {
      showStatus = await clickSelfShowInRow(page, row).catch((error) => `显示状态未处理：${String(error?.message || error)}`);
    }
    return { gameId, showStatus };
  } catch (error) {
    progress(`提交后收尾失败，但游戏可能已新增成功：${gameName}，原因：${String(error?.message || error)}`);
    return { gameId: '', showStatus: noAutoShow ? '已跳过自己显示' : '未处理显示', postSubmitWarning: String(error?.message || error) };
  }
}

async function findGameRowInList(page, gameName, options = {}) {
  const { search = true, timeout = 30000 } = options;
  await cleanupUnrelatedOverlays(page, 1000);
  if (search) {
    await trySearchGameInList(page, gameName).catch((error) => {
      progress(`搜索游戏列表失败，将尝试直接在当前列表定位：${String(error?.message || error)}`);
    });
    await cleanupUnrelatedOverlays(page, 2500);
  }
  const exactRow = await findExactGameRow(page, gameName);
  if (exactRow) return exactRow;
  const row = page.locator('.el-table__row, tr').filter({ hasText: gameName }).first();
  await row.waitFor({ state: 'visible', timeout });
  return row;
}

async function refreshBackToGamesInfo(page, reason = '恢复页面') {
  progress(`${reason}：刷新并回到游戏信息列表`);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200);
  await openGamesInfo(page);
}

async function openGameDetailFromRow(page, row, gameName = '') {
  await row.scrollIntoViewIfNeeded().catch(() => {});
  const editButton = await findEditButtonInRow(page, row, gameName);
  if (!editButton) throw new Error('已找到游戏行，但没有识别到“编辑”按钮，请确认列表操作列是否显示。');
  await editButton.scrollIntoViewIfNeeded().catch(() => {});
  await editButton.click({ force: true });
  progress(`已点击编辑：${gameName || '当前游戏'}`);
  await page.locator('.game-edit-form').or(page.getByText('基础信息设置')).first().waitFor({ state: 'visible', timeout: 30000 });
}

async function findEditButtonInRow(page, row, gameName = '') {
  const actionCell = row.locator('td:last-child, .cell:last-child, .operation, .operate, [class*="operation"], [class*="operate"]').last();
  const exactOperationIcon = actionCell.locator('i.icon-edit[title="编辑"], .icon-edit[title="编辑"], [title="编辑"].icon-edit').first();
  if (await exactOperationIcon.isVisible().catch(() => false)) return exactOperationIcon;

  const icons = actionCell.locator('button, .el-button, [role="button"], a, i, svg, .iconfont');
  const count = await icons.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const icon = icons.nth(index);
    if (!(await icon.isVisible().catch(() => false))) continue;
    const meta = `${await icon.getAttribute('title').catch(() => '') || ''} ${await icon.getAttribute('aria-label').catch(() => '') || ''} ${await icon.getAttribute('class').catch(() => '') || ''}`;
    if (/编辑|edit|修改|详情|detail/i.test(meta) && !/删除|delete|显示|show|上架|下架|二维码|qrcode/i.test(meta)) return icon;
    await icon.hover().catch(() => {});
    await page.waitForTimeout(250);
    const tooltip = await readVisibleTooltipText(page);
    if (/编辑|修改|详情/.test(tooltip) && !/删除|显示|上架|下架|二维码|复制/.test(tooltip)) return icon;
  }

  const firstBlue = await actionCell.locator('button.el-button--primary, .el-button--primary, i[class*="edit"], .icon-edit').first();
  if (await firstBlue.isVisible().catch(() => false)) return firstBlue;

  const fixedColumnButton = await findEditButtonInFixedOperationColumn(page, gameName);
  if (fixedColumnButton) return fixedColumnButton;
  return null;
}

async function findEditButtonInFixedOperationColumn(page, gameName) {
  if (!gameName) return null;
  const marked = await page.evaluate((targetName) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const normalize = (text) => String(text || '').replace(/\s+/g, '').trim();
    const name = normalize(targetName);
    const clearMarks = () => document.querySelectorAll('[data-game-importer-edit-button]').forEach((node) => node.removeAttribute('data-game-importer-edit-button'));
    clearMarks();

    const bodyRows = Array.from(document.querySelectorAll('.el-table__body-wrapper:not(.is-hidden) tbody tr, .el-table__body-wrapper:not(.is-hidden) .el-table__row, .el-table__body tbody tr, .el-table__row'))
      .filter(visible);
    const dataRow = bodyRows.find((row) => normalize(row.innerText || row.textContent || '').includes(name));
    if (!dataRow) return false;
    const dataRect = dataRow.getBoundingClientRect();

    const fixedRows = Array.from(document.querySelectorAll('.el-table__fixed-right tbody tr, .el-table__fixed-right .el-table__row, .el-table__fixed-right-patch tbody tr'))
      .filter(visible);
    const operationRow = fixedRows
      .map((row) => ({ row, delta: Math.abs(row.getBoundingClientRect().top - dataRect.top) }))
      .sort((a, b) => a.delta - b.delta)[0]?.row;
    if (!operationRow) return false;

    const exactIcon = Array.from(operationRow.querySelectorAll('i.icon-edit[title="编辑"], .icon-edit[title="编辑"], [title="编辑"].icon-edit'))
      .find(visible);
    if (exactIcon) {
      exactIcon.setAttribute('data-game-importer-edit-button', 'true');
      return true;
    }

    const candidates = Array.from(operationRow.querySelectorAll('button, .el-button, [role="button"], a, i, .iconfont, svg'))
      .filter(visible)
      .filter((node) => {
        const meta = `${node.innerText || node.textContent || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('class') || ''}`;
        return !/删除|delete|显示|show|上架|下架|二维码|qrcode|copy|复制|更多|more|arrow|caret/i.test(meta);
      });
    const exact = candidates.find((node) => /编辑|edit|修改|详情|detail/i.test(`${node.innerText || node.textContent || ''} ${node.getAttribute('title') || ''} ${node.getAttribute('aria-label') || ''} ${node.getAttribute('class') || ''}`));
    const primary = candidates.find((node) => /primary|blue|edit/i.test(node.getAttribute('class') || ''));
    const picked = exact || primary || candidates[0];
    if (!picked) return false;
    picked.setAttribute('data-game-importer-edit-button', 'true');
    return true;
  }, gameName).catch(() => false);
  if (!marked) return null;
  const button = page.locator('[data-game-importer-edit-button="true"]').last();
  return (await button.isVisible().catch(() => false)) ? button : null;
}

async function readVisibleTooltipText(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    return Array.from(document.querySelectorAll('.el-tooltip__popper, .el-popper, [role="tooltip"]'))
      .filter(visible)
      .map((node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(' ');
  }).catch(() => '');
}

async function findExactGameRow(page, gameName) {
  const rows = page.locator('.el-table__row, tr');
  const count = await rows.count().catch(() => 0);
  const exact = new RegExp(`^\\s*${escapeRegExp(gameName)}\\s*$`);
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    if (!(await row.isVisible().catch(() => false))) continue;
    const exactName = row.locator('td, .cell, a, span, div').filter({ hasText: exact }).first();
    if (await exactName.isVisible().catch(() => false)) return row;
  }
  return null;
}

async function readGameIdFromList(page, row, gameName) {
  const iconId = await clickQrcodeCopyIconAndReadGameId(page, row);
  if (iconId) return iconId;
  const nameNode = row.locator('a, .cell, span, div').filter({ hasText: gameName }).first();
  if (await nameNode.isVisible().catch(() => false)) {
    await nameNode.scrollIntoViewIfNeeded();
    await nameNode.hover().catch(() => {});
    await page.waitForTimeout(600);
    const popupId = await readVisibleGameIdPopup(page);
    if (popupId) return popupId;
    await nameNode.click().catch(() => {});
    await page.waitForTimeout(600);
    const clickedPopupId = await readVisibleGameIdPopup(page);
    if (clickedPopupId) return clickedPopupId;
    const copiedId = await clickCopyAndReadGameId(page);
    if (copiedId) return copiedId;
  }
  const rowId = await readGameIdFromRowText(row);
  if (rowId) return rowId;
  return readGameIdFromDetail(page, row);
}

async function clickQrcodeCopyIconAndReadGameId(page, row) {
  await row.hover().catch(() => {});
  const icon = row.locator('i.icon-qrcode-1-copy, .icon-qrcode-1-copy').first();
  if (!(await icon.isVisible().catch(() => false))) return '';
  await icon.scrollIntoViewIfNeeded();
  await icon.click().catch(async () => {
    const clickable = icon.locator('xpath=ancestor-or-self::*[self::button or @role="button" or contains(@class,"el-button")][1]');
    if (await clickable.isVisible().catch(() => false)) await clickable.click();
  });
  await page.waitForTimeout(500);
  const popupId = await readVisibleGameIdPopup(page);
  if (popupId) return popupId;
  const copyId = await clickCopyAndReadGameId(page);
  if (copyId) return copyId;
  return '';
}

async function readGameIdFromDetail(page, row) {
  const editButton = row.getByRole('button', { name: /编辑|详情|修改|查看/ }).first();
  if (await editButton.isVisible().catch(() => false)) {
    await editButton.click().catch(() => {});
  } else {
    await row.dblclick().catch(async () => row.click());
  }
  await page.waitForTimeout(1000);
  const id = await page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ').trim();
    const labeled = text.match(/(?:游戏ID|ID|编号)[:：]?\s*(\d{2,}|[a-f0-9]{16,})/i);
    if (labeled) return labeled[1];
    const nodes = Array.from(document.querySelectorAll('label, .el-form-item__label, .cell, span, div'));
    for (const node of nodes) {
      const label = (node.innerText || node.textContent || '').replace(/\s+/g, '').trim();
      if (!/^(游戏ID|ID|编号)$/.test(label)) continue;
      const parent = node.closest('.el-form-item, tr, .cell, div') || node.parentElement;
      const source = (parent?.innerText || parent?.textContent || '').replace(/\s+/g, ' ').trim();
      const found = source.match(/(\d{2,}|[a-f0-9]{16,})/i);
      if (found) return found[1];
    }
    return '';
  }).catch(() => '');
  await openGamesInfo(page).catch(() => {});
  return id || '';
}

async function readVisibleGameIdPopup(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('.el-popover, .el-tooltip__popper, .el-popper, [role="tooltip"]'));
    for (const node of nodes) {
      if (!visible(node)) continue;
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/复制|游戏ID|ID/i.test(text)) continue;
      const id = text.match(/\b[a-f0-9]{16,}\b/i) || text.match(/\b\d{4,}\b/);
      if (id) return id[0];
    }
    return '';
  }).catch(() => '');
}

async function clickCopyAndReadGameId(page) {
  const copyButton = page.locator('.el-popover:visible, .el-popper:visible, [role="tooltip"]:visible').getByText('复制').first();
  if (!(await copyButton.isVisible().catch(() => false))) return '';
  await copyButton.click().catch(() => {});
  await page.waitForTimeout(300);
  const text = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('.el-popover, .el-tooltip__popper, .el-popper, [role="tooltip"], .el-message'));
    return nodes.map((node) => node.innerText || node.textContent || '').join(' ');
  }).catch(() => '');
  const id = text.match(/\b[a-f0-9]{16,}\b/i) || text.match(/\b\d{4,}\b/);
  return id?.[0] || '';
}

async function readGameIdFromRowText(row) {
  return row.evaluate((element) => {
    const text = (element.innerText || '').replace(/\s+/g, ' ').trim();
    const idFromLabel = text.match(/(?:ID|游戏ID)[:：]?\s*(\d{2,})/i);
    if (idFromLabel) return idFromLabel[1];
    const cells = Array.from(element.querySelectorAll('.cell, td, div, span'))
      .map((node) => (node.innerText || node.textContent || '').trim())
      .filter(Boolean);
    return cells.find((cell) => /^\d{2,}$/.test(cell)) || '';
  }).catch(() => '');
}

async function clickSelfShowInRow(page, row) {
  const button = await findSelfShowButton(row);
  if (!button) {
    progress('未找到“自己显示”按钮，请在列表中手动确认显示状态');
    return '未找到自己显示按钮';
  }
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await page.waitForTimeout(800);
  const confirm = page.getByRole('button', { name: /确定|确认/ }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await waitForSubmitResult(page, 8000).catch(() => page.waitForTimeout(500));
  return '已执行自己显示';
}

async function findSelfShowButton(row) {
  const exact = row
    .getByRole('button', { name: /自己显示|显示游戏|显示|上架|启用/ })
    .or(row.locator('button, .el-button, [role="button"]').filter({ hasText: /自己显示|显示游戏|显示|上架|启用/ }))
    .first();
  if (await exact.isVisible().catch(() => false)) return exact;

  const actionCells = row.locator('td:last-child, .cell:last-child, .operation, .operate, [class*="operation"], [class*="operate"]');
  const actionCell = actionCells.last();
  const icons = actionCell.locator('button, .el-button, i, svg, [role="button"], .iconfont, .el-icon-view, .el-icon-video-play');
  const count = await icons.count();
  for (let index = 0; index < count; index += 1) {
    const icon = icons.nth(index);
    if (!(await icon.isVisible().catch(() => false))) continue;
    const title = `${await icon.getAttribute('title').catch(() => '') || ''} ${await icon.getAttribute('aria-label').catch(() => '') || ''} ${await icon.getAttribute('class').catch(() => '') || ''}`;
    if (/显示|show|view|eye|play|blue|primary|success/i.test(title)) return icon;
  }
  return null;
}

async function trySearchGameInList(page, gameName) {
  await openGamesInfo(page);
  await cleanupUnrelatedOverlays(page, 1000);
  const input = await findEditableListSearchInput(page);
  if (!input) return;
  const selector = page.locator('.el-input').filter({ hasText: /游戏名称|游戏名称\/副标题/ }).locator('input[readonly]').first();
  if (await selector.isVisible().catch(() => false)) {
    const current = await selector.inputValue().catch(() => '');
    if (!/游戏名称/.test(current)) {
      await selector.click();
      await clickStrictVisibleDropdownOption(page, '游戏名称/副标题').catch(() => clickStrictVisibleDropdownOption(page, '游戏名称')).catch(() => {});
    }
  }
  await input.fill(gameName);
  await input.dispatchEvent('input');
  await input.press('Enter').catch(() => {});
  await cleanupUnrelatedOverlays(page, 1500);
  const searchButton = page.getByRole('button', { name: /搜索|查询/ }).first();
  if (await searchButton.isVisible().catch(() => false)) await searchButton.click();
  await cleanupUnrelatedOverlays(page, 2500);
  await page.locator('.el-table__row, tr').filter({ hasText: gameName }).first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
}

async function findEditableListSearchInput(page) {
  const candidates = page.locator('input[placeholder*="搜索关键字"], input[placeholder*="游戏"], input[placeholder*="名称"], input[placeholder*="搜索"]');
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const input = candidates.nth(index);
    if (!(await input.isVisible().catch(() => false))) continue;
    const readonly = await input.evaluate((node) => node.readOnly || node.disabled).catch(() => true);
    if (!readonly) return input;
  }
  return null;
}

async function clickSaveInDetail(page) {
  let button = page.getByRole('button', { name: /保存/ }).last();
  if (!(await button.isVisible().catch(() => false))) {
    button = page.getByRole('button', { name: /提交/ }).filter({ hasNotText: '离开' }).last();
  }
  await button.click();
  await waitForSubmitResult(page);
}

async function setApkPermissionFile(page, apkPath) {
  if (!apkPath) throw new Error('当前游戏文件夹没有找到用于权限获取的 .apk 文件，请手动点击“权限获取”并选择 APK。');
  const section = page.locator('.apk-info .fillin-mode, .api-package-container .fillin-mode').filter({ hasText: '权限获取' }).last();
  const button = section.locator('.access-permission-btn button').filter({ hasText: '权限获取' }).first();
  const input = section.locator('.access-permission-btn input[type=file][accept=".apk"], input[type=file][accept*=".apk"]').first();

  await section.waitFor({ state: 'attached', timeout: 10000 });
  await button.waitFor({ state: 'visible', timeout: 10000 });
  await input.waitFor({ state: 'attached', timeout: 10000 });
  await button.scrollIntoViewIfNeeded();

  progress('点击“权限获取”，准备从当前游戏文件夹选择 APK 读取包体信息');
  const chooserPromise = page.waitForEvent('filechooser', { timeout: 15000 }).catch(() => null);
  await button.click();
  const chooser = await chooserPromise;

  if (chooser) {
    try {
      await chooser.setFiles(apkPath);
    } catch (error) {
      if (!/larger than 50Mb|Cannot transfer files/i.test(String(error?.message || error))) throw error;
      progress('APK 超过 50MB，文件选择窗口方式受限，改用本机路径方式触发解析');
      await setLocalFileInputBySelector(page, '.apk-info .fillin-mode .access-permission-btn input[type=file][accept=".apk"], .api-package-container .fillin-mode .access-permission-btn input[type=file][accept=".apk"]', apkPath);
    }
  } else {
    progress('未检测到系统文件选择窗口，改用本机路径方式触发解析');
    await setLocalFileInputBySelector(page, '.apk-info .fillin-mode .access-permission-btn input[type=file][accept=".apk"], .api-package-container .fillin-mode .access-permission-btn input[type=file][accept=".apk"]', apkPath);
  }
  progress('已选择本地 APK，等待后台解析回填');
}

async function setLocalFileInputBySelector(page, selector, filePath) {
  const session = await page.context().newCDPSession(page);
  const { root } = await session.send('DOM.getDocument', { depth: -1, pierce: true });
  const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error('找不到权限获取 APK 文件选择框');
  await session.send('DOM.setFileInputFiles', { nodeId, files: [filePath] });
  await page.evaluate((targetSelector) => {
    const input = document.querySelector(targetSelector);
    if (!input) return;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector);
}

async function withStep(page, label, action, timeout = stepTimeoutMs) {
  progress(`开始：${label}`);
  try {
    await cleanupBlockingOverlays(page).catch(() => {});
    const result = await withTimeout(action(), timeout, label);
    progress(`完成：${label}`);
    return result;
  } catch (error) {
    if (shouldAutoRefreshRecover(label)) {
      const recovered = await recoverStepByRefresh(page, label, action, timeout).catch(() => undefined);
      if (recovered !== undefined) {
        progress(`完成：${label}`);
        return recovered;
      }
    }
    const shot = path.join(screenshotDir, `超时或失败-${safeName(label)}-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const message = error instanceof StepTimeoutError
      ? `步骤超时：${label}，已等待 ${Math.round(timeout / 1000)} 秒，截图：${shot}`
      : `步骤失败：${label}，原因：${String(error?.message || error)}，截图：${shot}`;
    progress(message);
    if (manualRecover) {
      await waitForManualRecovery(page, label, message);
      progress(`已手动处理并继续：${label}`);
      if (/等待|读取/.test(label)) {
        return await withTimeout(action(), timeout, label).catch(() => undefined);
      }
      return undefined;
    }
    throw new Error(message);
  }
}

function shouldAutoRefreshRecover(label) {
  return /保存后打开游戏详情页|提交后获取游戏ID|等待提交结果|打开游戏信息列表/.test(label);
}

async function recoverStepByRefresh(page, label, action, timeout) {
  progress(`自动恢复：${label} 超时或失败，刷新页面后重试一次`);
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200);
  await openGamesInfo(page).catch(() => {});
  return withTimeout(action(), timeout, label);
}

async function cleanupBlockingOverlays(page) {
  await page.evaluate(() => {
    document.getElementById('__game_importer_recover__')?.remove();
    window.__gameImporterManualContinue = false;
    window.__gameImporterManualCancel = false;
    document.querySelectorAll('.el-notification .el-notification__closeBtn, .el-message .el-message__closeBtn, .el-message-box__close, .el-dialog__headerbtn, .el-drawer__close-btn').forEach((button) => {
      const text = button.closest('.el-dialog, .el-drawer')?.innerText || '';
      if (/添加游戏|基础信息|下载和安装包|游戏详情/.test(text)) return;
      button.click();
    });
    document.querySelectorAll('.el-notification, .el-message').forEach((node) => node.remove());
  });
}

async function cleanupPostSubmitOverlays(page) {
  return cleanupUnrelatedOverlays(page);
}

async function cleanupUnrelatedOverlays(page, maxMs = 6000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const clicked = await closeOneUnrelatedOverlay(page);
    if (clicked) {
      await page.waitForTimeout(500);
      continue;
    }
    await page.waitForTimeout(300);
  }
}

async function closeOneUnrelatedOverlay(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const textOf = (node) => (node.innerText || node.textContent || '').replace(/\s+/g, '').trim();
    const clickClose = (root) => {
      const close = root.querySelector('.el-dialog__headerbtn, .el-drawer__close-btn, .el-message-box__close, [aria-label="Close"], [aria-label="关闭"]');
      if (close && visible(close)) {
        close.click();
        return true;
      }
      const buttons = Array.from(root.querySelectorAll('button, .el-button')).filter(visible);
      const cancel = buttons.find((button) => /^(关闭|取消|确定|确认)$/.test(textOf(button)));
      if (cancel) {
        cancel.click();
        return true;
      }
      return false;
    };
    const popups = Array.from(document.querySelectorAll('.el-dialog, .el-drawer, .el-message-box, .el-overlay-dialog, .v-modal + div, [role="dialog"], [class*="modal"], [class*="dialog"], body > div'))
      .filter(visible)
      .filter((node) => {
        const text = textOf(node);
        if (!text) return false;
        const rect = node.getBoundingClientRect();
        if (node.tagName === 'DIV' && node.parentElement === document.body && (rect.width < 360 || rect.height < 160)) return false;
        if (/添加游戏|基础信息设置|下载和安装包|游戏详情/.test(text)) return false;
        return /厂商|游戏名单|查询|提示|成功|确认/.test(text);
      });
    for (const popup of popups) {
      if (clickClose(popup)) return true;
    }

    const closeButtons = Array.from(document.querySelectorAll('button, .el-button'))
      .filter(visible)
      .filter((button) => /^(关闭|取消)$/.test(textOf(button)))
      .filter((button) => {
        const root = button.closest('.el-dialog, .el-drawer, .el-message-box, .el-overlay-dialog, .v-modal + div, [role="dialog"], [class*="modal"], [class*="dialog"]') || button.closest('body > div');
        if (!root || !visible(root)) return false;
        const text = textOf(root);
        return /厂商|游戏名单|查询|提示|成功|确认/.test(text) && !/添加游戏|基础信息设置|下载和安装包|游戏详情/.test(text);
      });
    if (closeButtons[0]) {
      closeButtons[0].click();
      return true;
    }

    document.querySelectorAll('.el-notification .el-notification__closeBtn, .el-message .el-message__closeBtn').forEach((button) => button.click());
    return false;
  }).catch(() => false);
}

async function waitForManualRecovery(page, label, message) {
  await page.evaluate(({ label, message }) => {
    window.__gameImporterManualContinue = false;
    window.__gameImporterManualCancel = false;
    document.getElementById('__game_importer_recover__')?.remove();
    const box = document.createElement('div');
    box.id = '__game_importer_recover__';
    box.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'right:24px',
      'top:24px',
      'width:420px',
      'background:#111827',
      'color:#fff',
      'border-radius:10px',
      'box-shadow:0 18px 60px rgba(0,0,0,.35)',
      'font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Microsoft YaHei,sans-serif',
      'padding:18px',
    ].join(';');
    box.innerHTML = `
      <button id="__game_importer_close__" title="关闭提示" style="position:absolute;right:10px;top:8px;border:0;background:transparent;color:#cbd5e1;font-size:20px;line-height:20px;cursor:pointer;">×</button>
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;padding-right:28px;">需要手动处理后继续</div>
      <div style="color:#fbbf24;margin-bottom:8px;">当前步骤：${escapeHtmlForOverlay(label)}</div>
      <div style="max-height:130px;overflow:auto;color:#d1d5db;margin-bottom:14px;white-space:pre-wrap;">${escapeHtmlForOverlay(message)}</div>
      <div style="color:#cbd5e1;margin-bottom:14px;">请在页面上手动完成这个字段/选项/上传。完成后点击“继续执行”。</div>
      <button id="__game_importer_continue__" style="border:0;border-radius:6px;background:#22c55e;color:#06230f;padding:8px 14px;font-weight:700;cursor:pointer;margin-right:8px;">继续执行</button>
      <button id="__game_importer_cancel__" style="border:1px solid #4b5563;border-radius:6px;background:#1f2937;color:#e5e7eb;padding:8px 14px;cursor:pointer;">停止任务</button>
    `;
    function escapeHtmlForOverlay(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }
    document.body.appendChild(box);
    document.getElementById('__game_importer_close__').onclick = () => {
      window.__gameImporterManualCancel = true;
      box.remove();
    };
    document.getElementById('__game_importer_continue__').onclick = () => {
      window.__gameImporterManualContinue = true;
      box.remove();
    };
    document.getElementById('__game_importer_cancel__').onclick = () => {
      window.__gameImporterManualCancel = true;
      box.remove();
    };
  }, { label, message });

  progress(`等待手动处理：${label}`);
  const result = await page.waitForFunction(() => {
    if (window.__gameImporterManualCancel) return 'cancel';
    if (window.__gameImporterManualContinue) return 'continue';
    return false;
  }, null, { timeout: 600000 });
  const value = await result.jsonValue();
  if (value === 'cancel') throw new Error(`用户停止任务：${label}`);
}

function withTimeout(promise, timeout, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StepTimeoutError(label, timeout)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function fillByLabel(page, labelText, value) {
  if (!value) return;
  const item = formItem(page, labelText).first();
  const control = item.locator('textarea, input:not([type=file]):not([type=checkbox]):not([type=button])').first();
  await control.waitFor({ state: 'attached', timeout: 10000 });
  await control.scrollIntoViewIfNeeded();
  if (!(await control.isEnabled())) return;
  await control.fill(String(value), { timeout: 10000 }).catch(async () => {
    await control.evaluate((element, nextValue) => {
      element.value = nextValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(value));
  });
  await control.dispatchEvent('input');
  await control.dispatchEvent('change');
}

async function fillDeveloperField(page, labelText, value) {
  if (!value) return;
  const anchors = ['开发者', '版权', '备案', '名称', '地区', '供应商', '统一社会信用代码', 'ICP备案号'];
  const section = page.locator('.el-form, .game-edit-form').filter({ hasText: '统一社会信用代码' }).first();
  let item = section.locator('.el-form-item').filter({ has: section.locator('.el-form-item__label', { hasText: labelText }) }).first();
  if (!(await item.count())) item = formItem(page, labelText).last();
  const control = item.locator('textarea, input:not([type=file]):not([type=checkbox]):not([type=button])').first();
  await control.waitFor({ state: 'attached', timeout: 10000 });
  await control.scrollIntoViewIfNeeded();
  if (!(await control.isEnabled())) return;
  await control.fill(String(value), { timeout: 10000 }).catch(async () => {
    await control.evaluate((element, nextValue) => {
      element.value = nextValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }, String(value));
  });
  await control.dispatchEvent('input');
  await control.dispatchEvent('change');
}

async function fillByPlaceholder(page, placeholder, value) {
  if (!value) return;
  let control = page.locator(`input[placeholder="${cssEscape(placeholder)}"], textarea[placeholder="${cssEscape(placeholder)}"]`).first();
  if (!(await control.count())) {
    control = page.locator(`input[placeholder*="${cssEscape(placeholder)}"], textarea[placeholder*="${cssEscape(placeholder)}"]`).first();
  }
  await control.waitFor({ state: 'attached', timeout: 10000 });
  await control.scrollIntoViewIfNeeded();
  await control.fill(String(value));
  await control.dispatchEvent('input');
  await control.dispatchEvent('change');
}

async function selectDeveloperType(page, value) {
  const targetValue = normalizeChoice(value, validDeveloperTypes, '企业开发者');
  const marked = await page.evaluate(() => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const selects = Array.from(document.querySelectorAll('.el-select input, input[readonly][placeholder="请选择"], input[name="label-select"]'))
      .filter(visible);
    const existing = selects.find((input) => /企业开发者|个人开发者/.test(input.value || ''));
    if (existing) {
      existing.setAttribute('data-game-importer-developer-type', 'true');
      return true;
    }
    const anchors = Array.from(document.querySelectorAll('.el-form-item, .form-item, label, div, span'))
      .filter((node) => visible(node) && /开发者名称|统一社会信用代码/.test((node.innerText || node.textContent || '').replace(/\s+/g, '')));
    const anchorRect = anchors
      .map((node) => node.getBoundingClientRect())
      .sort((a, b) => a.top - b.top)[0];
    if (!anchorRect) return false;
    const ranked = selects
      .map((input) => {
        const rect = input.getBoundingClientRect();
        const verticalDistance = Math.abs(rect.top - anchorRect.top);
        const sameColumn = Math.abs(rect.left - anchorRect.left) < 500 ? 0 : 300;
        const aboveBonus = rect.top <= anchorRect.top + 8 ? 0 : 200;
        return { input, score: verticalDistance + sameColumn + aboveBonus };
      })
      .sort((a, b) => a.score - b.score);
    const picked = ranked[0]?.input;
    if (picked) {
      picked.setAttribute('data-game-importer-developer-type', 'true');
      return true;
    }
    return false;
  }).catch(() => false);
  const target = marked ? page.locator('input[data-game-importer-developer-type="true"]').last() : page.locator('input[readonly][placeholder="请选择"], input[name="label-select"]').first();
  await target.waitFor({ state: 'attached', timeout: 10000 });
  const current = await target.inputValue().catch(() => '');
  if (current === targetValue) return;
  await target.scrollIntoViewIfNeeded();
  await target.click();
  if (await trySelectStrictVisibleValue(page, targetValue)) return;
  if (await trySelectByTyping(page, target, targetValue, { strict: true })) return;
  const after = await target.inputValue().catch(() => '');
  if (after === targetValue) return;
  throw new Error(`开发者类型固定为企业开发者，但当前未选择成功：${after || '空'}`);
}

async function selectByLabel(page, labelText, value) {
  value = cleanValue(value);
  if (!value) return;
  const item = formItem(page, labelText).first();
  const input = item.locator('.el-select input, input[readonly]').first();
  await input.waitFor({ state: 'attached', timeout: 10000 });
  await input.scrollIntoViewIfNeeded();
  const aliases = selectAliases(value);
  if (await inputAlreadyHasValue(input, aliases, labelText)) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await input.click();
    await page.waitForTimeout(300);
    if (await inputAlreadyHasValue(input, aliases, labelText)) return;
    if (await trySelectVisibleValue(page, value)) return;
  }
  throw new Error(`找不到下拉选项：${value}；当前可见选项：${await visibleDropdownOptionsText(page)}`);
}

async function selectByLabelStrict(page, labelText, value) {
  value = cleanValue(value);
  if (!value) return;
  const item = formItem(page, labelText).first();
  const input = item.locator('.el-select input, input[readonly]').first();
  await input.waitFor({ state: 'attached', timeout: 10000 });
  await input.scrollIntoViewIfNeeded();
  const aliases = selectAliases(value);
  if (await inputAlreadyHasValue(input, aliases, labelText)) return;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await input.click();
    await page.waitForTimeout(300);
    if (await inputAlreadyHasValue(input, aliases, labelText)) return;
    if (await trySelectStrictVisibleValue(page, value)) return;
  }
  throw new Error(`找不到精确下拉选项：${value}；当前可见选项：${await visibleDropdownOptionsText(page)}`);
}

async function inputAlreadyHasValue(input, aliases, label = '下拉选项') {
  const current = await input.inputValue().catch(() => '');
  if (!valueMatchesAnyAlias(current, aliases)) return false;
  progress(`${label} 已是 ${current}，无需切换`);
  return true;
}

async function selectNearbyValue(page, anchorLabel, logicalName, value) {
  if (!value) return;
  const section = formItem(page, anchorLabel).locator('xpath=ancestor::*[contains(@class, "api-package-container") or contains(@class, "apk-info")]').first();
  const candidates = section.locator('.el-select input');
  const count = await candidates.count();
  for (let i = 0; i < count; i += 1) {
    const input = candidates.nth(i);
    const current = await input.inputValue().catch(() => '');
    if ((logicalName === '平台' && /官方|九游|应用宝|小米|百度/.test(current)) || (logicalName === '合作方式' && /合作|无合作|A|B|C|S/.test(current))) {
      await input.click();
      await selectVisibleValue(page, value);
      return;
    }
  }
  throw new Error(`找不到 APK ${logicalName} 选择框`);
}

async function selectApkField(page, logicalName, value) {
  value = cleanValue(value);
  if (!value) return;
  const section = page.locator('.apk-info, .api-package-container').filter({ hasText: 'APK包' }).last();
  if (await apkSectionAlreadyHasValue(section, logicalName, value)) {
    progress(`APK ${logicalName} 已是 ${value}，无需切换`);
    return;
  }
  const aliases = selectAliases(value);
  const labeledInput = await selectSpecificApkInput(page, section, logicalName);
  if (labeledInput) return selectStrictInputValue(page, labeledInput, `APK ${logicalName}`, value, aliases);
  const typedInput = await findApkInputByCurrentType(page, section, logicalName);
  if (typedInput) return selectStrictInputValue(page, typedInput, `APK ${logicalName}`, value, aliases);
  throw new Error(`找不到 APK ${logicalName} 选择框`);
}

async function apkSectionAlreadyHasValue(section, logicalName, value) {
  const aliases = selectAliases(value);
  return section.evaluate((root, payload) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, '').trim();
    const aliases = payload.aliases.map(normalize).filter(Boolean);
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const inputs = Array.from(root.querySelectorAll('.el-select input, input[readonly], input[name="label-select"]'))
      .filter(visible);
    return inputs.some((input) => aliases.includes(normalize(input.value || input.getAttribute('value') || '')));
  }, { logicalName, aliases }).catch(() => false);
}

async function selectSpecificApkInput(page, section, logicalName) {
  const handles = await section.locator('.el-form-item, .form-item, .package-info .flex, .package-info > div, .fillin-mode .flex, .fillin-mode > div, td, th').elementHandles().catch(() => []);
  for (const handle of handles) {
    const meta = await handle.evaluate((node, name) => {
      const visible = (element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      if (!visible(node)) return null;
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, '');
      if (name === '平台' && !/(^|[:：])平台/.test(text) && !/^平台/.test(text) && !/(官方|九游|小米|百度|果盘|当乐|指趣|TT语音|360|安锋|偶玩|联想|汉风|说玩|游戏fan|乐游|猎宝|应用宝|熊猫玩|乐嗨嗨|igs|优趣)/.test(text)) return null;
      if (name === '平台' && /合作方式/.test(text)) return null;
      if (name === '合作方式' && !/合作方式/.test(text)) return null;
      const input = node.querySelector('.el-select input, input[readonly], input[name="label-select"]');
      if (!input || !visible(input)) return null;
      input.setAttribute('data-game-importer-apk-field', name);
      return true;
    }, logicalName).catch(() => null);
    if (meta) {
      const input = page.locator(`input[data-game-importer-apk-field="${logicalName}"]`).last();
      if (await input.count()) return input;
    }
  }
  const labelInput = section.locator(`xpath=.//*[contains(normalize-space(.), "${logicalName}")]/ancestor::*[contains(@class, "el-form-item") or contains(@class, "form-item") or contains(@class, "flex") or self::td][1]//input[contains(@class, "el-input__inner") or @readonly]`).last();
  if (await labelInput.count()) return labelInput;
  return null;
}

async function findApkInputByCurrentType(page, section, logicalName) {
  const marked = await section.evaluate((root, name) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const platformPattern = /^(九游|官方|小米|百度|果盘|当乐|指趣|TT语音|360|安锋|偶玩|联想|汉风|说玩|游戏fan|乐游|猎宝|应用宝|熊猫玩|乐嗨嗨|igs|优趣)$/;
    const cooperationPattern = /^(无合作|S|A|D)$/i;
    const inputs = Array.from(root.querySelectorAll('.el-select input, input[readonly], input[name="label-select"]'))
      .filter(visible);
    const picked = inputs.find((input) => {
      const value = String(input.value || '').replace(/\s+/g, '');
      return name === '平台' ? platformPattern.test(value) : cooperationPattern.test(value);
    });
    if (!picked) return false;
    picked.setAttribute('data-game-importer-apk-current-type', name);
    return true;
  }, logicalName).catch(() => false);
  if (!marked) return null;
  const input = page.locator(`input[data-game-importer-apk-current-type="${logicalName}"]`).last();
  return (await input.count()) ? input : null;
}

async function selectStrictInputValue(page, input, label, value, aliases = selectAliases(value)) {
  const current = await input.inputValue().catch(() => '');
  if (valueMatchesAnyAlias(current, aliases)) {
    progress(`${label} 已是 ${current}，无需切换`);
    return;
  }
  let lastValue = current;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await input.scrollIntoViewIfNeeded();
    await input.click({ force: true });
    await page.waitForTimeout(250);
    const clicked = await clickStrictVisibleDropdownOption(page, value);
    if (clicked && await waitForInputValueMatch(input, aliases, 1500)) return;
    if (!clicked && await trySelectByTyping(page, input, value, { strict: true }) && await waitForInputValueMatch(input, aliases, 1500)) return;
    lastValue = await input.inputValue().catch(() => '');
    if (valueMatchesAnyAlias(lastValue, aliases)) return;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }
  throw new Error(`${label} 未按资料选择：需要 ${value}，当前 ${lastValue || '空'}；当前可见选项：${await visibleDropdownOptionsText(page)}`);
}

async function clickStrictVisibleDropdownOption(page, value) {
  const aliases = selectAliases(value);
  for (const alias of aliases) {
    const exact = new RegExp(`^\\s*${escapeRegExp(alias)}\\s*$`);
    const option = page.locator('.el-select-dropdown:visible .el-select-dropdown__item, .el-popper:visible li')
      .filter({ hasText: exact })
      .first();
    if (await option.isVisible({ timeout: 1000 }).catch(() => false)) {
      await option.scrollIntoViewIfNeeded().catch(() => {});
      await option.click({ force: true, timeout: 5000 });
      return true;
    }
  }
  return trySelectStrictVisibleValue(page, value);
}

async function waitForInputValueMatch(input, aliases, timeout = 1500) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const current = await input.inputValue().catch(() => '');
    if (valueMatchesAnyAlias(current, aliases)) return true;
    await input.page().waitForTimeout(100);
  }
  return false;
}

async function selectVisibleValue(page, value) {
  value = cleanValue(value);
  if (await trySelectVisibleValue(page, value)) return;
  throw new Error(`找不到下拉选项：${value}；当前可见选项：${await visibleDropdownOptionsText(page)}`);
}

async function visibleDropdownOptionsText(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item, .el-popper:not([style*="display: none"]) li'))
    .filter((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    })
    .map((node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 20)
    .join('、')).catch(() => '');
}

async function trySelectVisibleValue(page, value) {
  value = cleanValue(value);
  const domClicked = await clickVisibleDropdownOptionByText(page, selectAliases(value));
  if (domClicked) return true;
  const options = page.locator('.el-select-dropdown:visible .el-select-dropdown__item, .el-cascader__dropdown:visible li, .el-popper:visible li');
  const aliases = selectAliases(value);
  let option = options.filter({ hasText: aliases[0] }).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(aliases[0])}\\s*$`) }).first();
  for (const alias of aliases) {
    if (await option.count()) break;
    option = options.filter({ hasText: alias }).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(alias)}\\s*$`) }).first();
  }
  for (const alias of aliases) {
    if (await option.count()) break;
    option = options.filter({ hasText: alias }).first();
  }
  if (!(await option.count())) return false;
  await option.scrollIntoViewIfNeeded().catch(() => {});
  await option.click({ force: true, timeout: 5000 }).catch(async () => {
    await option.evaluate((element) => element.click());
  });
  return true;
}

async function trySelectStrictVisibleValue(page, value) {
  value = cleanValue(value);
  const aliases = selectAliases(value);
  return page.evaluate((rawAliases) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const aliases = rawAliases.map(normalize).filter(Boolean);
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('.el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item, .el-popper:not([style*="display: none"]) li'));
    const exact = nodes.find((node) => visible(node) && aliases.includes(normalize(node.innerText || node.textContent || '')));
    if (!exact) return false;
    exact.click();
    return true;
  }, aliases).catch(() => false);
}

async function clickVisibleDropdownOptionByText(page, aliases) {
  return page.evaluate((rawAliases) => {
    const aliases = rawAliases.map((item) => String(item || '').trim()).filter(Boolean);
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('.el-select-dropdown:not([style*="display: none"]) .el-select-dropdown__item, .el-popper:not([style*="display: none"]) li'));
    const exact = nodes.find((node) => visible(node) && aliases.some((alias) => (node.innerText || node.textContent || '').trim() === alias));
    if (exact) {
      exact.click();
      return true;
    }
    const partial = nodes.find((node) => visible(node) && aliases.some((alias) => {
      const text = (node.innerText || node.textContent || '').trim();
      return text && (text.includes(alias) || alias.includes(text));
    }));
    if (partial) {
      partial.click();
      return true;
    }
    const scored = nodes
      .filter(visible)
      .map((node) => {
        const text = (node.innerText || node.textContent || '').trim();
        const score = Math.max(...aliases.map((alias) => fuzzyScore(text, alias)));
        return { node, text, score };
      })
      .filter((item) => item.text && item.score >= 0.58)
      .sort((a, b) => b.score - a.score)[0];
    if (scored) {
      scored.node.click();
      return true;
    }
    return false;

    function fuzzyScore(left, right) {
      const a = normalize(left);
      const b = normalize(right);
      if (!a || !b) return 0;
      if (a === b) return 1;
      if (a.includes(b) || b.includes(a)) return 0.86;
      let same = 0;
      for (const char of new Set([...a])) if (b.includes(char)) same += 1;
      return same / Math.max(a.length, b.length);
    }

    function normalize(value) {
      return String(value || '').toLowerCase().replace(/\s+/g, '').replace(/[+＋]/g, 'plus').replace(/[()（）【】\[\]：:]/g, '');
    }
  }, aliases).catch(() => false);
}

async function trySelectByTyping(page, input, value, options = {}) {
  const aliases = selectAliases(value);
  for (const alias of aliases) {
    await input.fill(alias).catch(() => {});
    await input.dispatchEvent('input').catch(() => {});
    await page.waitForTimeout(300);
    if (options.strict ? await trySelectStrictVisibleValue(page, alias) : await trySelectVisibleValue(page, alias)) return true;
    await input.press('Enter').catch(() => {});
    await page.waitForTimeout(300);
    const current = await input.inputValue().catch(() => '');
    if (valueMatchesAnyAlias(current, aliases)) return true;
  }
  return false;
}

function selectAliases(value) {
  const raw = cleanValue(value);
  const aliases = new Set([raw]);
  const age = raw.match(/(\d{1,2})/);
  if (/适龄|年龄|岁|周岁|\+/.test(raw) && age) {
    aliases.add(`${age[1]}+`).add(`${age[1]} +`).add(`${age[1]}岁以上`).add(`${age[1]}周岁以上`).add(`${age[1]}岁`).add(age[1]);
  }
  if (raw === '网游游戏') aliases.add('网络游戏').add('网游');
  if (raw === '网络游戏') aliases.add('网游游戏').add('网游');
  if (raw === '单机游戏') aliases.add('单机');
  if (/^[A-Z]$/i.test(raw)) aliases.add(raw.toUpperCase()).add(raw.toLowerCase()).add(`${raw.toUpperCase()}级`).add(`${raw.toUpperCase()}类`);
  if (raw === '无合作') aliases.add('无');
  if (/^\d+\+$/.test(raw)) aliases.add(raw.replace('+', '')).add(`${raw.replace('+', '')} +`);
  return [...aliases].filter(Boolean);
}

function valueMatchesAnyAlias(current, aliases) {
  const text = cleanValue(current);
  const currentAliases = selectAliases(text);
  return aliases.some((alias) => currentAliases.some((currentAlias) =>
    currentAlias === alias || currentAlias.includes(alias) || alias.includes(currentAlias)
  ));
}

async function setFileByLabel(page, labelText, filePathOrPaths) {
  if (labelText === '游戏图标') return setGameIconFile(page, filePathOrPaths);
  let input = await firstExistingLocator(page, fileInputCandidates(page, labelText));
  await input.waitFor({ state: 'attached', timeout: 10000 });
  const before = await uploadSnapshot(page);
  await input.setInputFiles(filePathOrPaths);
  await waitForUploadDone(page, before, labelText);
}

async function setGameIconFile(page, filePath) {
  const input = await findGameIconFileInput(page);
  await input.waitFor({ state: 'attached', timeout: 10000 });
  const before = await gameIconSnapshot(page);
  await input.setInputFiles(filePath);
  await waitForGameIconUploaded(page, before);
}

async function findGameIconFileInput(page) {
  const marked = await page.evaluate(() => {
    const visibleBox = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 40 && rect.height > 40;
    };
    const labelNodes = Array.from(document.querySelectorAll('.el-form-item, .form-item, div, section'))
      .filter((node) => /游戏图标/.test((node.innerText || node.textContent || '').replace(/\s+/g, '')));
    for (const node of labelNodes) {
      const input = node.querySelector('input[type="file"]');
      if (input) {
        input.setAttribute('data-game-importer-icon-input', 'true');
        return true;
      }
    }
    const uploadBoxes = Array.from(document.querySelectorAll('.el-upload, .el-upload-dragger, .game-icon-item, .avatar-uploader, .icon-uploader, [class*="icon"]'))
      .filter(visibleBox)
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return ar.top - br.top || ar.left - br.left;
      });
    for (const box of uploadBoxes) {
      const text = (box.innerText || box.textContent || '').replace(/\s+/g, '');
      const rect = box.getBoundingClientRect();
      const looksLikeIconBox = rect.width >= 80 && rect.width <= 180 && rect.height >= 80 && rect.height <= 180 && /[\+＋]/.test(text || '+');
      const input = box.querySelector('input[type="file"]') || box.closest('.el-upload, .el-form-item, .form-item, div')?.querySelector?.('input[type="file"]');
      if (looksLikeIconBox && input) {
        input.setAttribute('data-game-importer-icon-input', 'true');
        return true;
      }
    }
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const picked = fileInputs.find((input) => !input.multiple && !/apk/i.test(input.accept || ''));
    if (picked) {
      picked.setAttribute('data-game-importer-icon-input', 'true');
      return true;
    }
    return false;
  }).catch(() => false);
  if (marked) {
    const input = page.locator('input[data-game-importer-icon-input="true"]').last();
    if (await input.count()) return input;
  }
  return firstExistingLocator(page, fileInputCandidates(page, '游戏图标'));
}

async function gameIconSnapshot(page) {
  return page.evaluate(() => {
    const scope = Array.from(document.querySelectorAll('.el-form-item, .form-item, div, section'))
      .find((node) => /游戏图标/.test((node.innerText || node.textContent || '').replace(/\s+/g, ''))) || document;
    const images = Array.from(scope.querySelectorAll('img')).map((img) => img.currentSrc || img.src || '').filter(Boolean);
    return {
      images,
      imageCount: images.length,
      text: (scope.innerText || scope.textContent || '').replace(/\s+/g, ' ').trim(),
    };
  }).catch(() => ({ images: [], imageCount: 0, text: '' }));
}

async function waitForGameIconUploaded(page, before) {
  await page.waitForFunction((state) => {
    const visible = (node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const scopes = Array.from(document.querySelectorAll('.el-form-item, .form-item, div, section'))
      .filter((node) => visible(node) && /游戏图标/.test((node.innerText || node.textContent || '').replace(/\s+/g, '')));
    const scope = scopes[0] || document;
    const text = document.body.innerText || '';
    if (/上传失败|文件大小|格式不支持|失败|错误/.test(text)) return 'ICON_UPLOAD_ERROR:' + text.slice(-300);
    const images = Array.from(scope.querySelectorAll('img')).map((img) => img.currentSrc || img.src || '').filter(Boolean);
    if (images.length > state.imageCount) return true;
    if (images.some((src) => !state.images.includes(src))) return true;
    const hasPreview = Array.from(scope.querySelectorAll('.el-upload-list__item.is-success, .el-image, [class*="preview"], [class*="avatar"] img, [class*="icon"] img')).some(visible);
    return hasPreview;
  }, before, { timeout: 120000 });
}

function fileInputCandidates(page, labelText) {
  const item = formItem(page, labelText).first();
  const fallback = item.locator('input[type=file]').first();
  if (labelText === '游戏图标') return [
    page.locator('.game-icon-item input[type=file]').first(),
    page.locator('.avatar-uploader input[type=file], .icon-uploader input[type=file], [class*="icon"] input[type=file]').first(),
    page.locator('.el-upload input[type=file]').filter({ hasNot: page.locator('[multiple]') }).first(),
    fallback,
  ];
  if (labelText === '图集') return [page.locator('.game-form-gallery input[type=file]').first(), fallback];
  if (labelText === '首页大图') return [page.locator('.home-image input[type=file]').first(), fallback];
  if (labelText === '专题封面图') return [page.locator('.home-image input[type=file]').nth(1), fallback];
  if (labelText === 'APK包') return [page.locator('.upload-mode input[type=file], .apk-info input[type=file][accept*=".apk"], .api-package-container input[type=file][accept*=".apk"]').first(), fallback];
  return [fallback];
}

async function firstExistingLocator(page, locators) {
  for (const locator of locators) {
    if (await locator.count().catch(() => 0)) return locator;
  }
  throw new Error('找不到上传控件');
}

async function applyTags(page, tagText) {
  if (!tagText) return;
  const tags = tagText.split(/[，,、\n]/).map((x) => x.trim()).filter(Boolean);
  if (!tags.length) return;

  await page.locator('.type-tag').filter({ hasText: '游戏标签' }).locator('.inner-edit-tag').first().click();
  const dialog = await waitForTagDialog(page);

  for (const tag of tags) {
    progress(`添加游戏标签：${tag}`);
    await addGameTagFromDialog(page, dialog, tag);
  }

  await confirmTagDialog(page, dialog);
}

async function waitForTagDialog(page) {
  const dialog = page.locator('.el-dialog:visible, .el-drawer:visible, .el-popover:visible').filter({ hasText: /标签|搜索|添加/ }).last();
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  return dialog;
}

async function addGameTagFromDialog(page, dialog, tag) {
  const alreadySelected = dialog.locator('.selected-tags, .el-tag, .tag-selected, .selected').filter({ hasText: new RegExp(`^\\s*${escapeRegExp(tag)}\\s*$`) }).first();
  if (await alreadySelected.isVisible().catch(() => false)) return;

  const searchInput = dialog.locator('input[placeholder*="搜索"], input[placeholder*="标签"], input').first();
  await searchInput.waitFor({ state: 'visible', timeout: 10000 });
  await searchInput.fill(tag);
  await searchInput.dispatchEvent('input');
  await page.waitForTimeout(700);

  const exactText = new RegExp(`^\\s*${escapeRegExp(tag)}\\s*$`);
  const row = await findExactTagRow(dialog, tag);
  if (!(await row.isVisible().catch(() => false))) {
    const visibleOptions = await readVisibleTagOptions(dialog);
    throw new Error(`标签没有精确匹配：${tag}${visibleOptions.length ? `；当前可见候选：${visibleOptions.join('、')}` : ''}`);
  }

  const actionButton = row.getByRole('button', { name: /添加|选择|选中/ }).first();
  if (await actionButton.isVisible().catch(() => false)) {
    await actionButton.click();
    await page.waitForTimeout(300);
    return;
  }

  const checkbox = row.locator('input[type=checkbox], .el-checkbox__inner').first();
  if (await checkbox.isVisible().catch(() => false)) {
    await checkbox.click({ force: true });
    await page.waitForTimeout(300);
    return;
  }

  const exactNode = row.locator('span, div').filter({ hasText: exactText }).first();
  if (await exactNode.isVisible().catch(() => false)) {
    await exactNode.click({ force: true });
  } else {
    await row.click({ force: true });
  }
  await page.waitForTimeout(300);
}

async function findExactTagRow(dialog, tag) {
  const exactText = new RegExp(`^\\s*${escapeRegExp(tag)}\\s*$`);
  const candidates = dialog.locator('.el-table__row, tr, li, .tag-item, .el-checkbox');
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const exactNode = candidate.locator('span, div, label').filter({ hasText: exactText }).first();
    if (await exactNode.isVisible().catch(() => false)) return candidate;
  }
  return dialog.locator('__never_match__');
}

async function readVisibleTagOptions(dialog) {
  return dialog.evaluate((root) => {
    const nodes = Array.from(root.querySelectorAll('.el-table__row, tr, li, .tag-item, .el-checkbox, .el-tag'));
    return nodes
      .filter((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      })
      .map((node) => (node.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 12);
  }).catch(() => []);
}

async function confirmTagDialog(page, dialog) {
  const confirmButton = dialog.getByRole('button', { name: /确定|确认|保存/ }).last();
  if (await confirmButton.isVisible().catch(() => false)) {
    await confirmButton.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(500);
}

function formItem(page, labelText) {
  return page.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label', { hasText: labelText }) });
}

async function scrollToSection(page, id) {
  await page.evaluate((sectionId) => document.getElementById(sectionId)?.scrollIntoView({ block: 'start' }), id);
  await page.waitForTimeout(300);
}

async function uploadSnapshot(page) {
  return page.evaluate(() => ({
    uploaded: document.querySelectorAll('.el-upload-list__item:not(.is-uploading), .el-upload-list__item.is-success, .gallery-wrapper img, .game-icon-item img, .home-wrapper img').length,
    text: document.body.innerText || '',
  })).catch(() => ({ uploaded: 0, text: '' }));
}

async function waitForUploadDone(page, before, labelText) {
  await page.waitForFunction((state) => {
    const text = document.body.innerText || '';
    const uploading = document.querySelector('.el-upload-list__item.is-uploading, .el-progress');
    const uploaded = document.querySelectorAll('.el-upload-list__item:not(.is-uploading), .el-upload-list__item.is-success, .gallery-wrapper img, .game-icon-item img, .home-wrapper img').length;
    if (/上传失败|文件大小|格式不支持|失败|错误/.test(text)) return 'UPLOAD_ERROR:' + text.slice(-300);
    return !uploading && uploaded >= state.beforeUploaded;
  }, { beforeUploaded: before.uploaded, labelText }, { timeout: 120000 });
}

function getApkConfig(game) {
  const rawMode = (game.data['安装包管理'] || '').trim();
  const fillLink = getApkLink(game.data);
  if (fillLink) return { mode: '填写', link: fillLink.trim() };
  if (rawMode.includes('填写')) return { mode: '填写', link: '' };
  if (rawMode.includes('上传')) return { mode: '上传', link: '' };
  return { mode: game.apk ? '上传' : '填写', link: '' };
}

function applyDefaultImportFields(data) {
  if (!cleanValue(data['测试类型'])) data['测试类型'] = '公测';
  if (!cleanValue(data['下载状态'])) data['下载状态'] = '开启';
  if (!cleanValue(data['开发者类型'])) data['开发者类型'] = '企业开发者';
  if (!cleanValue(data['平台'])) data['平台'] = defaultPlatform(data);
  if (!cleanValue(data['合作方式'])) data['合作方式'] = defaultCooperation(data['平台']);
  if (!Object.prototype.hasOwnProperty.call(data, '备注')) data['备注'] = '';
  data['平台'] = normalizePlatform(data['平台']);
  data['合作方式'] = normalizeCooperation(data['合作方式'], data['平台']);
}

function defaultPlatform(data) {
  const text = Object.values(data || {}).join(' ');
  if (/九游/.test(text)) return '九游';
  if (/指趣/.test(text)) return '指趣';
  return '官方';
}

function defaultCooperation(platform) {
  const normalized = normalizePlatform(platform);
  if (normalized === '九游' || normalized === '指趣') return 'S';
  return '无合作';
}

function normalizePlatform(value) {
  const raw = cleanValue(value);
  if (!raw) return '官方';
  const normalized = raw.replace(/\s+/g, '').toLowerCase();
  const found = validPlatforms.find((item) => item.replace(/\s+/g, '').toLowerCase() === normalized);
  return found || raw;
}

function normalizeCooperation(value, platform) {
  const raw = cleanValue(value);
  if (!raw) return defaultCooperation(platform);
  if (/^无$|无合作/.test(raw)) return '无合作';
  const upper = raw.toUpperCase();
  return validCooperations.includes(upper) ? upper : raw;
}

function normalizeChoice(value, options, fallback) {
  const raw = cleanValue(value);
  if (!raw) return fallback;
  const normalized = raw.replace(/\s+/g, '').toLowerCase();
  return options.find((item) => item.replace(/\s+/g, '').toLowerCase() === normalized) || raw;
}

function getApkLink(data) {
  const keys = ['填写', '链接', 'APK链接', 'APK下载链接', '下载链接', '下载地址', '安装包链接', '安装包下载链接'];
  for (const key of keys) {
    const value = String(data[key] || '').trim();
    if (/^https?:\/\//i.test(value)) return value;
  }
  return '';
}

async function clickApkPermissionFetch(page) {
  const section = page.locator('.apk-info, .api-package-container').filter({ hasText: '权限获取' }).last();
  const button = section.getByRole('button', { name: '权限获取' }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
}

async function waitForApkMetadata(page, timeout = 120000) {
  const started = Date.now();
  let lastMessage = '';
  while (Date.now() - started < timeout) {
    const metadata = await readApkMetadata(page).catch(() => ({}));
    if (metadata.packageName && metadata.version && metadata.size) {
      await page.waitForTimeout(500);
      return { status: 'ok', message: '已通过权限获取解析包名、版本和包体大小' };
    }

    const message = await readVisibleApkMessage(page);
    if (message) {
      lastMessage = message;
      if (/不支持|失败|错误|异常|不能为空|请上传|请填写/i.test(message)) {
        return { status: 'failed', message };
      }
    }

    await page.waitForTimeout(1000);
  }

  return { status: 'timeout', message: lastMessage || '等待包名、版本、包体大小回填超时' };
}

async function readApkMetadata(page) {
  return page.evaluate(() => {
    const scope = document.querySelector('.apk-info .fillin-mode, .api-package-container .fillin-mode, .apk-info, .api-package-container') || document;
    const inputs = Array.from(scope.querySelectorAll('input'));
    const findValue = (placeholder) => inputs.find((input) => (input.getAttribute('placeholder') || '').includes(placeholder))?.value || '';
    return {
      packageName: findValue('包名'),
      version: findValue('版本'),
      bitness: findValue('游戏位数'),
      versionCode: findValue('version code'),
      size: findValue('大小'),
    };
  });
}

async function readVisibleApkMessage(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('.el-message, .el-alert, .el-notification, .el-form-item__error'));
    const lines = nodes
      .filter((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      })
      .map((node) => (node.innerText || '').trim())
      .filter(Boolean)
      .join('\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.find((line) => !/xapk包暂时不支持通过填写链接的方式/.test(line) && /安装包|APK|下载链接|包名|版本|大小|权限获取/i.test(line) && /失败|错误|异常|不能为空|请上传|请填写/i.test(line)) || '';
  });
}

async function waitForSubmitResult(page, timeoutMs = 70000) {
  const started = Date.now();
  await page.waitForTimeout(300);
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => {
      const visible = (selector) => Array.from(document.querySelectorAll(selector)).some((node) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      });
      const visibleText = (selector) => Array.from(document.querySelectorAll(selector))
        .filter((node) => {
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
        })
        .map((node) => (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('；');
      const errorText = visibleText('.el-message--error, .el-form-item__error, .el-alert--error, .el-notification.error');
      if (errorText) return { status: 'error', text: errorText.slice(-500) };
      if (visible('.el-message--success') || visible('.el-notification.success')) return { status: 'ok' };
      const addButton = Array.from(document.querySelectorAll('button')).some((button) => (button.innerText || '').includes('添加游戏'));
      const editFormVisible = visible('.game-edit-form');
      if (addButton && !editFormVisible) return { status: 'ok' };
      if (location.href.includes('/games-manage/games-info') && addButton) return { status: 'ok' };
      return { status: 'waiting' };
    }).catch(() => ({ status: 'waiting' }));
    if (state.status === 'ok') return;
    if (state.status === 'error') throw new Error(`提交后页面出现错误提示：${state.text || ''}`);
    await page.waitForTimeout(400);
  }
  progress('未捕获到成功提示，但提交等待已超时；将继续检查列表结果');
}

async function closeAddDialog(page) {
  const closeButton = page.getByRole('button', { name: '关闭' }).last();
  if (await closeButton.isVisible().catch(() => false)) await closeButton.click();
}

function normalizeDate(value) {
  if (!value) return '';
  if (value === '当前时间') {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  return String(value).replace(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/, (_, y, m, d) => `${y}-${pad(m)}-${pad(d)}`);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function record(entry) {
  appendFileSync(jsonlPath, `${JSON.stringify(entry, null, 0)}\n`, 'utf8');
  appendCsv(entry);
}

function appendCsv(entry) {
  const columns = ['finishedAt', 'game', 'status', 'apkMode', 'apkLink', 'packageName', 'version', 'size', 'apkFetchStatus', 'apkFetchMessage', 'platform', 'cooperation', 'error', 'screenshot'];
  if (!existsSync(csvPath)) appendFileSync(csvPath, `\uFEFF${columns.join(',')}\n`, 'utf8');
  appendFileSync(csvPath, `${columns.map((key) => csvCell(entry[key] || '')).join(',')}\n`, 'utf8');
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function cleanValue(value) {
  return String(value ?? '').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function progress(message) {
  const text = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`;
  console.log(text);
}

function safeName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function cssEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
