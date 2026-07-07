import './style.css';
import { $, escapeHtml as escHtml } from '../shared/dom.js';
import { createDebugConsole } from './debugConsole.js';
import { renderBaseline, renderChat, renderExpression, renderOverview } from './sessionViews.js';
import { createSessionActions } from './sessionActions.js';

let sessions = [];
let activeSid = null;
let sessionCache = {};
let activeTab = 'debug';
let refreshTimer = null;

const THEME_KEY = 'admin-theme';

function setTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.classList.toggle('dark', next === 'dark');
  localStorage.setItem(THEME_KEY, next);
  $('themeToggle')?.setAttribute('aria-checked', next === 'dark' ? 'true' : 'false');
}

function initTheme() {
  setTheme(localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light');
}

function showAuth(message = '') {
  const overlay = $('auth-overlay');
  const error = $('auth-error');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  if (error) error.textContent = '';
  if (message) toast(message, 'err');
  setTimeout(() => $('auth-token')?.focus(), 0);
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function hideAuth() {
  const overlay = $('auth-overlay');
  const error = $('auth-error');
  overlay?.classList.add('hidden');
  if (error) error.textContent = '';
  if (!refreshTimer) refreshTimer = setInterval(refresh, 10000);
}

async function adminFetch(url, opts = {}) {
  const r = await fetch(url, { ...opts, credentials: 'same-origin' });
  if (r.status === 401) {
    showAuth('Token 已失效，请重新输入。');
    toast('Token 已失效，请重新登录', 'err');
    throw new Error('unauthorized');
  }
  return r;
}

const authForm = $('auth-form');
authForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const tokenInput = $('auth-token');
  const error = $('auth-error');
  const token = tokenInput?.value.trim() || '';
  if (!token) {
    if (error) error.textContent = '';
    toast('请输入 token', 'err');
    return;
  }
  const body = new URLSearchParams();
  body.set('token', token);
  const r = await fetch('/api/admin/login', { method: 'POST', body, credentials: 'same-origin' });
  if (!r.ok) {
    if (error) error.textContent = '';
    toast('Token 错误', 'err');
    return;
  }
  if (tokenInput) tokenInput.value = '';
  hideAuth();
  toast('登录成功', 'ok');
  await refresh();
  renderActiveTab();
});

async function initAuth() {
  const r = await fetch('/api/admin/auth', { credentials: 'same-origin' });
  if (!r.ok) {
    showAuth();
    return;
  }
  hideAuth();
  await refresh();
  renderActiveTab();
}

function toast(msg, type = 'ok') {
  const container = $('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);

  requestAnimationFrame(() => {
    el.style.maxHeight = `${el.scrollHeight}px`;
  });

  setTimeout(() => {
    el.style.maxHeight = `${el.scrollHeight}px`;
    el.classList.add('leaving');
    requestAnimationFrame(() => {
      el.style.maxHeight = '0px';
    });
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  }, 3000);
}

const debugConsole = createDebugConsole({ adminFetch, toast });

const sessionActions = createSessionActions({
  adminFetch,
  toast,
  getSessionCache: () => sessionCache,
  onDeleted: () => {
    activeSid = null;
    activeTab = 'debug';
    setActiveTab(activeTab);
    debugConsole.render();
    refresh();
  },
});

async function refresh() {
  const r = await adminFetch('/api/admin/sessions');
  sessions = await r.json();
  renderStats();
  renderList();
  if (activeTab !== 'debug' && activeSid) await loadSession(activeSid, true);
}

async function renderStats() {
  const done = sessions.filter((s) => s.completed);
  const excl = sessions.filter((s) => s.excluded);
  const statsRow = $('stats-row');
  if (!statsRow) return;
  statsRow.innerHTML = `
    <div class="stat"><div class="val green">${done.length}</div><div class="lbl">已完成</div></div>
    <div class="stat"><div class="val indigo">${sessions.length}</div><div class="lbl">总计</div></div>
    <div class="stat"><div class="val amber">${excl.length}</div><div class="lbl">已排除</div></div>
  `;
}

function sessionStatusText(s) {
  if (s.completed) {
    if (s.completion_type === 'timeout') return '超时';
    if (s.completion_type === 'deleted') return '已删除';
    return '手动提交';
  }
  if (s.activity?.active) return '进行中';
  if ((s.total_turns || 0) > 0 || (s.total_revisions || 0) > 0) return '进行中';
  return '未开始';
}

function sessionDotClass(s) {
  if (s.excluded) return 'excl';
  if (s.completed) return 'done';
  if (s.activity?.active || (s.total_turns || 0) > 0) return 'active';
  return 'pending';
}

function renderList() {
  const q = ($('search').value || '').toLowerCase();
  const cond = $('filter-cond').value;
  let filtered = sessions;
  if (q) {
    filtered = filtered.filter((s) => (
      (s.participant_id || '').toLowerCase().includes(q)
      || String(s.id).includes(q)
      || String(s.condition || '').toLowerCase().includes(q)
    ));
  }
  if (cond !== 'all') filtered = filtered.filter((s) => s.condition === cond);

  const html = filtered.map((s) => {
    const conditionLabel = s.condition === 'affect-aware' ? '情感感知' : '纯文本';
    const status = sessionStatusText(s);
    const loss = s.frame_loss_ratio > 0.3 ? `<span class="loss">丢帧 ${Math.round(s.frame_loss_ratio * 100)}%</span>` : '';
    return `<button type="button" class="session-item ${s.id === activeSid ? 'active' : ''} ${s.excluded ? 'excluded' : ''}"
      data-action="select-session" data-session-id="${s.id}">
      <span class="session-main">
        <span class="session-id">${escHtml(s.participant_id)}</span>
        <span class="tag ${s.condition === 'affect-aware' ? 'ai' : 'text'}">${conditionLabel}</span>
        <span class="session-number">#${s.id}</span>
        <span class="session-status">${status}</span>
        ${loss}
      </span>
      <span class="session-side">
        <span class="dot ${sessionDotClass(s)}" title="${status}"></span>
        <span class="turns">${s.total_turns || 0}轮</span>
      </span>
    </button>`;
  }).join('');

  const list = $('session-list');
  if (list) list.innerHTML = html || '<div class="empty">无匹配的 Session</div>';
}

async function selectSession(sid) {
  activeSid = sid;
  activeTab = 'overview';
  renderList();
  await loadSession(sid);
}

async function loadSession(sid, silent = false) {
  if (!silent && $('detail')) $('detail').innerHTML = '<div class="loading"><div class="spinner"></div><p>加载中...</p></div>';

  const [exportR, statsR] = await Promise.all([
    adminFetch(`/api/admin/sessions/${sid}/export`),
    adminFetch(`/api/admin/expression/${sid}/stats`),
  ]);
  const exp = await exportR.json();
  const st = await statsR.json();
  sessionCache[sid] = { exp, st };

  setActiveTab(activeTab);
  renderActiveTab();
}

$('tabs')?.addEventListener('click', (e) => {
  if (e.target.tagName !== 'BUTTON') return;
  activeTab = e.target.dataset.tab;
  setActiveTab(activeTab);
  renderActiveTab();
});

function setActiveTab(tab) {
  $('tabs')?.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
}

function renderActiveTab() {
  const { exp, st } = sessionCache[activeSid] || {};
  if (activeTab === 'debug') {
    debugConsole.render();
    return;
  }
  debugConsole.stopTimers();
  if (!exp) {
    if ($('detail')) $('detail').innerHTML = '<div class="empty-state"><div class="icon">→</div><p>从左侧选择一个 Session 查看详情</p></div>';
    return;
  }
  if (activeTab === 'overview') renderOverview(exp, st);
  if (activeTab === 'chat') renderChat(exp);
  if (activeTab === 'expression') renderExpression(exp, st);
  if (activeTab === 'baseline') renderBaseline(exp);
}

function bindAdminEvents() {
  $('search')?.addEventListener('input', renderList);
  $('filter-cond')?.addEventListener('change', renderList);
  $('themeToggle')?.addEventListener('click', () => {
    setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
  });
  document.addEventListener('click', handleAdminClick);
  document.addEventListener('input', handleAdminInput);
  document.addEventListener('change', handleAdminChange);
}

function handleAdminClick(e) {
  if (e.target === $('modal-overlay')) {
    sessionActions.closeModal();
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'select-session') return selectSession(Number(el.dataset.sessionId));
  if (action === 'toggle-debug') return debugConsole.toggleMode();
  if (action === 'clear-debug') return debugConsole.clearLogs();
  if (action === 'check-health') return debugConsole.checkHealth();
  if (action === 'choose-debug-image') {
    debugConsole.stopFollow();
    return $('debug-upload')?.click();
  }
  if (action === 'test-ai') return debugConsole.testAIStatus(el.dataset.provider);
  if (action === 'debug-detail') return debugConsole.toggleDetail(e, Number(el.dataset.eventId));
  if (action === 'export-session') return sessionActions.exportSession(Number(el.dataset.sessionId));
  if (action === 'export-session-csv') return sessionActions.exportSessionCSV(Number(el.dataset.sessionId));
  if (action === 'export-expression-csv') return sessionActions.exportExpressionCSV(Number(el.dataset.sessionId));
  if (action === 'confirm-delete') return sessionActions.confirmDelete(Number(el.dataset.sessionId), el.dataset.participantId || '');
  if (action === 'close-modal') return sessionActions.closeModal();
  if (action === 'do-delete') return sessionActions.deleteSession(Number(el.dataset.sessionId));
}

function handleAdminInput(e) {
  if (['debug-search', 'debug-participant', 'debug-session'].includes(e.target.id)) {
    debugConsole.stopFollow();
    debugConsole.scheduleReload();
  }
}

function handleAdminChange(e) {
  if (e.target.id === 'debug-kind') {
    debugConsole.stopFollow();
    debugConsole.reload();
  }
  if (e.target.id === 'debug-upload') {
    debugConsole.uploadImage();
  }
}

bindAdminEvents();
initTheme();
initAuth();
