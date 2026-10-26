import { chromium } from 'playwright';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const ADMIN_URL = 'https://and-admin.ghzs.com/#/games-manage/games-info?href=games_info_menu';
const SSO_HOST = 'sso.ghzs.com';

const args = parseArgs(process.argv.slice(2));
const toolRoot = path.resolve(import.meta.dirname, '..');
const sourceRoot = path.resolve(args.source || 'E:/新建文件夹/游戏资料');
const sessionDir = path.resolve(args['session-dir'] || path.join(toolRoot, '浏览器登录状态'));
const resultDir = path.resolve(args['result-dir'] || sourceRoot);
const screenshotDir = path.join(resultDir, '失败截图');
const csvPath = path.join(resultDir, '游戏资料登记表.csv');
const jsonlPath = path.join(resultDir, '游戏资料登记明细.jsonl');

const submit = Boolean(args.submit);
const dryRun = !submit;
const manualLogin = Boolean(args['manual-login']);
const canUpload = submit || Boolean(args['upload-in-dry-run']);
const canFetchApk = submit || Boolean(args['fetch-apk-in-dry-run']);
const autoShow = args['no-auto-show'] ? false : true;
const headed = manualLogin || args.headless ? !args.headless : true;

mkdirSync(screenshotDir, { recursive: true });

if (args['wait-login']) {
  await withBrowser(async ({ page }) => {
    await waitManualLogin(page);
    progress('登录状态已保存，可以关闭浏览器窗口或直接开始导入');
  }, { manual: true, keepOpen: Boolean(args.keepOpen) });
  process.exit(0);
}

if (args['login-check']) {
  const loggedIn = await checkLoginState();
  progress(loggedIn ? '已检测到后台登录状态' : '未检测到后台登录状态，请先手动登录');
  process.exit(loggedIn ? 0 : 2);
}

if (!manualLogin && (!process.env.GHZS_ADMIN_USER || !process.env.GHZS_ADMIN_PASS)) {
  throw new Error('自动登录模式需要先设置 GHZS_ADMIN_USER 和 GHZS_ADMIN_PASS。推荐使用界面的手动登录模式。');
}

const games = discoverGames(sourceRoot);
if (!games.length) throw new Error(`没有找到游戏资料文件：${sourceRoot}`);

await withBrowser(async ({ page }) => {
  await login(page);
  progress(`共发现 ${games.length} 个游戏资料`);

  let failures = 0;
  for (let index = 0; index < games.length; index += 1) {
    const game = games[index];
    const startedAt = new Date().toISOString();
    const gameName = game.data['游戏名称'] || game.dirName;
    progress(`开始处理 ${index + 1}/${games.length}：${gameName}`);

    try {
      const result = await importOne(page, game);
      const entry = {
        处理时间: new Date().toLocaleString('zh-CN', { hour12: false }),
        游戏名称: gameName,
        游戏ID: result.gameId || '',
        处理状态: dryRun ? '安全预演完成' : '已提交',
        是否自己显示: result.showStatus || (dryRun ? '未执行' : ''),
        APK方式: result.apkMode || '',
        APK链接: result.apkLink || '',
        包名: result.packageName || '',
        版本: result.version || '',
        游戏大小: result.size || '',
        权限获取状态: result.apkFetchStatus || '',
        权限获取说明: result.apkFetchMessage || '',
        平台: game.data['平台'] || '',
        合作方式: game.data['合作方式'] || '',
        资料文件夹: game.dir,
        失败原因: '',
        失败截图: '',
        开始时间: startedAt,
        完成时间: new Date().toISOString(),
      };
      record(entry);
      progress(`完成：${gameName}`);
    } catch (error) {
      failures += 1;
      const shot = path.join(screenshotDir, `${safeName(gameName)}-${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      const entry = {
        处理时间: new Date().toLocaleString('zh-CN', { hour12: false }),
        游戏名称: gameName,
        游戏ID: '',
        处理状态: '失败',
        是否自己显示: '',
        APK方式: '',
        APK链接: '',
        包名: '',
        版本: '',
        游戏大小: '',
        权限获取状态: '',
        权限获取说明: '',
        平台: game.data['平台'] || '',
        合作方式: game.data['合作方式'] || '',
        资料文件夹: game.dir,
        失败原因: String(error?.message || error),
        失败截图: shot,
        开始时间: startedAt,
        完成时间: new Date().toISOString(),
      };
      record(entry);
      progress(`失败：${gameName} -> ${entry.失败原因}`);
      await closeAddDialog(page).catch(() => {});
    }
  }

  if (failures > 0) process.exitCode = 1;
}, { manual: manualLogin, keepOpen: Boolean(args.keepOpen) });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

async function withBrowser(callback, options = {}) {
  const manual = Boolean(options.manual);
  const visible = options.visible ?? manual;
  const browser = manual ? null : await chromium.launch({ channel: 'msedge', headless: !headed });
  const context = manual
    ? await chromium.launchPersistentContext(sessionDir, {
        channel: 'msedge',
        headless: !visible,
        viewport: { width: 1440, height: 960 },
        acceptDownloads: true,
      })
    : await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const page = context.pages()[0] || await context.newPage();

  try {
    await callback({ page, context });
  } finally {
    if (!options.keepOpen) {
      await context.close().catch(() => {});
      if (browser) await browser.close().catch(() => {});
    }
  }
}

async function checkLoginState() {
  let loggedIn = false;
  await withBrowser(async ({ page }) => {
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    loggedIn = page.url().includes('and-admin.ghzs.com') && !(await isSsoPage(page));
  }, { manual: true, visible: false });
  return loggedIn;
}

async function waitManualLogin(page) {
  await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' });
  if (await isSsoPage(page)) {
    progress('请在打开的 Edge 窗口中手动登录后台');
    await page.waitForURL((url) => url.host === 'and-admin.ghzs.com', { timeout: 300000 });
  }
  await openGamesInfo(page);
}

async function login(page) {
  await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  if (manualLogin) {
    if (await isSsoPage(page)) {
      progress('请在打开的 Edge 窗口中手动登录后台，登录成功后工具会继续执行');
      await page.waitForURL((url) => url.host === 'and-admin.ghzs.com', { timeout: 300000 });
    }
    await openGamesInfo(page);
    return;
  }

  if (await isSsoPage(page)) {
    await page.fill('input[name="username"], input[autocomplete="username"], input[type="text"]', process.env.GHZS_ADMIN_USER);
    await page.fill('input[name="password"], input[autocomplete="current-password"], input[type="password"]', process.env.GHZS_ADMIN_PASS);
    await page.click('button:has-text("SIGN IN"), button[type="submit"]');
    await page.waitForURL((url) => url.host === 'and-admin.ghzs.com', { timeout: 60000 });
  }
  await openGamesInfo(page);
}

async function isSsoPage(page) {
  return new URL(page.url()).host === SSO_HOST || /Authelia/i.test(await page.title().catch(() => ''));
}

async function openGamesInfo(page) {
  if (!page.url().includes('/games-manage/games-info')) {
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await page.waitForSelector('button:has-text("添加游戏"), text=游戏名称/副标题', { timeout: 60000 });
}

function discoverGames(rootDir) {
  if (!existsSync(rootDir)) throw new Error(`资料路径不存在：${rootDir}`);
  if (statSync(rootDir).isFile()) return [readGameDir(path.dirname(rootDir), path.basename(rootDir))];

  const games = [];
  const infoFile = args['info-file'] || '游戏资料.txt';
  walk(rootDir, 0);
  return games;

  function walk(dir, depth) {
    const directInfo = path.join(dir, infoFile);
    if (existsSync(directInfo)) {
      games.push(readGameDir(dir, infoFile));
      return;
    }
    if (depth >= 3) return;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, depth + 1);
    }
  }
}

function readGameDir(dir, infoFile = '游戏资料.txt') {
  const data = parseInfo(readFileSync(path.join(dir, infoFile), 'utf8'));
  const files = readdirSync(dir).map((name) => path.join(dir, name));
  const galleryDir = path.join(dir, '图集');
  const gallery = existsSync(galleryDir)
    ? readdirSync(galleryDir).map((name) => path.join(galleryDir, name)).filter(isImage)
    : files.filter((file) => isImage(file) && /^\d+\./.test(path.basename(file)));

  return {
    dir,
    dirName: path.basename(dir),
    infoFile,
    data,
    icon: files.find((file) => /^icon\.(png|jpg|jpeg|webp)$/i.test(path.basename(file))) || files.find((file) => /图标|ICON/i.test(path.basename(file))),
    gallery: gallery.sort(naturalCompare),
    homeImage: files.find((file) => /首页大图/i.test(path.basename(file))),
    coverImage: files.find((file) => /专题封面/i.test(path.basename(file))),
    apk: files.find((file) => /\.apk$/i.test(file)),
  };
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
  return data;
}

async function importOne(page, game) {
  const data = game.data;
  const gameName = data['游戏名称'] || game.dirName;

  await openGamesInfo(page);
  await page.getByRole('button', { name: '添加游戏' }).click();
  await page.locator('.game-edit-form').or(page.getByText('基础信息设置')).first().waitFor({ state: 'visible', timeout: 30000 });

  await fillByLabel(page, '游戏名称', gameName);
  await selectByLabel(page, '游戏类型', normalizeGameType(data['游戏类型']));
  await fillByLabel(page, '游戏副标题', data['游戏副标题']);
  if (data['适龄等级']) await selectByLabel(page, '适龄等级', data['适龄等级']);
  await fillByLabel(page, '简介', data['简介']);
  await fillByLabel(page, '游戏介绍', data['游戏介绍']);

  if (canUpload && game.icon) await setFileByLabel(page, '游戏图标', game.icon);
  if (canUpload && game.gallery.length) await setFileByLabel(page, '图集', game.gallery);

  if (data['测试类型']) await selectByLabel(page, '测试类型', data['测试类型']);
  await fillByLabel(page, '开测时间', normalizeDate(data['开测时间']));
  await fillByLabel(page, '发布时间', normalizeDate(data['发布时间']));
  if (data['下载状态']) await selectByLabel(page, '下载状态', normalizeDownloadStatus(data['下载状态']));

  const apkResult = await configureApk(page, game);

  await fillByLabel(page, '名称', data['名称']);
  await fillByLabel(page, '地区', data['地区']);
  await fillByLabel(page, '供应商', data['供应商']);
  await fillByLabel(page, '统一社会信用代码', data['统一社会信用代码']);
  await fillByLabel(page, 'ICP备案号', data['ICP备案号']);

  await applyTags(page, data['标签']);

  if (canUpload && game.homeImage) await setFileByLabel(page, '首页大图', game.homeImage);
  if (canUpload && game.coverImage) await setFileByLabel(page, '专题封面图', game.coverImage);

  if (dryRun) {
    await page.waitForTimeout(1000);
    return apkResult;
  }

  await page.getByRole('button', { name: /提交并离开|提交/ }).click();
  await waitForSubmitResult(page);
  await openGamesInfo(page);

  const listResult = await collectListInfoAndShow(page, gameName);
  return { ...apkResult, ...listResult };
}

async function configureApk(page, game) {
  const apkConfig = getApkConfig(game);
  const mode = apkConfig.mode;
  let apkFetchStatus = '';
  let apkFetchMessage = '';

  await scrollToSection(page, 'download-install');
  progress(`APK方式：${mode}`);
  await selectByLabel(page, 'APK包', mode);

  if (mode.includes('上传')) {
    if (!game.apk) throw new Error('资料中选择上传安装包，但没有找到 .apk 文件。');
    if (canUpload) {
      await setFileByLabel(page, 'APK包', game.apk);
      await waitForUploadQuiet(page);
    }
  } else if (apkConfig.link) {
    await fillByPlaceholder(page, '填写APK下载链接', apkConfig.link);
    if (canFetchApk) {
      progress('点击权限获取，等待后台抓取包名、版本和大小');
      await clickApkPermissionFetch(page);
      const fetchResult = await waitForApkMetadata(page);
      apkFetchStatus = fetchResult.status;
      apkFetchMessage = fetchResult.message;
      if (fetchResult.status !== 'ok') {
        progress(`权限获取未完成：${fetchResult.message}`);
        if (submit) throw new Error(`权限获取失败：${fetchResult.message}`);
      }
    }
  }

  if (game.data['平台']) await selectApkField(page, '平台', game.data['平台']);
  if (game.data['合作方式']) await selectApkField(page, '合作方式', game.data['合作方式']);
  const metadata = await readApkMetadata(page).catch(() => ({}));
  return { apkMode: mode, apkLink: apkConfig.link || '', apkFetchStatus, apkFetchMessage, ...metadata };
}

async function collectListInfoAndShow(page, gameName) {
  const row = await findGameRow(page, gameName);
  const gameId = await fetchGameIdFromRow(page, row);
  let showStatus = '';
  if (autoShow) showStatus = await clickSelfShow(page, row);
  return { gameId, showStatus };
}

async function findGameRow(page, gameName) {
  await openGamesInfo(page);
  const search = page.locator('input[placeholder*="搜索"], input[placeholder*="关键字"]').first();
  await search.fill(gameName);
  await search.press('Enter').catch(() => {});
  await page.waitForTimeout(1500);
  const row = page.locator('.el-table__body-wrapper tbody tr, table tbody tr').filter({ hasText: gameName }).first();
  await row.waitFor({ state: 'visible', timeout: 30000 });
  return row;
}

async function fetchGameIdFromRow(page, row) {
  const existing = await page.locator('.el-popover:visible, .el-popper:visible').evaluateAll((nodes) => nodes.map((node) => node.innerText).join('\n')).catch(() => '');
  const existingMatch = existing.match(/[a-f0-9]{16,}/i);
  if (existingMatch) return existingMatch[0];

  const cells = row.locator('td');
  const nameCell = cells.nth(2);
  const clickables = nameCell.locator('a, button, i, svg, .el-icon, [class*="link"], [class*="copy"]');
  const count = await clickables.count();
  for (let i = 0; i < count; i += 1) {
    await clickables.nth(i).click({ force: true, timeout: 3000 }).catch(() => {});
    const id = await readGameIdFromPopover(page);
    if (id) return id;
  }
  return '';
}

async function readGameIdFromPopover(page) {
  await page.waitForTimeout(500);
  const text = await page.locator('.el-popover:visible, .el-popper:visible, body').evaluateAll((nodes) => nodes.map((node) => node.innerText || '').join('\n')).catch(() => '');
  return text.match(/[a-f0-9]{16,}/i)?.[0] || '';
}

async function clickSelfShow(page, row) {
  const actionCell = row.locator('td').last();
  const buttons = actionCell.locator('button, i, svg, .el-button, [class*="icon"]');
  const count = await buttons.count();
  for (let i = 0; i < count; i += 1) {
    const beforeDialog = await page.locator('.el-message-box:visible, .el-dialog:visible').count();
    await buttons.nth(i).click({ force: true, timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(500);
    const confirm = page.getByRole('button', { name: '确定' }).last();
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
      await page.waitForTimeout(1000);
      return '已点击自己显示';
    }
    const afterDialog = await page.locator('.el-message-box:visible, .el-dialog:visible').count();
    if (afterDialog > beforeDialog) await page.keyboard.press('Escape').catch(() => {});
  }
  return '未找到自己显示按钮';
}

async function fillByLabel(page, labelText, value) {
  if (!value) return;
  const item = formItem(page, labelText).first();
  const control = item.locator('textarea, input:not([type=file]):not([type=checkbox]):not([type=button])').first();
  await control.scrollIntoViewIfNeeded();
  if (!(await control.isEnabled())) return;
  await control.fill(String(value));
  await control.dispatchEvent('input');
  await control.dispatchEvent('change');
}

async function fillByPlaceholder(page, placeholder, value) {
  if (!value) return;
  const control = page.locator(`input[placeholder="${cssEscape(placeholder)}"], textarea[placeholder="${cssEscape(placeholder)}"]`).first();
  await control.scrollIntoViewIfNeeded();
  await control.fill(String(value));
  await control.dispatchEvent('input');
  await control.dispatchEvent('change');
}

async function selectByLabel(page, labelText, value) {
  value = cleanValue(value);
  if (!value) return;
  const item = formItem(page, labelText).first();
  const input = item.locator('.el-select input, input[readonly]').first();
  await input.scrollIntoViewIfNeeded();
  await input.click();
  await selectVisibleValue(page, value);
}

async function selectApkField(page, logicalName, value) {
  value = cleanValue(value);
  if (!value) return;
  const section = page.locator('.apk-info, .api-package-container').filter({ hasText: 'APK包' }).last();
  const candidates = section.locator('.el-select input');
  const count = await candidates.count();
  const pattern = logicalName === '平台' ? /官方|九游|应用宝|小米|百度|360|当乐/ : /合作|无合作|A|B|C|S/;
  for (let i = 0; i < count; i += 1) {
    const input = candidates.nth(i);
    const current = await input.inputValue().catch(() => '');
    if (pattern.test(current)) {
      await input.scrollIntoViewIfNeeded();
      await input.click();
      await selectVisibleValue(page, value);
      return;
    }
  }
  throw new Error(`找不到 APK ${logicalName} 选择框`);
}

async function selectVisibleValue(page, value) {
  value = cleanValue(value);
  const options = page.locator('.el-select-dropdown:visible .el-select-dropdown__item, .el-cascader__dropdown:visible li, .el-popper:visible li');
  let option = options.filter({ hasText: value }).filter({ hasText: new RegExp(`^\\s*${escapeRegExp(value)}\\s*$`) }).first();
  if (!(await option.count())) option = options.filter({ hasText: value }).first();
  await option.waitFor({ state: 'visible', timeout: 10000 });
  await option.scrollIntoViewIfNeeded().catch(() => {});
  await option.click({ force: true, timeout: 5000 }).catch(async () => option.evaluate((element) => element.click()));
}

async function setFileByLabel(page, labelText, filePathOrPaths) {
  const item = formItem(page, labelText).first();
  const input = item.locator('input[type=file]').first();
  await input.setInputFiles(filePathOrPaths);
  await waitForUploadQuiet(page);
}

async function applyTags(page, tagText) {
  if (!tagText) return;
  const tags = tagText.split(/[，、,\n]/).map((x) => x.trim()).filter(Boolean);
  for (const tag of tags) {
    const tagButton = page.locator('.tag-option, button, span').filter({ hasText: tag }).first();
    if (await tagButton.isVisible().catch(() => false)) {
      await tagButton.click();
      await page.waitForTimeout(100);
    }
  }
}

function formItem(page, labelText) {
  return page.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label', { hasText: labelText }) });
}

async function scrollToSection(page, id) {
  await page.evaluate((sectionId) => document.getElementById(sectionId)?.scrollIntoView({ block: 'start' }), id);
  await page.waitForTimeout(300);
}

async function waitForUploadQuiet(page) {
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => {
    const text = document.body.innerText;
    const active = document.querySelector('.el-upload-list__item.is-uploading, .el-loading-mask, .el-progress');
    return !active && !/上传中|正在上传/.test(text);
  }, null, { timeout: 120000 }).catch(() => {});
}

function getApkConfig(game) {
  const rawMode = (game.data['安装包管理'] || '').trim();
  const fillLink = game.data['填写'] || game.data['APK下载链接'] || game.data['下载链接'] || '';
  if (fillLink) return { mode: '填写', link: fillLink.trim() };
  if (rawMode.includes('填写')) return { mode: '填写', link: '' };
  if (rawMode.includes('上传')) return { mode: '上传', link: '' };
  return { mode: game.apk ? '上传' : '填写', link: '' };
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
      return { status: '成功', message: '已抓取包名、版本和大小' };
    }

    const message = await readVisibleApkMessage(page);
    if (message) {
      lastMessage = message;
      if (/不支持|失败|错误|异常|不能为空|请上传|请填写/i.test(message)) {
        return { status: '失败', message };
      }
    }
    await page.waitForTimeout(1000);
  }
  return { status: '超时', message: lastMessage || '等待包名、版本、大小回填超时' };
}

async function readApkMetadata(page) {
  return page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    const findValue = (placeholder) => inputs.find((input) => (input.getAttribute('placeholder') || '').includes(placeholder))?.value || '';
    return {
      packageName: findValue('包名'),
      version: findValue('版本'),
      size: findValue('大小'),
    };
  });
}

async function readVisibleApkMessage(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('.el-message, .el-alert, .el-notification, .apk-info, .api-package-container'));
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
    return lines.find((line) => /xapk|安装包|APK|下载链接|包名|版本|大小/i.test(line) && /不支持|失败|错误|异常|不能为空|请上传|请填写/i.test(line)) || '';
  });
}

async function waitForSubmitResult(page) {
  await page.waitForTimeout(1000);
  await Promise.race([
    page.waitForSelector('.el-message--success, text=成功', { timeout: 60000 }),
    page.waitForSelector('.el-message--error, .el-form-item__error', { timeout: 60000 }).then(() => {
      throw new Error('提交后页面出现错误提示');
    }),
  ]);
}

async function closeAddDialog(page) {
  const closeButton = page.getByRole('button', { name: '关闭' }).last();
  if (await closeButton.isVisible().catch(() => false)) await closeButton.click();
}

function normalizeGameType(value) {
  const map = new Map([
    ['网络游戏', '网游游戏'],
    ['网游', '网游游戏'],
    ['单机', '单机游戏'],
    ['单机游戏', '单机游戏'],
    ['福利游戏', '福利游戏'],
    ['gj单机', 'gj单机'],
    ['gj网游', 'gj网游'],
    ['模拟器游戏', '模拟器游戏'],
  ]);
  return map.get(value) || value;
}

function normalizeDownloadStatus(value) {
  const map = new Map([
    ['开启', '开启'],
    ['打开', '开启'],
    ['关闭', '关闭'],
    ['试玩', '试玩'],
  ]);
  return map.get(value) || value;
}

function normalizeDate(value) {
  if (!value) return '';
  if (value === '当前时间') {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  }
  return String(value).replace(/^(\d{4})\.(\d{1,2})\.(\d{1,2})/, (_, y, m, d) => `${y}-${pad(m)}-${pad(d)}`);
}

function record(entry) {
  appendFileSync(jsonlPath, `${JSON.stringify(entry)}\n`, 'utf8');
  appendCsv(entry);
}

function appendCsv(entry) {
  const columns = [
    '处理时间',
    '游戏名称',
    '游戏ID',
    '处理状态',
    '是否自己显示',
    'APK方式',
    'APK链接',
    '包名',
    '版本',
    '游戏大小',
    '权限获取状态',
    '权限获取说明',
    '平台',
    '合作方式',
    '资料文件夹',
    '失败原因',
    '失败截图',
    '开始时间',
    '完成时间',
  ];
  if (!existsSync(csvPath)) appendFileSync(csvPath, `\uFEFF${columns.join(',')}\n`, 'utf8');
  appendFileSync(csvPath, `${columns.map((key) => csvCell(entry[key] || '')).join(',')}\n`, 'utf8');
}

function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function isImage(file) {
  return /\.(png|jpe?g|webp)$/i.test(file);
}

function naturalCompare(a, b) {
  return a.localeCompare(b, 'zh-CN', { numeric: true });
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function cleanValue(value) {
  return String(value ?? '').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function cssEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function progress(message) {
  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`);
}
