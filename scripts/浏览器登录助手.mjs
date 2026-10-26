import { chromium } from 'playwright';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const ADMIN_URL = 'https://and-admin.ghzs.com/#/games-manage/games-info?href=games_info_menu';
const ADMIN_HOST = 'and-admin.ghzs.com';
const SSO_HOST = 'sso.ghzs.com';

const args = parseArgs(process.argv.slice(2));
const toolRoot = path.resolve(import.meta.dirname, '..');
const managedSessionDir = path.resolve(args['session-dir'] || path.join(toolRoot, '浏览器登录状态'));
const scanRoot = path.join(os.tmpdir(), 'ghzs-browser-scan');

if (args.list) {
  process.stdout.write(JSON.stringify({ candidates: listBrowserProfiles().map(toPublicProfile) }, null, 2));
  process.exit(0);
}

if (args.detect) {
  const result = await detectLoggedInBrowser(resolveBrowserPreference(args));
  process.stdout.write(JSON.stringify(result, null, 2));
  process.exit(result.loggedIn ? 0 : 2);
}

if (args.prepare) {
  const result = await prepareManagedSession(resolveBrowserPreference(args));
  process.stdout.write(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (args.open) {
  const result = await prepareManagedSession(resolveBrowserPreference(args));
  if (!result.ok) {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  openManagedBrowser(result.browser);
  process.stdout.write(JSON.stringify({ ...result, opened: true }, null, 2));
  process.exit(0);
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function resolveBrowserPreference(input) {
  return {
    browserName: input['browser-name'] || '',
    profileName: input['profile-name'] || '',
    executablePath: input['executable-path'] || '',
    userDataDir: input['user-data-dir'] || '',
  };
}

async function detectLoggedInBrowser(preference = {}) {
  mkdirSync(scanRoot, { recursive: true });

  const managed = getManagedBrowser();
  if (managed && existsSync(managedSessionDir)) {
    const managedLoggedIn = await canEnterAdmin(managed, managedSessionDir, false).catch(() => false);
    if (managedLoggedIn) {
      return {
        loggedIn: true,
        message: '已检测到工具自己保存的登录状态，可直接复用。',
        browser: managed.name,
        profileName: managed.profileName,
        executablePath: managed.executablePath,
        userDataDir: managedSessionDir,
        profileDir: managed.profileDir,
        candidates: listBrowserProfiles().map(toPublicProfile),
      };
    }
  }

  const candidates = filterCandidates(listBrowserProfiles(), preference);
  const failures = [];
  const lockedCandidates = [];

  for (const browser of candidates) {
    const tempRoot = path.join(scanRoot, safeName(`${browser.name}-${browser.profileName}-${Date.now()}`));
    try {
      copyBrowserProfile(browser, tempRoot);
      const loggedIn = await canEnterAdmin(browser, tempRoot, true);
      rmSync(tempRoot, { recursive: true, force: true });
      if (loggedIn) {
        return {
          loggedIn: true,
          message: `已检测到 ${browser.name} / ${browser.profileName} 可直接进入后台。`,
          browser: browser.name,
          profileName: browser.profileName,
          executablePath: browser.executablePath,
          userDataDir: browser.userDataDir,
          profileDir: browser.profileDir,
          candidates: candidates.map(toPublicProfile),
        };
      }
    } catch (error) {
      const text = String(error?.message || error);
      failures.push(`${browser.name}/${browser.profileName}: ${text}`);
      if (/EBUSY|locked|busy|Cookies/i.test(text)) {
        lockedCandidates.push(toPublicProfile(browser));
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return {
    loggedIn: false,
    message: lockedCandidates.length
      ? `已找到正在使用中的浏览器档案：${lockedCandidates.map((item) => `${item.browser}/${item.profileName}`).join('、')}。当前浏览器正在占用登录文件，无法直接验证，但可以作为登录入口使用。`
      : candidates.length
        ? '已找到浏览器档案，但没有检测到可直接进入后台的登录状态。'
        : '未找到可用的 Edge / Chrome 浏览器档案。',
    browser: '',
    profileName: '',
    executablePath: '',
    userDataDir: '',
    candidates: candidates.map(toPublicProfile),
    lockedCandidates,
    failures: failures.slice(0, 5),
  };
}

async function prepareManagedSession(preference = {}) {
  const preferred = findCandidate(preference);
  const detection = await detectLoggedInBrowser(preference);
  const fallback = preferred || listBrowserProfiles()[0] || getManagedBrowser();
  const browser = detection.loggedIn
    ? {
        name: detection.browser,
        profileName: detection.profileName,
        executablePath: detection.executablePath,
        userDataDir: detection.userDataDir,
        profileDir: detection.profileDir,
      }
    : fallback;

  if (!browser) {
    return { ok: false, message: '未找到可用浏览器，请先安装 Edge 或 Chrome。' };
  }

  if (browser.profileDir && existsSync(browser.profileDir)) {
    rmSync(managedSessionDir, { recursive: true, force: true });
    mkdirSync(managedSessionDir, { recursive: true });
    try {
      copyBrowserProfile(browser, managedSessionDir);
    } catch {
      mkdirSync(path.join(managedSessionDir, browser.profileName || 'Default'), { recursive: true });
    }
  } else {
    mkdirSync(path.join(managedSessionDir, browser.profileName || 'Default'), { recursive: true });
  }

  return {
    ok: true,
    loggedIn: detection.loggedIn,
    message: detection.loggedIn
      ? `已准备 ${browser.name} / ${browser.profileName} 的登录状态。`
      : `将使用 ${browser.name} / ${browser.profileName} 打开后台登录窗口。`,
    browser: {
      name: browser.name,
      profileName: browser.profileName || 'Default',
      executablePath: browser.executablePath,
      userDataDir: managedSessionDir,
    },
  };
}

function openManagedBrowser(browser) {
  const executablePath = browser.executablePath || getBrowserDefinitions().find((item) => existsSync(item.executablePath))?.executablePath;
  if (!executablePath) throw new Error('找不到可启动的浏览器。');

  const child = spawn(executablePath, [
    `--user-data-dir=${managedSessionDir}`,
    `--profile-directory=${browser.profileName || 'Default'}`,
    '--new-window',
    ADMIN_URL,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

function listBrowserProfiles() {
  const seen = new Set();
  const candidates = [];
  for (const browser of getBrowserDefinitions()) {
    if (!existsSync(browser.executablePath) || !existsSync(browser.userDataDir)) continue;
    for (const name of readdirSync(browser.userDataDir)) {
      const full = path.join(browser.userDataDir, name);
      if (!safeIsDirectory(full)) continue;
      if (name === 'Default' || /^Profile \d+$/.test(name)) {
        const key = `${browser.name}::${name}::${browser.executablePath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          ...browser,
          profileName: name,
          profileDir: full,
          score: profileScore(full),
        });
      }
    }
  }
  return candidates.sort((left, right) => right.score - left.score);
}

function filterCandidates(candidates, preference) {
  const exact = findCandidate(preference, candidates);
  return exact ? [exact] : candidates;
}

function findCandidate(preference, candidates = listBrowserProfiles()) {
  if (!preference.browserName && !preference.profileName && !preference.executablePath) return null;
  return candidates.find((item) => {
    if (preference.browserName && item.name !== preference.browserName) return false;
    if (preference.profileName && item.profileName !== preference.profileName) return false;
    if (preference.executablePath && item.executablePath !== preference.executablePath) return false;
    if (preference.userDataDir && item.userDataDir !== preference.userDataDir) return false;
    return true;
  }) || null;
}

function getBrowserDefinitions() {
  const homeDir = os.homedir();
  const localApp = path.join(homeDir, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:/Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || localApp;

  return [
    {
      name: 'Edge',
      executablePath: path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      userDataDir: path.join(localApp, 'Microsoft', 'Edge', 'User Data'),
    },
    {
      name: 'Edge',
      executablePath: path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      userDataDir: path.join(localApp, 'Microsoft', 'Edge', 'User Data'),
    },
    {
      name: 'Edge',
      executablePath: path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      userDataDir: path.join(localApp, 'Microsoft', 'Edge', 'User Data'),
    },
    {
      name: 'Chrome',
      executablePath: path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      userDataDir: path.join(localApp, 'Google', 'Chrome', 'User Data'),
    },
    {
      name: 'Chrome',
      executablePath: path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      userDataDir: path.join(localApp, 'Google', 'Chrome', 'User Data'),
    },
    {
      name: 'Chrome',
      executablePath: path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      userDataDir: path.join(localApp, 'Google', 'Chrome', 'User Data'),
    },
  ];
}

function getManagedBrowser() {
  const installed = getBrowserDefinitions().find((item) => existsSync(item.executablePath));
  if (!installed) return null;
  return {
    ...installed,
    profileName: 'Default',
    profileDir: path.join(managedSessionDir, 'Default'),
  };
}

function copyBrowserProfile(browser, targetRoot) {
  mkdirSync(targetRoot, { recursive: true });
  const localState = path.join(browser.userDataDir, 'Local State');
  if (existsSync(localState)) cpSync(localState, path.join(targetRoot, 'Local State'), { force: true });
  cpSync(browser.profileDir, path.join(targetRoot, browser.profileName), {
    recursive: true,
    force: true,
    filter: (sourcePath) => !shouldSkipCopy(sourcePath),
  });
}

function shouldSkipCopy(sourcePath) {
  const base = path.basename(sourcePath).toLowerCase();
  return ['cache', 'code cache', 'gpucache', 'service worker', 'crashpad', 'safe browsing', 'optimization guide prediction models', 'browsermetrics'].includes(base);
}

async function canEnterAdmin(browser, userDataDir, useProfileDirectory) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: browser.executablePath,
    headless: true,
    viewport: { width: 1400, height: 900 },
    args: [
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--no-first-run',
      ...(useProfileDirectory ? [`--profile-directory=${browser.profileName}`] : []),
    ],
  });

  try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const current = new URL(page.url());
    if (current.host === ADMIN_HOST) {
      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      return !/SIGN IN|Authelia|登录|用户名|密码/i.test(bodyText) || /游戏管理|游戏信息|添加游戏/i.test(bodyText);
    }
    return current.host !== SSO_HOST && current.host !== '';
  } finally {
    await context.close().catch(() => {});
  }
}

function toPublicProfile(browser) {
  return {
    browser: browser.name,
    profileName: browser.profileName,
    executablePath: browser.executablePath,
    userDataDir: browser.userDataDir,
  };
}

function profileScore(profileDir) {
  const files = ['Cookies', 'Network/Cookies', 'Preferences', 'History'];
  return files.reduce((score, file) => {
    const target = path.join(profileDir, file);
    return score + (existsSync(target) ? statSync(target).mtimeMs : 0);
  }, 0);
}

function safeIsDirectory(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function safeName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_');
}
