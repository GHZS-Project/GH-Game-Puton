const $ = (selector) => document.querySelector(selector);

const folderInput = $('#folderInput');
const chooseFolderBtn = $('#chooseFolder');
const scanFolderBtn = $('#scanFolder');
const browserInfo = $('#browserInfo');
const browserList = $('#browserList');
const checkLoginBtn = $('#checkLogin');
const openLoginBtn = $('#openLogin');
const gamesGrid = $('#gamesGrid');
const gamesSummary = $('#gamesSummary');
const importedGrid = $('#importedGrid');
const importedSummary = $('#importedSummary');
const selectReadyGamesBtn = $('#selectReadyGames');
const selectAllGamesBtn = $('#selectAllGames');
const refreshGamesBtn = $('#refreshGames');
const fetchApkInput = $('#fetchApk');
const autoShowInput = $('#autoShow');
const concurrencyInput = $('#concurrencyInput');
const startBtn = $('#start');
const continueTaskBtn = $('#continueTask');
const stopBtn = $('#stop');
const openCsvBtn = $('#openCsv');
const downloadCsvBtn = $('#downloadCsv');
const openFolderBtn = $('#openFolder');
const openReadmeBtn = $('#openReadme');
const refreshAllBtn = $('#refreshAll');
const refreshTableBtn = $('#refreshTable');
const deleteRegistrationRowsBtn = $('#deleteRegistrationRows');
const registrationTable = $('#registrationTable');
const tableSummary = $('#tableSummary');
const runBadge = $('#runBadge');
const loginStatusText = $('#loginStatusText');
const currentModeText = $('#currentModeText');
const progressText = $('#progressText');
const currentGameText = $('#currentGameText');
const progressPercent = $('#progressPercent');
const progressBar = $('#progressBar');
const startedAtText = $('#startedAtText');
const lastResultText = $('#lastResultText');
const logPanel = $('#logPanel');
const logBox = $('#logBox');
const stepProgress = $('#stepProgress');
const refreshLogBtn = $('#refreshLog');
const toggleLogBtn = $('#toggleLog');
const toast = $('#toast');
const noticeModal = $('#noticeModal');
const noticeTitle = $('#noticeTitle');
const noticeMessage = $('#noticeMessage');
const closeNoticeModalBtn = $('#closeNoticeModal');
const noticeConfirmBtn = $('#noticeConfirm');
const calendarGrid = $('#calendarGrid');
const calendarMonthText = $('#calendarMonthText');
const prevCalendarMonthBtn = $('#prevCalendarMonth');
const nextCalendarMonthBtn = $('#nextCalendarMonth');
const missingModal = $('#missingModal');
const missingTitle = $('#missingTitle');
const missingIssueBox = $('#missingIssueBox');
const missingForm = $('#missingForm');
const closeMissingModalBtn = $('#closeMissingModal');
const saveMissingAndContinueBtn = $('#saveMissingAndContinue');
const saveMissingOnlyBtn = $('#saveMissingOnly');
const resultModal = $('#resultModal');
const resultTitle = $('#resultTitle');
const resultSummaryBox = $('#resultSummaryBox');
const closeResultModalBtn = $('#closeResultModal');
const closeResultConfirmBtn = $('#closeResultConfirm');
const viewRegistrationFromResultBtn = $('#viewRegistrationFromResult');
const moduleTabs = document.querySelectorAll('.module-tab');
const pageViews = document.querySelectorAll('.page-view');

const allFormFields = [
  { key: '游戏名称', label: '游戏名称' },
  { key: '游戏类型', label: '游戏类型' },
  { key: '标签', label: '标签', single: true },
  { key: '游戏副标题', label: '游戏副标题' },
  { key: '副标题生效时间', label: '副标题生效时间' },
  { key: '适龄等级', label: '适龄等级' },
  { key: '简介', label: '简介', single: true },
  { key: '游戏介绍', label: '游戏介绍', type: 'textarea', single: true },
  { key: '测试类型', label: '测试类型' },
  { key: '开测时间', label: '开测时间' },
  { key: '发布时间', label: '发布时间' },
  { key: '下载状态', label: '下载状态' },
  { key: '安装包管理', label: '安装包管理' },
  { key: '填写', label: 'APK 下载链接', single: true, hint: '如果这里有链接，导入时会优先走填写方式。' },
  { key: '平台', label: '平台' },
  { key: '合作方式', label: '合作方式' },
  { key: '名称', label: '开发者名称' },
  { key: '地区', label: '地区' },
  { key: '供应商', label: '供应商', single: true },
  { key: '统一社会信用代码', label: '统一社会信用代码', single: true },
  { key: 'ICP备案号', label: 'ICP备案号', single: true },
  { key: '备注', label: '备注', type: 'textarea', single: true },
];

let missingModalGame = null;
let pendingImport = null;

let latestState = null;
let gamesData = [];
let importedGamesData = [];
let selectedGameId = '';
let selectedGameIds = new Set();
let loadedGamesSource = '';
let selectedBrowser = null;
let pollTimer = null;
let activeRunToken = null;
let lastRunningState = false;
let resultModalShownFor = '';
let registrationCache = { exists: false, rows: [], csvPath: '', updatedAt: '' };
let selectedRegistrationRows = new Set();
let toastTimer = null;
let calendarCursor = new Date();
calendarCursor.setDate(1);
let stoppingTask = false;
const maxSelectedGames = 10;

boot();

async function boot() {
  bindEvents();
  await loadState();
  await loadBrowsers();
  const source = latestState?.preferences?.source || '';
  if (source) {
    folderInput.value = source;
    await loadGames(source);
    await loadRegistration(source);
  } else {
    renderGames([]);
    renderRegistration({ exists: false, rows: [], csvPath: '', updatedAt: '' });
  }
  renderCalendar([]);
  startPolling();
}

function bindEvents() {
  chooseFolderBtn.addEventListener('click', chooseFolder);
  scanFolderBtn.addEventListener('click', () => loadGames(folderInput.value.trim()));
  folderInput.addEventListener('change', async () => {
    selectedGameIds = new Set();
    await savePreferences({ source: folderInput.value.trim() });
    await loadGames(folderInput.value.trim());
  });
  checkLoginBtn.addEventListener('click', checkLogin);
  openLoginBtn.addEventListener('click', openLogin);
  selectReadyGamesBtn.addEventListener('click', selectReadyGames);
  selectAllGamesBtn.addEventListener('click', selectAllGames);
  refreshGamesBtn.addEventListener('click', refreshImportGames);
  startBtn.addEventListener('click', startImport);
  continueTaskBtn.addEventListener('click', continueImport);
  stopBtn.addEventListener('click', stopImport);
  openCsvBtn.addEventListener('click', openCsv);
  downloadCsvBtn.addEventListener('click', downloadCsv);
  openFolderBtn.addEventListener('click', () => openPath(folderInput.value.trim()));
  openReadmeBtn.addEventListener('click', async () => {
    const state = latestState || await loadState();
    const manualPath = state?.manualPath || state?.readmePath;
    if (manualPath) openPath(manualPath);
  });
  refreshAllBtn.addEventListener('click', refreshAll);
  refreshTableBtn.addEventListener('click', () => loadRegistration(folderInput.value.trim() || latestState?.source || ''));
  deleteRegistrationRowsBtn.addEventListener('click', deleteSelectedRegistrationRows);
  refreshLogBtn.addEventListener('click', refreshTaskLog);
  fetchApkInput.addEventListener('change', () => savePreferences({ fetchApkInDryRun: fetchApkInput.checked }));
  autoShowInput.addEventListener('change', () => savePreferences({ autoShow: autoShowInput.checked }));
  if (concurrencyInput) {
    concurrencyInput.addEventListener('change', () => {
      concurrencyInput.value = String(clampConcurrency(concurrencyInput.value));
      savePreferences({ concurrency: Number(concurrencyInput.value) });
    });
  }
  document.querySelectorAll('input[name="mode"]').forEach((input) => {
    input.addEventListener('change', () => {
      updateStrategyVisibility();
      savePreferences({ mode: input.value });
    });
  });
  moduleTabs.forEach((tab) => {
    tab.addEventListener('click', () => switchPage(tab.dataset.page));
  });
  toggleLogBtn.addEventListener('click', () => {
    logPanel.classList.toggle('collapsed');
    toggleLogBtn.textContent = logPanel.classList.contains('collapsed') ? '显示详细日志' : '隐藏详细日志';
  });
  document.querySelectorAll('.info-trigger').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const wrap = button.closest('.info-popover-wrap');
      document.querySelectorAll('.info-popover-wrap.info-open').forEach((item) => {
        if (item !== wrap) item.classList.remove('info-open');
      });
      wrap?.classList.toggle('info-open');
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.info-popover-wrap.info-open').forEach((item) => item.classList.remove('info-open'));
  });
  prevCalendarMonthBtn.addEventListener('click', () => changeCalendarMonth(-1));
  nextCalendarMonthBtn.addEventListener('click', () => changeCalendarMonth(1));
  closeMissingModalBtn.addEventListener('click', closeMissingModal);
  saveMissingOnlyBtn.addEventListener('click', () => saveMissingFields(false));
  saveMissingAndContinueBtn.addEventListener('click', () => saveMissingFields(true));
  closeResultModalBtn.addEventListener('click', closeResultModal);
  closeResultConfirmBtn.addEventListener('click', closeResultModal);
  viewRegistrationFromResultBtn.addEventListener('click', () => {
    closeResultModal();
    switchPage('registration');
  });
  closeNoticeModalBtn.addEventListener('click', closeNoticeModal);
  noticeConfirmBtn.addEventListener('click', closeNoticeModal);
}

async function chooseFolder() {
  const result = await post('/api/select-folder');
  if (!result.folder) return;
  folderInput.value = result.folder;
  selectedGameIds = new Set();
  await savePreferences({ source: result.folder });
  await loadGames(result.folder);
  await loadRegistration(result.folder);
}

async function loadState() {
  const response = await fetch('/api/state');
  latestState = await response.json();
  renderState(latestState);
  return latestState;
}

async function loadBrowsers() {
  selectedBrowser = null;
  renderBrowsers([]);
}

async function loadGames(source) {
  if (!source) {
    gamesData = [];
    importedGamesData = [];
    selectedGameIds = new Set();
    loadedGamesSource = '';
    renderGames([]);
    renderImportedGames([]);
    return;
  }
  const response = await fetch(`/api/games?source=${encodeURIComponent(source)}`);
  const data = await response.json();
  const allGames = data.games || [];
  importedGamesData = allGames.filter((game) => game.imported);
  gamesData = allGames.filter((game) => !game.imported);
  if (loadedGamesSource !== source) {
    selectedGameIds = new Set();
    loadedGamesSource = source;
  } else {
    selectedGameIds = new Set(gamesData.filter((game) => selectedGameIds.has(game.id)).map((game) => game.id));
  }
  if (!selectedGameId || !gamesData.some((game) => game.id === selectedGameId)) {
    selectedGameId = gamesData[0]?.id || '';
  }
  renderGames(gamesData, summarizeLocalGames());
  renderImportedGames(importedGamesData);
}

async function loadRegistration(source) {
  const url = source ? `/api/registration?source=${encodeURIComponent(source)}` : '/api/registration';
  const response = await fetch(url);
  registrationCache = await response.json();
  selectedRegistrationRows = new Set();
  renderRegistration(registrationCache);
  renderCalendar(registrationCache.rows || []);
}

async function refreshAll() {
  await loadState();
  await loadBrowsers();
  const source = folderInput.value.trim() || latestState?.preferences?.source || '';
  if (source) {
    await loadGames(source);
    await loadRegistration(source);
  }
}

async function refreshTaskLog() {
  if (refreshLogBtn) {
    refreshLogBtn.disabled = true;
    refreshLogBtn.textContent = '刷新中';
  }
  try {
    await loadState();
    const source = folderInput.value.trim() || latestState?.preferences?.source || '';
    if (source) await loadRegistration(source);
    showToast('任务日志已刷新。', 'success');
  } finally {
    if (refreshLogBtn) {
      refreshLogBtn.disabled = false;
      refreshLogBtn.textContent = '刷新日志';
    }
  }
}

function renderState(state) {
  loginStatusText.textContent = state.loginInfo?.loggedIn ? '已登录' : '未检测';
  loginStatusText.dataset.state = state.loginInfo?.loggedIn ? 'ok' : state.loginInfo ? 'bad' : 'unknown';
  currentModeText.textContent = state.mode || '待命';
  const current = state.progress?.current || 0;
  const total = state.progress?.total || 0;
  const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
  progressText.textContent = `${current} / ${total}`;
  if (currentGameText) currentGameText.textContent = state.running
    ? (state.currentGame || '任务执行中')
    : state.lastResult
      ? (state.lastResult.code === 0 ? '任务已完成' : state.lastResult.code === 2 ? '任务已停止' : '任务有异常')
      : '暂无任务';
  if (progressPercent) progressPercent.textContent = `${percent}%`;
  if (progressBar) progressBar.style.width = `${percent}%`;
  startedAtText.textContent = state.startedAt ? formatTime(state.startedAt) : '未开始';
  lastResultText.textContent = state.lastResult ? (state.lastResult.code === 0 ? '已完成' : state.lastResult.code === 2 ? '已停止' : '有异常') : '暂无';
  fetchApkInput.checked = true;
  autoShowInput.checked = state.preferences?.autoShow ?? false;
  if (concurrencyInput) concurrencyInput.value = String(clampConcurrency(state.preferences?.concurrency || 3));
  const mode = normalizeMode(state.preferences?.mode);
  const modeInput = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (modeInput) modeInput.checked = true;
  updateStrategyVisibility();

  if (state.loginInfo?.message) {
    browserInfo.textContent = state.loginInfo.message;
    browserInfo.className = `browser-info ${state.loginInfo.loggedIn ? 'ok' : 'bad'}`;
  }

  if (state.running) setRunBadge('running', '执行中');
  else if (state.lastResult && state.lastResult.code !== 0) setRunBadge('warning', '需处理');
  else setRunBadge('idle', '空闲');
  if (!state.running) stoppingTask = false;
  updateTaskButtons(state);

  const logs = normalizeTaskLogs(Array.isArray(state.logs) && state.logs.length ? state.logs : ['暂无任务状态。']);
  const visibleLogs = compactTaskLogs(logs);
  logBox.textContent = logs.slice(-40).join('\n');
  renderStepProgress(state, logs);
  logBox.scrollTop = logBox.scrollHeight;
}

function updateTaskButtons(state = latestState) {
  const running = Boolean(state?.running);
  const stoppedOrFailed = Boolean(state?.lastResult && state.lastResult.code !== 0);
  const hasSelection = selectedGameIds.size > 0;
  startBtn.disabled = running;
  startBtn.textContent = running ? '执行中' : '开始执行';
  stopBtn.disabled = !running || stoppingTask;
  stopBtn.textContent = stoppingTask ? '正在停止' : '停止任务';
  if (continueTaskBtn) {
    continueTaskBtn.disabled = running || !stoppedOrFailed || !hasSelection;
    continueTaskBtn.hidden = !stoppedOrFailed && !running;
    continueTaskBtn.textContent = '继续执行';
  }
  if (refreshGamesBtn) refreshGamesBtn.disabled = running;
  if (scanFolderBtn) scanFolderBtn.disabled = running;
  if (chooseFolderBtn) chooseFolderBtn.disabled = running;
  if (selectReadyGamesBtn) selectReadyGamesBtn.disabled = running || !gamesData.length;
  if (selectAllGamesBtn) selectAllGamesBtn.disabled = running || !gamesData.length;
}

function renderStepProgress(state, logs) {
  if (!stepProgress) return;
  const total = state.progress?.total || 0;
  const current = state.progress?.current || 0;
  const active = state.running
    ? Math.min(total, Math.max(1, Number(state.progress?.active || current + 1)))
    : Math.min(total, current);
  const currentName = state.progress?.currentName || '';
  const remaining = Math.max(0, total - current);
  const percent = total ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const lastResult = state.lastResult || {};
  const statusText = state.running
    ? '执行中'
    : state.lastResult
      ? (state.lastResult.code === 0 ? '已完成' : state.lastResult.code === 2 ? '已停止' : '有异常')
      : '待命';
  const latest = [...compactTaskLogs(logs)].reverse().find((line) => line && line !== '暂无任务状态。') || '等待任务开始';
  const successCount = Number.isFinite(Number(lastResult.successCount)) ? Number(lastResult.successCount) : null;
  const failureCount = Number.isFinite(Number(lastResult.failureCount)) ? Number(lastResult.failureCount) : null;
  const resultText = successCount !== null || failureCount !== null
    ? `成功 ${successCount || 0} / 失败 ${failureCount || 0}`
    : '暂无结果';
  const importantLogs = compactTaskLogs(logs).slice(-10);
  const runningClass = state.running ? 'running' : state.lastResult?.code === 0 ? 'done' : state.lastResult ? 'warning' : 'idle';
  const activeText = total
    ? `${active || current} / ${total}${currentName ? ` · ${currentName}` : ''}`
    : '暂无任务';
  stepProgress.innerHTML = `
    <div class="task-progress-shell ${runningClass}">
      <div class="task-progress-head">
        <div>
          <span>任务状态</span>
          <strong>${escapeHtml(statusText)}</strong>
        </div>
        <div>
          <span>当前任务</span>
          <strong>${escapeHtml(activeText)}</strong>
        </div>
        <div>
          <span>已完成</span>
          <strong>${escapeHtml(`${current} / ${total}`)} · ${percent}%</strong>
        </div>
        <div>
          <span>剩余任务</span>
          <strong>${remaining}</strong>
        </div>
        <div>
          <span>执行结果</span>
          <strong>${escapeHtml(resultText)}</strong>
        </div>
      </div>
      <div class="task-progress-track"><div class="task-progress-bar" style="width:${percent}%"></div></div>
      <div class="task-progress-note">${escapeHtml(state.currentGame || latest)}</div>
      <div class="task-step-list">
        ${importantLogs.map((line) => `<div class="task-step ${taskStepClass(line)}"><span></span><p>${escapeHtml(line)}</p></div>`).join('')}
      </div>
    </div>
  `;
}
function normalizeTaskLogs(logs) {
  return (logs || [])
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .filter((line) => !/Browser logs:|node:internal|^\s*\^$|Call log:/i.test(line))
    .map(cleanTaskLogLine);
}

function compactTaskLogs(logs) {
  const source = (logs || []).map((line) => String(line || '').trim()).filter(Boolean);
  const useful = source
    .filter((line) => /开始|完成|失败|处理|正在|已|未|权限|上传|填写|提交|显示|游戏ID|原因|异常|停止|暂停|登录|等待|APK/.test(line));
  const deduped = useful.filter((line, index, list) => index === 0 || line !== list[index - 1]);
  return (deduped.length ? deduped : ['暂无任务状态。']).slice(-16);
}

function cleanTaskLogLine(line) {
  return String(line || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^错误提示：/, '错误：')
    .replace(/^并发\s*\d+：/, '')
    .trim();
}

function taskStepClass(line) {
  if (/失败|异常|错误|断开|超时|暂停/.test(line)) return 'bad';
  if (/完成|已完成|成功|游戏ID/.test(line)) return 'ok';
  if (/等待|上传|权限获取|提交|显示|正在|开始/.test(line)) return 'active';
  return '';
}

function renderBrowsers(candidates) {
  browserList.innerHTML = '<div class="browser-card selected"><strong>当前后台窗口</strong><small>请先打开后台窗口并登录。执行任务时工具会接管这个后台窗口自动操作。</small></div>';
}

function renderGames(games, summary = { total: 0, ready: 0, needFix: 0 }) {
  gamesSummary.textContent = games.length
    ? `共 ${summary.total} 个，已可执行 ${summary.ready} 个，需补资料 ${summary.needFix} 个`
    : importedGamesData.length ? '当前资料均已导入完成' : '尚未扫描到可导入游戏';

  if (!games.length) {
    gamesGrid.innerHTML = '<div class="issue-box empty">扫描后会按 ICON + 游戏名称显示在这里。</div>';
    return;
  }

  gamesGrid.innerHTML = games.map((game) => {
    const checked = selectedGameIds.has(game.id) ? 'checked' : '';
    const selected = selectedGameId === game.id ? 'selected' : '';
    const statusClass = game.blockingIssues.length ? 'block' : game.missingFields.length ? 'warn' : 'ready';
    const statusText = game.blockingIssues.length ? '需补齐' : game.missingFields.length ? '建议检查' : '可执行';
    const linkBadge = game.apkLink
      ? '<span class="badge ready">有链接</span>'
      : '<span class="badge block">无链接</span>';
    const apkBadge = game.apk ? '<span class="badge ready">有 APK</span>' : '<span class="badge block">缺 APK</span>';
    const issueText = game.blockingIssues
      .concat(game.missingFields.map((field) => `缺少${field}`))
      .concat((game.warnings || []).map((item) => `提示：${item}`))
      .slice(0, 3)
      .join('；');
    return `
      <article class="game-card ${selected}" data-game-id="${game.id}">
        <div class="game-media">
          ${game.iconUrl ? `<img class="game-thumb" src="${game.iconUrl}" alt="${escapeHtml(game.name)}" />` : '<div class="game-thumb game-thumb-empty">无图标</div>'}
        </div>
        <div class="game-body">
          <div class="game-head">
            <label class="game-check" title="选择该游戏"><input type="checkbox" data-select-id="${game.id}" ${checked} /><span></span></label>
            <div>
              <div class="game-name">${escapeHtml(game.name)}</div>
              <div class="game-meta">${escapeHtml(game.data?.['游戏类型'] || '未填写类型')} · ${escapeHtml(game.apkMode || '未识别安装包方式')}</div>
            </div>
          </div>
          <div class="game-badges" aria-label="资料状态">
            <span class="badge ${statusClass}">${statusText}</span>
            ${linkBadge}
            ${apkBadge}
          </div>
          ${issueText ? `<div class="game-issues">${escapeHtml(issueText)}</div>` : ''}
        </div>
      </article>
    `;
  }).join('');

  gamesGrid.querySelectorAll('.game-card').forEach((card) => {
    card.addEventListener('click', (event) => {
      if (event.target.closest('.game-check')) return;
      selectedGameId = card.dataset.gameId;
      renderGames(games, summary);
    });
  });

  gamesGrid.querySelectorAll('input[data-select-id]').forEach((checkbox) => {
    checkbox.addEventListener('change', (event) => {
      const id = event.target.dataset.selectId;
      if (event.target.checked) {
        if (selectedGameIds.size >= maxSelectedGames) {
          event.target.checked = false;
          showNotice('最多选择 10 个游戏', '为了保证批量导入稳定，一次最多选择 10 个可导入游戏。请先执行当前选择，完成后再导入剩余游戏。');
          return;
        }
        selectedGameIds.add(id);
      } else selectedGameIds.delete(id);
      updateTaskButtons(latestState);
    });
  });
  updateTaskButtons(latestState);
}

function renderImportedGames(games) {
  if (!importedGrid || !importedSummary) return;
  importedSummary.textContent = games.length ? `共 ${games.length} 个已完成` : '暂无已导入游戏';
  if (!games.length) {
    importedGrid.innerHTML = '<div class="issue-box empty">导入成功后，会在这里显示已完成的游戏。</div>';
    return;
  }
  importedGrid.innerHTML = games.map((game) => {
    const linkBadge = game.apkLink
      ? '<span class="badge ready">有链接</span>'
      : '<span class="badge block">无链接</span>';
    const apkBadge = game.apk ? '<span class="badge ready">有 APK</span>' : '<span class="badge block">缺 APK</span>';
    return `
      <article class="game-card imported-card" data-game-id="${game.id}">
        ${game.iconUrl ? `<img class="game-thumb" src="${game.iconUrl}" alt="${escapeHtml(game.name)}" />` : '<div class="game-thumb"></div>'}
        <div class="game-body">
          <div class="game-head">
            <div>
              <div class="game-name">${escapeHtml(game.name)}</div>
            </div>
          </div>
          <div class="game-badges" aria-label="导入状态">
            <span class="badge ready">已完成</span>
            ${linkBadge}
            ${apkBadge}
          </div>
          <button class="btn btn-ghost imported-remove" type="button" data-remove-imported="${game.id}">移回待导入</button>
        </div>
      </article>
    `;
  }).join('');

  importedGrid.querySelectorAll('[data-remove-imported]').forEach((button) => {
    button.addEventListener('click', async (event) => {
      event.stopPropagation();
      const game = importedGamesData.find((item) => item.id === button.dataset.removeImported);
      const name = game?.name || '';
      if (!name) return;
      const ok = window.confirm(`确认将“${name}”移回待导入列表吗？登记表中的完成记录会被移除。`);
      if (!ok) return;
      await post('/api/remove-imported-game', {
        source: folderInput.value.trim() || latestState?.preferences?.source || '',
        name,
      });
      showToast(`已将“${name}”移回待导入。`, 'success');
      await loadGames(folderInput.value.trim() || latestState?.preferences?.source || '');
      await loadRegistration(folderInput.value.trim() || latestState?.preferences?.source || '');
    });
  });
}

function switchPage(page) {
  moduleTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.page === page));
  pageViews.forEach((view) => view.classList.toggle('active', view.dataset.pageView === page));
  if (page === 'registration') {
    loadRegistration(folderInput.value.trim() || latestState?.source || latestState?.preferences?.source || '');
  }
}

function issueMarkup(game) {
  const items = [
    ...(game.blockingIssues || []).map((item) => `<li>阻塞：${escapeHtml(item)}</li>`),
    ...(game.missingFields || []).map((item) => `<li>待补：${escapeHtml(item)}</li>`),
    ...(game.warnings || []).map((item) => `<li>提醒：${escapeHtml(item)}</li>`),
  ];
  return items.length ? `<ul>${items.join('')}</ul>` : '资料完整，可以直接执行。';
}

function openMissingModal(game, importConfig = null) {
  missingModalGame = game;
  pendingImport = importConfig;
  missingTitle.textContent = `${game.name} 需要补充资料`;
  missingIssueBox.innerHTML = issueMarkup(game);

  const missingKeys = missingFieldKeys(game);
  if (!missingKeys.length) {
    missingForm.innerHTML = '<div class="issue-box empty">请按上面的提示补充文件后，点击“扫描资料”重新检查。</div>';
    saveMissingAndContinueBtn.hidden = true;
    saveMissingOnlyBtn.hidden = true;
    missingModal.hidden = false;
    return;
  }

  saveMissingAndContinueBtn.hidden = false;
  saveMissingOnlyBtn.hidden = false;
  missingForm.innerHTML = `<div class="field-grid">${missingKeys.map((key) => {
    const field = allFormFields.find((item) => item.key === key) || { key, label: key };
    const value = game.data[field.key] || '';
    const input = field.type === 'textarea'
      ? `<textarea data-field="${field.key}">${escapeHtml(value)}</textarea>`
      : `<input type="text" data-field="${field.key}" value="${escapeHtml(value)}" />`;
    return `
      <div class="field-block ${field.single ? 'single' : ''}">
        <label>${field.label}</label>
        ${input}
        ${field.hint ? `<span class="hint">${field.hint}</span>` : ''}
      </div>
    `;
  }).join('')}</div>`;

  missingModal.hidden = false;
}

function closeMissingModal() {
  missingModal.hidden = true;
  missingModalGame = null;
  pendingImport = null;
}

async function saveMissingFields(continueAfterSave) {
  const game = missingModalGame;
  if (!game) return;
  const data = {};
  missingForm.querySelectorAll('[data-field]').forEach((input) => {
    data[input.dataset.field] = input.value.trim();
  });
  const result = await post('/api/save-game', { infoPath: game.infoPath, data });
  gamesData = gamesData.map((item) => item.id === result.id ? result : item);
  selectedGameId = result.id;
  await loadGames(folderInput.value.trim() || latestState?.preferences?.source || '');
  const refreshed = gamesData.find((item) => item.id === result.id) || result;
  if (refreshed.blockingIssues.length || refreshed.missingFields.length) {
    openMissingModal(refreshed, continueAfterSave ? pendingImport : null);
    return;
  }
  missingModal.hidden = true;
  if (continueAfterSave && pendingImport) {
    const config = pendingImport;
    pendingImport = null;
    await executeImport(config);
  }
}

async function checkLogin() {
  const result = await post('/api/check-login');
  const info = result.data || {};
  latestState.loginInfo = info;
  browserInfo.textContent = info.message || '已完成登录检测。';
  browserInfo.className = `browser-info ${info.loggedIn ? 'ok' : 'bad'}`;
  loginStatusText.textContent = info.loggedIn ? '已登录' : '未登录';
  loginStatusText.dataset.state = info.loggedIn ? 'ok' : 'bad';
  if (info.loggedIn) {
    showToast('已检测到后台登录状态，登记表已准备好。', 'success');
    await loadRegistration(folderInput.value.trim() || latestState?.preferences?.source || '');
  }
  else showNotice('未检测到登录状态', info.message || '请先点击“打开后台窗口”，在弹出的后台页面完成登录。');
}

async function openLogin() {
  const result = await post('/api/open-login');
  const info = result.data || {};
  latestState.loginInfo = info;
  browserInfo.textContent = info.loggedIn
    ? (info.message || '已检测到后台登录状态，可以继续执行。')
    : (info.message || '未检测到登录状态，请先在后台窗口登录后台后再执行。');
  browserInfo.className = `browser-info ${info.loggedIn ? 'ok' : 'bad'}`;
  loginStatusText.textContent = info.loggedIn ? '已登录' : '未登录';
  loginStatusText.dataset.state = info.loggedIn ? 'ok' : 'bad';
  if (info.loggedIn) await loadRegistration(folderInput.value.trim() || latestState?.preferences?.source || '');
  showToast(info.message || '已打开后台登录窗口。', info.loggedIn ? 'success' : 'info');
}

function selectReadyGames() {
  const ready = gamesData.filter((game) => !game.blockingIssues.length).map((game) => game.id);
  const target = ready.slice(0, maxSelectedGames);
  const allSelected = target.length > 0 && target.every((id) => selectedGameIds.has(id));
  selectedGameIds = allSelected ? new Set() : new Set(target);
  renderGames(gamesData, summarizeLocalGames());
  showToast(allSelected ? '已取消选择所有可执行游戏。' : `已选中 ${selectedGameIds.size} 个可执行游戏${ready.length > maxSelectedGames ? '，最多一次 10 个' : ''}。`, allSelected ? 'info' : 'success');
}

function selectAllGames() {
  const all = gamesData.map((game) => game.id);
  const target = all.slice(0, maxSelectedGames);
  const allSelected = target.length > 0 && target.every((id) => selectedGameIds.has(id));
  selectedGameIds = allSelected ? new Set() : new Set(target);
  renderGames(gamesData, summarizeLocalGames());
  showToast(allSelected ? '已取消选择所有游戏。' : `已选中 ${selectedGameIds.size} 个游戏${all.length > maxSelectedGames ? '，最多一次 10 个' : ''}。`, allSelected ? 'info' : 'success');
}

async function refreshImportGames() {
  const source = folderInput.value.trim() || latestState?.preferences?.source || '';
  if (!source) {
    showNotice('请先选择资料目录', '选择资料目录后，才能刷新导入游戏列表。');
    return;
  }
  refreshGamesBtn.disabled = true;
  refreshGamesBtn.textContent = '刷新中';
  try {
    await loadGames(source);
    await loadRegistration(source);
    showToast('导入游戏列表已刷新。', 'success');
  } finally {
    refreshGamesBtn.textContent = '刷新导入游戏';
    updateTaskButtons(latestState);
  }
}

async function startImport() {
  const source = folderInput.value.trim();
  if (!source) {
    browserInfo.textContent = '请先选择资料目录。';
    showNotice('请先选择资料目录', '请先点击“选择文件夹”，选择包含游戏资料的文件夹后再执行。');
    showNotExecutedModal('任务未执行', '未选择资料目录，请先选择包含游戏资料的文件夹。');
    return;
  }
  await loadGames(source);
  const selectedGames = gamesData.filter((game) => selectedGameIds.has(game.id));
  if (!selectedGames.length) {
    browserInfo.textContent = '请至少选择一个要导入的游戏。';
    showNotice('请选择要导入的游戏', '当前没有选中任何游戏。请在游戏卡片左侧勾选本次要导入的游戏后再执行。');
    showNotExecutedModal('任务未执行', '当前没有选中任何游戏，请先勾选本次要导入的游戏。');
    return;
  }
  const blocking = selectedGames.find((game) => game.blockingIssues.length || game.missingFields.length);
  if (blocking) {
    selectedGameId = blocking.id;
    renderGames(gamesData, summarizeLocalGames());
    openMissingModal(blocking, buildImportConfig(source));
    return;
  }

  await executeImport(buildImportConfig(source));
}

async function continueImport() {
  const source = folderInput.value.trim() || latestState?.preferences?.source || '';
  if (!source) {
    showNotice('请先选择资料目录', '继续执行前，请先选择资料目录。');
    showNotExecutedModal('任务未执行', '继续执行前需要先选择资料目录。');
    return;
  }
  await loadGames(source);
  if (!selectedGameIds.size) {
    showNotice('请选择要继续导入的游戏', '当前没有选中游戏。请勾选需要继续执行的游戏后再点击“继续执行”。');
    showNotExecutedModal('任务未执行', '当前没有选中游戏，请先勾选需要继续执行的游戏。');
    return;
  }
  await executeImport(buildImportConfig(source), { skipConfirm: true, continued: true });
}

function buildImportConfig(source) {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'submit';
  return {
    source,
    selectedGames: gamesData.filter((game) => selectedGameIds.has(game.id)).map((game) => game.id),
    mode,
    submit: mode === 'submit',
    uploadInDryRun: mode === 'test',
    fetchApkInDryRun: true,
    noAutoShow: mode === 'submit' ? !autoShowInput.checked : true,
    concurrency: 1,
  };
}

async function executeImport(config, options = {}) {
  if (!config.selectedGames.length) {
    browserInfo.textContent = '请至少选择一个游戏。';
    showNotice('请选择要导入的游戏', '当前没有选中任何游戏。请先勾选游戏卡片。');
    showNotExecutedModal('任务未执行', '当前没有选中任何游戏，请先勾选游戏卡片。');
    return;
  }
  if (config.selectedGames.length > maxSelectedGames) {
    showNotice('最多选择 10 个游戏', '为了保证批量导入稳定，一次最多选择 10 个可导入游戏。请先执行当前选择，完成后再导入剩余游戏。');
    showNotExecutedModal('任务未执行', '一次最多选择 10 个游戏，请减少选择数量后再执行。');
    return;
  }
  if (!latestState?.loginInfo?.loggedIn) {
    showNotice('请先检查登录状态', '未检测到后台登录状态，任务不会执行。请先点击“检查登录状态”，确认已登录后再开始执行。');
    showToast('未登录，已阻止执行任务。', 'warning');
    showNotExecutedModal('任务未执行', '未检测到后台登录状态。请先打开后台窗口登录，并点击“检查登录状态”确认已登录。');
    return;
  }
  if (config.mode === 'submit' && !options.skipConfirm) {
    const ok = window.confirm('正式执行会提交上架，请确认当前资料已经检查完成。');
    if (!ok) {
      showNotExecutedModal('任务未执行', '已取消正式执行确认，未开始上架任务。');
      return;
    }
  }

  try {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    if (continueTaskBtn) continueTaskBtn.disabled = true;
    if (refreshGamesBtn) refreshGamesBtn.disabled = true;
    const response = await fetch('/api/start-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const data = await response.json();
    if (!response.ok) {
      if (data.loginInfo) {
        latestState.loginInfo = data.loginInfo;
        browserInfo.textContent = data.error || data.loginInfo.message || '未检测到后台登录状态。';
        browserInfo.className = 'browser-info bad';
        loginStatusText.textContent = '未登录';
        loginStatusText.dataset.state = 'bad';
      }
      if (data.missingGames?.length) {
        const missing = data.missingGames[0];
        const game = gamesData.find((item) => item.id === missing.id) || missing;
        openMissingModal({ ...game, ...missing }, config);
        return;
      }
      browserInfo.textContent = data.error || '启动导入失败。';
      showNotice('启动导入失败', data.error || '启动导入失败，请检查资料和后台登录状态。');
      showNotExecutedModal('任务未执行', data.error || '启动导入失败，请检查资料和后台登录状态。');
      return;
    }
    if (data.ok) {
      stoppingTask = false;
      showToast(options.continued ? '已继续执行任务。' : '任务已开始执行。', 'success');
      activeRunToken = `${Date.now()}`;
      resultModalShownFor = '';
      lastRunningState = true;
      startPolling();
    }
  } catch (error) {
    const message = String(error?.message || error);
    showNotice('启动导入失败', message);
    showNotExecutedModal('任务未执行', message);
  } finally {
    updateTaskButtons(latestState);
  }
}

function missingFieldKeys(game) {
  const editable = new Set(allFormFields.map((field) => field.key));
  const keys = [...(game.missingFields || [])].filter((key) => editable.has(key));
  if ((game.blockingIssues || []).some((issue) => /APK|安装包|下载链接/.test(issue))) {
    keys.push('填写');
  }
  return [...new Set(keys)];
}

async function stopImport() {
  if (!latestState?.running) {
    showNotice('当前没有正在执行的任务', '任务未运行时不需要停止。');
    showNotExecutedModal('任务未执行', '当前没有正在执行的任务，不需要停止。');
    updateTaskButtons(latestState);
    return;
  }
  stoppingTask = true;
  updateTaskButtons(latestState);
  const result = await post('/api/stop-task');
  if (result?.ok) {
    showToast('已发送停止请求，正在等待任务停下。', 'warning');
    startPolling();
    setTimeout(loadState, 600);
  } else {
    stoppingTask = false;
    showNotice('停止任务失败', result?.error || '停止请求没有成功发送，请稍后重试。');
    showNotExecutedModal('停止任务失败', result?.error || '停止请求没有成功发送，请稍后重试。');
  }
}

function openCsv() {
  const csvPath = registrationCache.csvPath || 'E:\\新建文件夹\\游戏资料\\游戏资料登记表.csv';
  if (csvPath) openPath(csvPath);
}

function downloadCsv() {
  const source = folderInput.value.trim() || latestState?.source || '';
  if (!source) return;
  const link = document.createElement('a');
  link.href = `/api/registration-csv?source=${encodeURIComponent(source)}&t=${Date.now()}`;
  link.download = '游戏资料登记表.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function renderRegistration(data) {
  const head = registrationTable.querySelector('thead');
  const body = registrationTable.querySelector('tbody');
  const rows = data.rows || [];
  head.innerHTML = '';
  body.innerHTML = '';

  if (!data.exists || !rows.length) {
    tableSummary.textContent = data.csvPath ? '登记表尚未生成' : '暂无登记数据';
    body.innerHTML = '<tr><td class="empty-cell">导入完成后，这里会显示完整登记表。</td></tr>';
    updateRegistrationDeleteButton();
    return;
  }

  const columns = Object.keys(rows[0]);
  head.innerHTML = `<tr><th class="select-col"><label class="table-check"><input id="selectAllRegistrationRows" type="checkbox" /><span></span></label></th>${columns.map((column) => `<th class="${registrationColumnClass(column)}">${escapeHtml(column)}</th>`).join('')}</tr>`;
  body.innerHTML = rows.map((row, index) => `
    <tr data-registration-row="${index}">
      <td class="select-col"><label class="table-check"><input type="checkbox" data-registration-index="${index}" ${selectedRegistrationRows.has(index) ? 'checked' : ''} /><span></span></label></td>
      ${columns.map((column) => renderRegistrationCell(column, row[column] || '', index)).join('')}
    </tr>
  `).join('');
  tableSummary.textContent = `共 ${rows.length} 条记录`;
  registrationTable.querySelector('#selectAllRegistrationRows')?.addEventListener('change', (event) => {
    selectedRegistrationRows = event.target.checked ? new Set(rows.map((_, index) => index)) : new Set();
    renderRegistration(registrationCache);
  });
  registrationTable.querySelectorAll('[data-registration-index]').forEach((checkbox) => {
    checkbox.addEventListener('change', (event) => {
      const index = Number(event.target.dataset.registrationIndex);
      if (event.target.checked) selectedRegistrationRows.add(index);
      else selectedRegistrationRows.delete(index);
      updateRegistrationDeleteButton();
    });
  });
  registrationTable.querySelectorAll('[data-copy-apk-link]').forEach((button) => {
    button.addEventListener('click', async () => {
      await copyText(button.dataset.copyApkLink || '');
      showToast('APK 链接已复制。', 'success');
    });
  });
  registrationTable.querySelectorAll('[data-error-reason]').forEach((button) => {
    button.addEventListener('click', () => {
      showNotice('错误原因', button.dataset.errorReason || '暂无错误原因。');
    });
  });
  updateRegistrationDeleteButton();
}

function registrationColumnClass(column) {
  const map = {
    时间: 'col-time',
    游戏名称: 'col-name',
    游戏类型: 'col-type',
    游戏ID: 'col-id',
    显示状态: 'col-show',
    状态: 'col-status',
    APK方式: 'col-apk-mode',
    APK链接: 'col-apk-link',
    平台: 'col-platform',
    合作方式: 'col-cooperation',
    错误原因: 'col-error',
  };
  return map[column] || 'col-normal';
}

function renderRegistrationCell(column, value, rowIndex) {
  const text = String(value || '').trim();
  const cls = registrationColumnClass(column);
  if (column === 'APK链接') {
    if (!text) return `<td class="${cls} muted-cell">无</td>`;
    return `
      <td class="${cls}">
        <button class="table-link-copy" type="button" data-copy-apk-link="${escapeHtml(text)}" title="${escapeHtml(text)}">
          <span>${escapeHtml(shortenMiddle(text, 26))}</span>
          <em>复制</em>
        </button>
      </td>
    `;
  }
  if (column === '错误原因') {
    if (!text) return `<td class="${cls} muted-cell">无</td>`;
    return `<td class="${cls}"><button class="btn btn-ghost btn-table" type="button" data-error-reason="${escapeHtml(text)}">查看</button></td>`;
  }
  return `<td class="${cls}" title="${escapeHtml(text)}"><span class="table-cell-text">${escapeHtml(text)}</span></td>`;
}

function shortenMiddle(value, maxLength = 28) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  const side = Math.max(6, Math.floor((maxLength - 3) / 2));
  return `${text.slice(0, side)}...${text.slice(-side)}`;
}

async function copyText(text) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {}
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  document.body.appendChild(input);
  input.select();
  document.execCommand('copy');
  input.remove();
}

function updateRegistrationDeleteButton() {
  if (!deleteRegistrationRowsBtn) return;
  const count = selectedRegistrationRows.size;
  deleteRegistrationRowsBtn.disabled = count === 0;
  deleteRegistrationRowsBtn.textContent = count ? `删除选中登记（${count}）` : '删除选中登记';
}

async function deleteSelectedRegistrationRows() {
  const indexes = [...selectedRegistrationRows].sort((a, b) => a - b);
  if (!indexes.length) {
    showNotice('请先选择登记信息', '请在登记表左侧勾选需要删除的记录。');
    return;
  }
  const rows = registrationCache.rows || [];
  const names = indexes.map((index) => rows[index]?.游戏名称 || rows[index]?.['游戏名称'] || `第 ${index + 1} 行`).filter(Boolean);
  const preview = names.slice(0, 6).join('、') + (names.length > 6 ? ` 等 ${names.length} 条` : '');
  const ok = window.confirm(`确认删除选中的 ${indexes.length} 条登记信息吗？\n\n${preview}\n\n删除后会从登记表中移除，但不会删除本地游戏资料文件。`);
  if (!ok) return;
  deleteRegistrationRowsBtn.disabled = true;
  deleteRegistrationRowsBtn.textContent = '删除中';
  const source = folderInput.value.trim() || latestState?.source || latestState?.preferences?.source || '';
  const result = await post('/api/delete-registration-rows', { source, rowIndexes: indexes });
  selectedRegistrationRows = new Set();
  await loadRegistration(source);
  await loadGames(source);
  showToast(`已删除 ${result.removed || indexes.length} 条登记信息。`, 'success');
}

function renderCalendar(rows) {
  const today = new Date();
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const startWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const counts = countCalendarRows(rows, year, month);
  const labels = ['日', '一', '二', '三', '四', '五', '六'];

  calendarMonthText.textContent = `${year}年${month + 1}月`;
  const cells = labels.map((label) => `<div class="calendar-label">${label}</div>`);
  for (let i = 0; i < startWeek; i += 1) cells.push('<div></div>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const count = counts.get(day) || 0;
    const classes = ['calendar-day'];
    if (day === today.getDate() && month === today.getMonth() && year === today.getFullYear()) classes.push('today');
    if (count) classes.push('has-log');
    cells.push(`
      <div class="${classes.join(' ')}" title="${count ? `登记 ${count} 个游戏` : '暂无登记'}">
        <span>${day}</span>
        ${count ? `<em>${count}</em>` : ''}
      </div>
    `);
  }
  calendarGrid.innerHTML = cells.join('');
}

function changeCalendarMonth(offset) {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + offset, 1);
  renderCalendar(registrationCache.rows || []);
}

function countCalendarRows(rows, year, month) {
  const counts = new Map();
  (rows || []).forEach((row) => {
    if (!isSuccessfulRegistrationRow(row)) return;
    const date = getCalendarDate(row);
    if (!date || date.getFullYear() !== year || date.getMonth() !== month) return;
    const day = date.getDate();
    counts.set(day, (counts.get(day) || 0) + 1);
  });
  return counts;
}

function isSuccessfulRegistrationRow(row) {
  const status = String(row['状态'] || row.status || '').trim();
  const gameId = String(row['游戏ID'] || row.gameId || '').trim();
  if (/失败|异常|未完成|跳过/.test(status)) return false;
  return status === '完成' || Boolean(gameId);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = window.setInterval(async () => {
    const wasRunning = lastRunningState;
    await loadState();
    const source = folderInput.value.trim() || latestState?.preferences?.source || '';
    if (source) await loadRegistration(source);
    const isRunning = Boolean(latestState?.running);
    if (source && !isRunning) await loadGames(source);
    if (activeRunToken && wasRunning && !isRunning && resultModalShownFor !== activeRunToken) {
      resultModalShownFor = activeRunToken;
      showTaskResultModal(latestState, registrationCache);
    }
    lastRunningState = isRunning;
    if (!isRunning) stopPolling();
  }, 2000);
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function showTaskResultModal(state, registration) {
  if (viewRegistrationFromResultBtn) viewRegistrationFromResultBtn.hidden = false;
  const code = state.lastResult?.code ?? 1;
  const ok = code === 0;
  const stopped = code === 2;
  const successCount = state.lastResult?.successCount ?? '';
  const failureCount = state.lastResult?.failureCount ?? '';
  const partialFailure = !ok && !stopped && failureCount !== '';
  const row = latestRegistrationRow(registration);
  const logs = Array.isArray(state.logs) ? state.logs : [];
  const importantLog = [...logs].reverse().find((line) => /失败|原因|异常|未检测|暂停|停止/.test(line));
  const reason = ok
    ? '全部任务已执行完成。'
    : partialFailure
      ? `全部任务已执行完成，其中成功 ${successCount} 个，失败 ${failureCount} 个。`
    : importantLog
      || logs[logs.length - 1]
      || (stopped ? '任务已停止。' : '任务执行失败，请查看任务状态或任务日志。');
  const gameId = row?.['游戏ID'] || extractGameIdFromLines(logs) || '';
  const showStatus = row?.['显示状态'] || '';
  const gameName = row?.['游戏名称'] || state.currentGame || currentGame()?.name || '';

  resultTitle.textContent = ok ? '任务已完成' : stopped ? '任务已停止' : partialFailure ? '任务部分失败' : '任务失败';
  resultSummaryBox.innerHTML = `
    <div class="result-lines">
      <div><span>结果</span><strong>${escapeHtml(ok ? '完成' : stopped ? '已停止' : partialFailure ? '部分失败' : '失败')}</strong></div>
      ${successCount !== '' ? `<div><span>成功数量</span><strong>${escapeHtml(successCount)}</strong></div>` : ''}
      ${failureCount !== '' ? `<div><span>失败数量</span><strong>${escapeHtml(failureCount)}</strong></div>` : ''}
      ${gameName ? `<div><span>游戏名称</span><strong>${escapeHtml(gameName)}</strong></div>` : ''}
      ${gameId ? `<div><span>游戏ID</span><strong>${escapeHtml(gameId)}</strong></div>` : '<div><span>游戏ID</span><strong>未获取到</strong></div>'}
      ${showStatus ? `<div><span>显示状态</span><strong>${escapeHtml(showStatus)}</strong></div>` : ''}
      <div><span>说明</span><strong>${escapeHtml(reason)}</strong></div>
    </div>
  `;
  resultModal.hidden = false;
  showToast(ok ? `任务已完成${gameId ? `，游戏ID：${gameId}` : ''}` : `任务${stopped ? '已停止' : partialFailure ? '部分失败' : '失败'}：${reason}`, ok ? 'success' : 'error');
}

function showNotExecutedModal(title, reason) {
  if (!resultModal) {
    window.alert(`${title}\n${reason}`);
    return;
  }
  resultTitle.textContent = title || '任务未执行';
  resultSummaryBox.innerHTML = `
    <div class="result-lines">
      <div><span>结果</span><strong>未执行</strong></div>
      <div><span>说明</span><strong>${escapeHtml(reason || '任务未开始，请检查当前选择和登录状态。')}</strong></div>
    </div>
  `;
  if (viewRegistrationFromResultBtn) viewRegistrationFromResultBtn.hidden = true;
  resultModal.hidden = false;
  showToast(reason || '任务未执行。', 'warning');
}

function closeResultModal() {
  if (viewRegistrationFromResultBtn) viewRegistrationFromResultBtn.hidden = false;
  resultModal.hidden = true;
}

function latestRegistrationRow(registration) {
  const rows = registration?.rows || [];
  if (!rows.length) return null;
  return rows[rows.length - 1];
}

function extractGameIdFromLines(lines) {
  const text = (lines || []).join(' ');
  const match = text.match(/(?:游戏ID|ID)[:：]?\s*([a-f0-9]{16,}|\d{4,})/i);
  return match?.[1] || '';
}

function currentGame() {
  return gamesData.find((game) => game.id === selectedGameId) || null;
}

function summarizeLocalGames() {
  return {
    total: gamesData.length,
    ready: gamesData.filter((game) => !game.blockingIssues.length).length,
    needFix: gamesData.filter((game) => game.blockingIssues.length || game.missingFields.length).length,
  };
}

function getCalendarDate(row) {
  const raw = row['时间'] || row['完成时间'] || row.finishedAt || '';
  const date = raw ? new Date(String(raw).replace(/-/g, '/')) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function setRunBadge(type, text) {
  runBadge.className = `run-badge ${type}`;
  runBadge.textContent = text;
}

function showToast(message, type = 'info') {
  if (!toast) {
    window.alert(message);
    return;
  }
  clearTimeout(toastTimer);
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3600);
}

function showNotice(title, message) {
  if (!noticeModal) {
    window.alert(`${title}\n${message}`);
    return;
  }
  noticeTitle.textContent = title;
  noticeMessage.textContent = message;
  noticeModal.hidden = false;
}

function closeNoticeModal() {
  noticeModal.hidden = true;
}

function normalizeMode(mode) {
  return 'submit';
}

function clampConcurrency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 3;
  return Math.max(1, Math.min(10, Math.round(number)));
}

function updateStrategyVisibility() {
  const autoShowRow = autoShowInput.closest('.switch-item');
  if (autoShowRow) autoShowRow.hidden = false;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '链接';
  }
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function sameBrowser(left, right) {
  if (!left || !right) return false;
  return left.browser === right.browser
    && left.profileName === right.profileName
    && left.executablePath === right.executablePath;
}

async function savePreferences(payload) {
  await post('/api/preferences', payload);
}

async function openPath(targetPath) {
  if (!targetPath) return;
  await post('/api/open-path', { path: targetPath });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
