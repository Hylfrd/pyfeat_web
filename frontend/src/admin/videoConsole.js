import { $, escapeAttr as escAttr, escapeHtml as escHtml } from '../shared/dom.js';

const VIDEO_POLL_MS = 1500;
const SYNC_WINDOW = 160;

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function safeDateMs(value) {
  if (!value) return null;
  let text = String(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) {
    text = `${text}Z`;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function offsetSeconds(atMs, startMs) {
  if (atMs === null || startMs === null) return null;
  return Math.max(0, (atMs - startMs) / 1000);
}

function chatTime(log, session) {
  return offsetSeconds(safeDateMs(log?.timestamp), safeDateMs(session?.start_time));
}

function frameReliable(frame) {
  return !!(frame?.ok ?? frame?.reliable);
}

function frameFace(frame) {
  return !!(frame?.face ?? frame?.face_detected);
}

function frameVideoTime(frame) {
  return Number(frame?.video_t ?? frame?.t ?? 0);
}

function debugEventTime(event, session) {
  const startMs = safeDateMs(session?.start_time);
  if (startMs === null) return null;
  if (Number.isFinite(Number(event?.epoch))) {
    return offsetSeconds(Number(event.epoch) * 1000, startMs);
  }
  const match = String(event?.ts || '').match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const start = new Date(startMs);
  const candidate = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  );
  let diff = (candidate.getTime() - startMs) / 1000;
  if (diff < -12 * 3600) diff += 24 * 3600;
  if (diff > 12 * 3600) diff -= 24 * 3600;
  return Math.max(0, diff);
}

function minNumber(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  return filtered.length ? Math.min(...filtered) : null;
}

function buildTimeline(exp, st, debugEvents) {
  const session = exp?.session || {};
  const preDone = offsetSeconds(safeDateMs(exp?.pre_survey?.created_at), safeDateMs(session.start_time));
  const taskEnd = offsetSeconds(safeDateMs(session.end_time), safeDateMs(session.start_time));
  const firstFrame = minNumber((st?.frames || []).map(frameVideoTime));
  const firstChat = minNumber((exp?.chat_logs || []).map((log) => chatTime(log, session)));
  const firstTaskDebug = minNumber((debugEvents || [])
    .filter((event) => ['expression', 'strategy', 'ai', 'eval'].includes(event.kind))
    .map((event) => debugEventTime(event, session)));
  const firstBaselineDebug = minNumber((debugEvents || [])
    .filter((event) => event.kind === 'baseline')
    .map((event) => debugEventTime(event, session)));

  return {
    baselineStart: minNumber([preDone, firstBaselineDebug]),
    taskStart: minNumber([firstFrame, firstChat, firstTaskDebug]),
    postStart: taskEnd,
  };
}

function stageAt(currentTime, timeline, fallback = '-') {
  const t = Number(currentTime) || 0;
  if (Number.isFinite(timeline.postStart) && t >= timeline.postStart) return '实验后问卷';
  if (Number.isFinite(timeline.taskStart) && t >= timeline.taskStart) return '实验中';
  if (Number.isFinite(timeline.baselineStart) && t >= timeline.baselineStart) return '基准测试';
  if ([timeline.baselineStart, timeline.taskStart, timeline.postStart].some((value) => Number.isFinite(value))) {
    return '实验前问卷';
  }
  return fallback && fallback !== '-' ? fallback : '实验前问卷';
}

export function createVideoConsole({ adminFetch, toast, getSessionCache, isActive = () => true }) {
  let pollTimer = null;
  let activeSid = null;
  let loading = false;
  let player = null;
  let videoInfo = null;
  let latestExp = null;
  let latestSt = null;
  let latestDebugEvents = [];
  let lastVideoSize = -1;
  let currentTime = 0;
  let viewToken = 0;
  const expandedSyncKeys = new Set();

  function stopTimers() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    viewToken += 1;
  }

  function active() {
    return isActive() && activeSid;
  }

  function destroyPlayer() {
    if (player && typeof player.destroy === 'function') {
      try { player.destroy(); } catch (e) {}
    }
    player = null;
    lastVideoSize = -1;
  }

  function ensureShell(sid) {
    if (!active()) return;
    const detail = $('detail');
    if (!detail) return;
    if (detail.dataset.videoSid === String(sid) && $('session-video-player')) return;
    destroyPlayer();
    detail.dataset.videoSid = String(sid);
    detail.innerHTML = `
      <div class="video-console">
        <section class="video-panel video-overview-panel">
          <div class="video-panel-title">
            <h3>视频索引</h3>
          </div>
          <div id="video-overview" class="video-overview-grid"></div>
        </section>

        <section class="video-panel video-chat-panel">
          <div class="video-panel-title">
            <h3>AI 对话</h3>
            <span id="video-chat-count" class="muted">0 / 0 条</span>
          </div>
          <div id="video-chat-list" class="video-chat-list"></div>
        </section>

        <section class="video-panel video-player-panel">
          <div class="video-player-box">
            <video id="session-video-player" class="video-player" controls playsinline preload="metadata"></video>
            <div id="video-empty" class="video-empty">暂无可播放视频</div>
          </div>
        </section>

        <section class="video-panel video-sync-panel">
          <div class="video-panel-title">
            <h3>同步 AU 与日志</h3>
            <span id="video-sync-time" class="muted">视频 0:00</span>
          </div>
          <div id="video-frame-table" class="video-frame-table-wrap"></div>
        </section>
      </div>
    `;
    const video = $('session-video-player');
    video?.addEventListener('timeupdate', () => {
      currentTime = video.currentTime || 0;
      updatePlaybackViews();
    });
    video?.addEventListener('seeked', () => {
      currentTime = video.currentTime || 0;
      updatePlaybackViews();
    });
    initPlayer();
  }

  function initPlayer() {
    const video = $('session-video-player');
    if (!video || player) return;
    if (window.Plyr) {
      player = new window.Plyr(video, {
        controls: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'fullscreen'],
        settings: ['speed'],
      });
    }
  }

  function render(exp, st) {
    if (!exp?.session) {
      stopTimers();
      const detail = $('detail');
      if (detail) detail.innerHTML = '<div class="empty-state"><p>从左侧选择一个 Session 查看视频</p></div>';
      return;
    }
    const sid = exp.session.id;
    if (activeSid !== sid) {
      videoInfo = null;
      latestDebugEvents = [];
      expandedSyncKeys.clear();
      currentTime = 0;
    }
    activeSid = sid;
    latestExp = exp;
    latestSt = st || {};
    viewToken += 1;
    ensureShell(sid);
    updatePlaybackViews();
    refresh({ silent: true, token: viewToken });
    if (!pollTimer) pollTimer = setInterval(() => refresh({ silent: true, token: viewToken }), VIDEO_POLL_MS);
  }

  async function refresh({ silent = false, token = viewToken } = {}) {
    if (!activeSid || loading || !isActive()) return;
    const sid = activeSid;
    loading = true;
    try {
      const debugParams = new URLSearchParams({ limit: '300', session_id: String(sid) });
      const [infoR, exportR, statsR, debugR] = await Promise.all([
        adminFetch(`/api/admin/sessions/${sid}/video/info`),
        adminFetch(`/api/admin/sessions/${sid}/export`),
        adminFetch(`/api/admin/expression/${sid}/stats`),
        adminFetch(`/api/admin/debug?${debugParams.toString()}`),
      ]);
      const [info, exp, st, debugPage] = await Promise.all([infoR.json(), exportR.json(), statsR.json(), debugR.json()]);
      if (token !== viewToken || sid !== activeSid || !isActive()) return;
      videoInfo = info;
      latestExp = exp;
      latestSt = st;
      latestDebugEvents = debugPage.events || [];
      getSessionCache()[sid] = { exp, st };
      ensureShell(sid);
      updatePlayer(info);
      updatePlaybackViews();
    } catch (err) {
      if (!silent && isActive()) toast('视频数据刷新失败', 'err');
    } finally {
      loading = false;
    }
  }

  function updatePlaybackViews() {
    if (!active() || !latestExp) return;
    updateOverview();
    updateChat();
    updateSyncRows();
    updateSyncTime();
  }

  function updateOverview() {
    const session = latestExp?.session || {};
    const timeline = buildTimeline(latestExp, latestSt, latestDebugEvents);
    const participant = videoInfo?.participant_id || session.participant_id || '-';
    const size = videoInfo?.size_human || '0 B';
    const chunks = Number(videoInfo?.chunk_count || 0);
    const stage = stageAt(currentTime, timeline, videoInfo?.stage || '-');
    const download = videoInfo?.available
      ? `<a class="video-link-button primary" href="${escAttr(videoInfo.download_url)}">下载视频</a>`
      : '<button disabled>下载视频</button>';
    const html = `
      <div class="video-info-card"><span>实验者编号</span><strong>${escHtml(participant)}</strong></div>
      <div class="video-info-card"><span>播放位置</span><strong>${formatSeconds(currentTime)}</strong></div>
      <div class="video-info-card"><span>当前阶段</span><strong>${escHtml(stage)}</strong></div>
      <div class="video-info-card"><span>视频大小</span><strong>${escHtml(size)}</strong></div>
      <div class="video-info-card"><span>视频分段</span><strong>${chunks} 段</strong></div>
      <div class="video-action-row">
        ${download}
        <button class="danger" data-action="confirm-delete-video" data-session-id="${session.id}">删除视频</button>
      </div>
    `;
    const overview = $('video-overview');
    if (overview) overview.innerHTML = html;
  }

  function updatePlayer(info = {}) {
    const video = $('session-video-player');
    const empty = $('video-empty');
    if (!video || !empty || !isActive()) return;
    if (!info.available) {
      video.removeAttribute('src');
      video.load();
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');
    initPlayer();
    const size = Number(info.size_bytes || 0);
    const shouldReload = !video.src || lastVideoSize < 0 || (size !== lastVideoSize && (video.paused || video.ended));
    if (!shouldReload) return;
    const previousTime = video.currentTime || 0;
    const wasPaused = video.paused;
    video.src = `${info.url}?v=${encodeURIComponent(size || Date.now())}`;
    lastVideoSize = size;
    video.addEventListener('loadedmetadata', () => {
      if (previousTime > 0 && Number.isFinite(video.duration)) {
        video.currentTime = Math.min(previousTime, Math.max(0, video.duration - 0.25));
      }
      if (!wasPaused) video.play().catch(() => {});
    }, { once: true });
  }

  function updateChat() {
    const logs = (latestExp?.chat_logs || []).filter((log) => !log.is_hidden);
    const visible = logs
      .map((log) => ({ log, t: chatTime(log, latestExp.session) }))
      .filter((item) => Number.isFinite(item.t) && item.t <= currentTime)
      .slice(-20);
    const list = $('video-chat-list');
    const count = $('video-chat-count');
    if (count) count.textContent = `${visible.length} / ${logs.length} 条`;
    if (!list) return;
    if (!visible.length) {
      list.innerHTML = '<div class="video-empty-line">当前时间点还没有 AI 对话</div>';
      return;
    }
    list.innerHTML = visible.map(({ log, t }) => {
      const isAi = log.role === 'ai';
      return `
        <article class="video-chat-item ${isAi ? 'ai' : 'user'}">
          <div class="video-chat-meta">
            <span>${isAi ? 'AI' : '用户'} #${log.seq}</span>
            <span>${formatSeconds(t)}</span>
            ${log.strategy_applied ? `<span class="tag strat">${escHtml(log.strategy_applied)}</span>` : ''}
            ${log.expression_label ? `<span class="tag expr">${escHtml(log.expression_label)}</span>` : ''}
          </div>
          <div class="video-chat-content">${escHtml(log.content || '')}</div>
        </article>
      `;
    }).join('');
    list.scrollTop = list.scrollHeight;
  }

  function syncRows() {
    const frameRows = (latestSt?.frames || []).map((frame, index) => {
      const t = frameVideoTime(frame);
      return {
        key: `frame-${index}`,
        t,
        type: 'AU',
        au1: frame.au1,
        au4: frame.au4,
        au7: frame.au7,
        au12: frame.au12,
        face: frameFace(frame) ? 'yes' : 'no',
        reliable: frameReliable(frame) ? 'yes' : 'no',
        message: frame.drop_reason || 'expression frame',
        detail: {
          time_s: t,
          au1: frame.au1,
          au4: frame.au4,
          au7: frame.au7,
          au12: frame.au12,
          yaw: frame.yaw,
          pitch: frame.pitch,
          queued_ms: frame.queued_ms || 0,
          drop_reason: frame.drop_reason || '',
          face: frameFace(frame),
          reliable: frameReliable(frame),
        },
      };
    });

    const eventRows = (latestDebugEvents || []).map((event) => {
      const t = debugEventTime(event, latestExp?.session || {});
      return {
        key: `event-${event.id}`,
        t,
        type: event.kind || 'log',
        au1: '-',
        au4: '-',
        au7: '-',
        au12: '-',
        face: event.face_detected === undefined ? '-' : (event.face_detected ? 'yes' : 'no'),
        reliable: event.reliable === undefined ? '-' : (event.reliable ? 'yes' : 'no'),
        message: event.message || '',
        detail: event,
      };
    });

    return frameRows.concat(eventRows)
      .filter((row) => Number.isFinite(row.t) && row.t <= currentTime)
      .sort((a, b) => a.t - b.t || String(a.key).localeCompare(String(b.key)))
      .slice(-SYNC_WINDOW);
  }

  function updateSyncRows() {
    const rows = syncRows();
    const table = $('video-frame-table');
    if (!table) return;
    if (!rows.length) {
      table.innerHTML = '<div class="video-empty-line">当前时间点还没有 AU 或日志</div>';
      return;
    }
    table.innerHTML = `
      <table class="frame-table video-sync-table">
        <thead><tr><th>时间</th><th>类型</th><th>AU1</th><th>AU4</th><th>AU7</th><th>AU12</th><th>Face</th><th>Reliable</th><th>信息</th><th>详情</th></tr></thead>
        <tbody>${rows.map(renderSyncRow).join('')}</tbody>
      </table>
    `;
    table.scrollTop = table.scrollHeight;
  }

  function renderSyncRow(row) {
    const expanded = expandedSyncKeys.has(row.key);
    const detailJson = escHtml(JSON.stringify(row.detail, null, 2));
    const jsonLink = String(row.key).startsWith('event-') && row.detail?.id !== undefined
      ? `<a class="debug-json-link" href="/api/admin/debug-event/${encodeURIComponent(row.detail.id)}/json?part=event" target="_blank" rel="noopener noreferrer">完整日志事件</a>`
      : '';
    return `
      <tr class="${Math.abs(row.t - currentTime) <= 1 ? 'synced' : ''}">
        <td>${formatSeconds(row.t)}</td>
        <td>${escHtml(row.type)}</td>
        <td>${escHtml(row.au1)}</td>
        <td>${escHtml(row.au4)}</td>
        <td>${escHtml(row.au7)}</td>
        <td>${escHtml(row.au12)}</td>
        <td>${escHtml(row.face)}</td>
        <td>${escHtml(row.reliable)}</td>
        <td>${escHtml(row.message)}</td>
        <td><button class="debug-expand" data-action="video-sync-detail" data-sync-key="${escAttr(row.key)}">${expanded ? '收起' : '展开'}</button></td>
      </tr>
      ${expanded ? `<tr class="debug-detail-row video-sync-detail-row"><td colspan="10"><div class="debug-detail-body"><pre>${detailJson}</pre>${jsonLink}</div></td></tr>` : ''}
    `;
  }

  function updateSyncTime() {
    const el = $('video-sync-time');
    if (el) el.textContent = `视频 ${formatSeconds(currentTime)}`;
  }

  function toggleSyncDetail(key) {
    if (!key) return;
    if (expandedSyncKeys.has(key)) expandedSyncKeys.delete(key);
    else expandedSyncKeys.add(key);
    updateSyncRows();
  }

  function confirmDeleteVideo(sid) {
    const overlay = $('modal-overlay');
    const modal = overlay?.querySelector('.modal');
    if (!overlay || !modal) return;
    overlay.classList.remove('hidden');
    modal.innerHTML = `
      <h3>删除实验视频</h3>
      <p>确定删除 Session #${sid} 的视频吗？这会删除所有已上传的视频分段和合并后的视频文件，但不会删除会话数据。</p>
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
    lastVideoSize = -1;
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
      toggleSyncDetail(el.dataset.syncKey);
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
