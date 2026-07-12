import { $, escapeAttr as escAttr, escapeHtml as escHtml } from '../shared/dom.js';

const VIDEO_POLL_MS = 2500;
const DEBUG_LIMIT = 200;

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function eventTime(event) {
  return Number(event?.time_s ?? event?.t ?? 0);
}

function frameTime(frame) {
  return Number(frame?.video_t ?? frame?.t ?? 0);
}

function parseUtcEpoch(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function renderInfoCard(label, value) {
  return `<div class="info-card"><span class="lbl">${escHtml(label)}</span><span class="val">${escHtml(value)}</span></div>`;
}

export function createVideoConsole({ adminFetch, toast, getSessionCache, isActive = () => true }) {
  let pollTimer = null;
  let activeSid = null;
  let loading = false;
  let videoInfo = null;
  let latestExp = null;
  let latestSt = null;
  let latestTimeline = null;
  let debugEvents = [];
  let viewToken = 0;
  const expandedDebugIds = new Set();
  const debugDetailCache = new Map();

  function stopTimers() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    viewToken += 1;
  }

  function active() {
    return isActive() && activeSid;
  }

  function ensureShell(sid) {
    if (!active()) return;
    const detail = $('detail');
    if (!detail) return;
    if (detail.dataset.videoSid === String(sid) && $('video-overview')) return;
    detail.dataset.videoSid = String(sid);
    detail.innerHTML = `
      <div class="video-console">
        <section class="video-overview-panel">
          <div class="section-heading">
            <h3>视频信息</h3>
            <div id="video-actions" class="action-bar compact"></div>
          </div>
          <div id="video-overview" class="info-grid"></div>
        </section>

        <section class="video-panel video-chat-panel">
          <div class="video-panel-title">
            <h3>AI 对话</h3>
            <span id="video-chat-count" class="muted">0 条</span>
          </div>
          <div id="video-chat-list" class="video-chat-list"></div>
        </section>

        <section class="video-panel video-sync-panel">
          <div class="video-panel-title">
            <h3>日志</h3>
            <span id="video-log-count" class="muted">0 条</span>
          </div>
          <div id="video-frame-table" class="video-frame-table-wrap"></div>
        </section>
      </div>
    `;
  }

  function render(exp, st) {
    if (!exp?.session) {
      stopTimers();
      const detail = $('detail');
      if (detail) detail.innerHTML = '<div class="empty-state"><p>从左侧选择一个 Session 查看视频索引</p></div>';
      return;
    }
    const sid = exp.session.id;
    if (activeSid !== sid) {
      videoInfo = null;
      latestTimeline = null;
      debugEvents = [];
      expandedDebugIds.clear();
      debugDetailCache.clear();
    }
    activeSid = sid;
    latestExp = exp;
    latestSt = st || {};
    viewToken += 1;
    ensureShell(sid);
    updateViews();
    refresh({ silent: true, token: viewToken });
    if (!pollTimer) pollTimer = setInterval(() => refresh({ silent: true, token: viewToken }), VIDEO_POLL_MS);
  }

  async function refresh({ silent = false, token = viewToken } = {}) {
    if (!activeSid || loading || !isActive()) return;
    const sid = activeSid;
    loading = true;
    try {
      const expForFilter = latestExp?.session || {};
      const participant = expForFilter.participant_id || videoInfo?.participant_id || '';
      const debugParams = new URLSearchParams({ limit: String(DEBUG_LIMIT), session_id: String(sid) });
      if (participant) debugParams.set('participant_id', participant);
      const [infoR, exportR, statsR, timelineR, debugR] = await Promise.all([
        adminFetch(`/api/admin/sessions/${sid}/video/info`),
        adminFetch(`/api/admin/sessions/${sid}/export`),
        adminFetch(`/api/admin/expression/${sid}/stats`),
        adminFetch(`/api/admin/sessions/${sid}/timeline`),
        adminFetch(`/api/admin/debug?${debugParams.toString()}`),
      ]);
      const [info, exp, st, timeline, debugPage] = await Promise.all([
        infoR.json(),
        exportR.json(),
        statsR.json(),
        timelineR.json(),
        debugR.json(),
      ]);
      if (token !== viewToken || sid !== activeSid || !isActive()) return;
      videoInfo = info;
      latestExp = exp;
      latestSt = st;
      latestTimeline = timeline;
      debugEvents = debugPage.events || [];
      getSessionCache()[sid] = { exp, st };
      ensureShell(sid);
      updateViews();
    } catch (err) {
      if (!silent && isActive()) toast('视频数据刷新失败', 'err');
    } finally {
      loading = false;
    }
  }

  function updateViews() {
    if (!active() || !latestExp) return;
    updateOverview();
    preserveScroll('video-chat-list', updateChat);
    preserveScroll('video-frame-table', updateLogRows);
  }

  function preserveScroll(id, renderFn) {
    const el = $(id);
    const top = el?.scrollTop || 0;
    renderFn();
    const next = $(id);
    if (next) next.scrollTop = top;
  }

  function updateOverview() {
    const session = latestExp?.session || {};
    const participant = videoInfo?.participant_id || session.participant_id || '-';
    const size = videoInfo?.size_human || '0 B';
    const duration = videoInfo?.duration_human || '-';
    const overview = $('video-overview');
    const actions = $('video-actions');
    if (overview) {
      overview.innerHTML = [
        renderInfoCard('Session ID', `#${session.id ?? '-'}`),
        renderInfoCard('实验者编号', participant),
        renderInfoCard('视频大小', size),
        renderInfoCard('视频时长', duration),
      ].join('');
    }
    if (actions) {
      const download = videoInfo?.available
        ? `<a class="video-link-button primary" href="${escAttr(videoInfo.download_url)}">下载视频</a>`
        : '<button disabled>下载视频</button>';
      actions.innerHTML = `
        ${download}
        <button class="danger" data-action="confirm-delete-video" data-session-id="${session.id}">删除视频</button>
      `;
    }
  }

  function chatEvents() {
    return (latestTimeline?.events || [])
      .filter((event) => event.type === 'chat_user' || event.type === 'chat_ai')
      .map((event) => ({
        event,
        t: eventTime(event),
        isAi: event.type === 'chat_ai',
        payload: event.payload || {},
      }))
      .filter((item) => Number.isFinite(item.t))
      .sort((a, b) => a.t - b.t || a.event.id - b.event.id);
  }

  function updateChat() {
    const rows = chatEvents();
    const list = $('video-chat-list');
    const count = $('video-chat-count');
    if (count) count.textContent = `${rows.length} 条`;
    if (!list) return;
    if (!rows.length) {
      list.innerHTML = '<div class="video-empty-line">暂无 AI 对话记录</div>';
      return;
    }
    list.innerHTML = rows.map(({ event, t, isAi, payload }) => `
      <article class="video-chat-item ${isAi ? 'ai' : 'user'}">
        <div class="video-chat-meta">
          <span class="video-time-pill">视频 ${formatSeconds(t)}</span>
          <span>${isAi ? 'AI' : '用户'} #${escHtml(payload.seq ?? event.id)}</span>
          ${payload.strategy ? `<span class="tag strat">${escHtml(payload.strategy)}</span>` : ''}
          ${payload.expression_label ? `<span class="tag expr">${escHtml(payload.expression_label)}</span>` : ''}
        </div>
        <div class="video-chat-content">${escHtml(payload.text || '')}</div>
      </article>
    `).join('');
  }

  function sessionStartEpoch() {
    return parseUtcEpoch(latestTimeline?.start_time || latestExp?.session?.start_time);
  }

  function debugVideoTime(event) {
    const start = sessionStartEpoch();
    const epoch = Number(event?.epoch);
    if (Number.isFinite(start) && Number.isFinite(epoch)) return Math.max(0, epoch - start);
    return 0;
  }

  function nearestFrameForEvent(event) {
    if (!['expression', 'baseline'].includes(event?.kind)) return null;
    const t = debugVideoTime(event);
    let best = null;
    let bestDelta = Infinity;
    for (const frame of latestSt?.frames || []) {
      const delta = Math.abs(frameTime(frame) - t);
      if (delta < bestDelta) {
        best = frame;
        bestDelta = delta;
      }
    }
    return bestDelta <= 1.5 ? best : null;
  }

  function updateLogRows() {
    const rows = debugEvents;
    const table = $('video-frame-table');
    const count = $('video-log-count');
    if (count) count.textContent = `${rows.length} 条`;
    if (!table) return;
    if (!rows.length) {
      table.innerHTML = '<div class="video-empty-line">暂无日志记录</div>';
      return;
    }
    table.innerHTML = `
      <table class="frame-table video-sync-table">
        <thead>
          <tr>
            <th>视频标记</th><th>类型</th><th>AU1</th><th>AU4</th><th>AU7</th><th>AU12</th>
            <th>FACE</th><th>RELIABLE</th><th>信息</th><th>详情</th>
          </tr>
        </thead>
        <tbody>${rows.map(renderLogRow).join('')}</tbody>
      </table>
    `;
  }

  function renderLogRow(e) {
    const id = String(e.id ?? '');
    const expanded = expandedDebugIds.has(id);
    const detail = debugDetailCache.get(id);
    const t = debugVideoTime(e);
    const frame = nearestFrameForEvent(e);
    return `
      <tr>
        <td><span class="video-time-pill">视频 ${formatSeconds(t)}</span></td>
        <td>${escHtml(e.kind || '')}</td>
        <td>${escHtml(valueOrDash(frame?.au1))}</td>
        <td>${escHtml(valueOrDash(frame?.au4))}</td>
        <td>${escHtml(valueOrDash(frame?.au7))}</td>
        <td>${escHtml(valueOrDash(frame?.au12))}</td>
        <td>${e.face_detected ? 'yes' : 'no'}</td>
        <td>${e.reliable ? 'yes' : 'no'}</td>
        <td>${escHtml(e.message || '')}</td>
        <td><button class="debug-expand" data-action="video-sync-detail" data-sync-key="${escAttr(id)}">${expanded ? '收起' : '展开'}</button></td>
      </tr>
      ${expanded ? `<tr class="debug-detail-row video-sync-detail-row"><td colspan="10"><div class="debug-detail-body">${detail || '加载详情中...'}</div></td></tr>` : ''}
    `;
  }

  function valueOrDash(value) {
    return value === null || value === undefined || value === '' ? '-' : value;
  }

  async function toggleDetail(key) {
    if (!key) return;
    if (expandedDebugIds.has(key)) {
      expandedDebugIds.delete(key);
      updateLogRows();
      return;
    }
    expandedDebugIds.add(key);
    updateLogRows();
    if (!debugDetailCache.has(key)) await loadDebugDetail(key);
  }

  async function loadDebugDetail(eventId) {
    try {
      const r = await adminFetch(`/api/admin/debug-event/${encodeURIComponent(eventId)}`);
      const event = await r.json();
      debugDetailCache.set(String(eventId), renderDebugDetail(event));
    } catch (err) {
      debugDetailCache.set(String(eventId), '详情加载失败');
    }
    updateLogRows();
  }

  function renderDebugDetail(e) {
    const kb = e.bytes ? Math.round(e.bytes / 1024 * 10) / 10 : '';
    const eventId = encodeURIComponent(e.id ?? '');
    const hasApi = e.api_response !== undefined;
    const apiUrl = `/api/admin/debug-event/${eventId}/json?part=api`;
    const eventUrl = `/api/admin/debug-event/${eventId}/json?part=event`;
    const image = e.image ? `
      <div class="debug-face">
        <img src="${escAttr(e.image)}" alt="captured frame">
        <div>
          <div style="color:#94a3b8;line-height:1.6">
            Captured frame sent to PyFeat.<br>
            Payload: ${kb || 0} KB · Time: ${e.elapsed_ms ?? ''} ms
          </div>
          <a href="${escAttr(e.image)}" download="debug-${escAttr(e.participant_id || 'unknown')}-${escAttr(e.session_id ?? 'none')}-${escAttr(e.ts || e.id)}.jpg">下载图片</a>
        </div>
      </div>` : '<div style="color:#64748b;margin-top:8px">这个事件没有图片。</div>';
    return `
      ${image}
      <div class="debug-detail-summary">
        类型: ${escHtml(e.kind || '-')} · 参与者: ${escHtml(e.participant_id || '-')} · Session: ${escHtml(e.session_id ?? '-')} · ${escHtml(e.message || '')}
      </div>
      <div class="debug-json-actions">
        ${hasApi ? `<a class="debug-json-link" href="${escAttr(apiUrl)}" target="_blank" rel="noopener noreferrer">查看 PyFeat JSON</a>` : ''}
        <a class="debug-json-link" href="${escAttr(eventUrl)}" target="_blank" rel="noopener noreferrer">查看完整日志事件</a>
      </div>`;
  }

  function confirmDeleteVideo(sid) {
    const overlay = $('modal-overlay');
    const modal = overlay?.querySelector('.modal');
    if (!overlay || !modal) return;
    overlay.classList.remove('hidden');
    modal.innerHTML = `
      <h3>删除实验视频</h3>
      <p>确定删除 Session #${sid} 的视频吗？这会删除所有已上传的视频分段和最终视频文件，但不会删除会话数据。</p>
      <div class="modal-actions">
        <button data-action="close-modal">取消</button>
        <button class="danger" data-action="do-delete-video" data-session-id="${sid}">确认删除</button>
      </div>
    `;
  }

  async function deleteVideo(sid) {
    const r = await adminFetch(`/api/admin/sessions/${sid}/video`, { method: 'DELETE' });
    if (!r.ok) {
      toast('视频删除失败', 'err');
      return;
    }
    $('modal-overlay')?.classList.add('hidden');
    videoInfo = null;
    toast('视频已删除', 'ok');
    await refresh();
  }

  function handleAction(action, el) {
    if (action === 'confirm-delete-video') {
      confirmDeleteVideo(Number(el.dataset.sessionId));
      return true;
    }
    if (action === 'do-delete-video') {
      deleteVideo(Number(el.dataset.sessionId));
      return true;
    }
    if (action === 'video-sync-detail') {
      toggleDetail(el.dataset.syncKey);
      return true;
    }
    return false;
  }

  return {
    render,
    refresh,
    stopTimers,
    handleAction,
  };
}
