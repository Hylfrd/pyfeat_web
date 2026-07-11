import { $, escapeAttr as escAttr, escapeHtml as escHtml } from '../shared/dom.js';

const VIDEO_POLL_MS = 1500;
const SYNC_WINDOW = 180;

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function eventTime(event) {
  return Number(event?.time_s ?? 0);
}

function frameTime(frame) {
  return Number(frame?.video_t ?? frame?.t ?? 0);
}

function frameReliable(frame) {
  return !!(frame?.ok ?? frame?.reliable);
}

function frameFace(frame) {
  return !!(frame?.face ?? frame?.face_detected);
}

function firstEvent(events, types) {
  const wanted = new Set(types);
  const row = (events || []).find((event) => wanted.has(event.type) && Number.isFinite(eventTime(event)));
  return row ? eventTime(row) : null;
}

function stageAt(currentTime, timeline) {
  const t = Number(currentTime) || 0;
  if (Number.isFinite(timeline.postStart) && t >= timeline.postStart) return '实验后问卷';
  if (Number.isFinite(timeline.taskStart) && t >= timeline.taskStart) return '实验中';
  if (Number.isFinite(timeline.baselineStart) && t >= timeline.baselineStart) return '基准测试';
  return '实验前问卷';
}

function buildStageTimeline(timeline) {
  const events = timeline?.events || [];
  return {
    baselineStart: firstEvent(events, ['baseline_started', 'pre_survey_finished', 'pre_survey_submitted']),
    taskStart: firstEvent(events, ['task_started']),
    postStart: firstEvent(events, ['task_completed']),
  };
}

function payloadText(payload = {}) {
  return payload.message || payload.text || payload.filename || '';
}

export function createVideoConsole({ adminFetch, toast, getSessionCache, isActive = () => true }) {
  let pollTimer = null;
  let activeSid = null;
  let loading = false;
  let player = null;
  let videoInfo = null;
  let latestExp = null;
  let latestSt = null;
  let latestTimeline = null;
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
    video?.addEventListener('loadedmetadata', () => {
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
      latestTimeline = null;
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
      const [infoR, exportR, statsR, timelineR] = await Promise.all([
        adminFetch(`/api/admin/sessions/${sid}/video/info`),
        adminFetch(`/api/admin/sessions/${sid}/export`),
        adminFetch(`/api/admin/expression/${sid}/stats`),
        adminFetch(`/api/admin/sessions/${sid}/timeline`),
      ]);
      const [info, exp, st, timeline] = await Promise.all([
        infoR.json(),
        exportR.json(),
        statsR.json(),
        timelineR.json(),
      ]);
      if (token !== viewToken || sid !== activeSid || !isActive()) return;
      videoInfo = info;
      latestExp = exp;
      latestSt = st;
      latestTimeline = timeline;
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
    const stageTimeline = buildStageTimeline(latestTimeline);
    const participant = videoInfo?.participant_id || session.participant_id || '-';
    const size = videoInfo?.size_human || '0 B';
    const chunks = Number(videoInfo?.chunk_count || 0);
    const stage = stageAt(currentTime, stageTimeline);
    const markerCount = latestTimeline?.events?.length || 0;
    const download = videoInfo?.available
      ? `<a class="video-link-button primary" href="${escAttr(videoInfo.download_url)}">下载视频</a>`
      : '<button disabled>下载视频</button>';
    const html = `
      <div class="video-info-card"><span>实验者编号</span><strong>${escHtml(participant)}</strong></div>
      <div class="video-info-card"><span>播放位置</span><strong>${formatSeconds(currentTime)}</strong></div>
      <div class="video-info-card"><span>当前阶段</span><strong>${escHtml(stage)}</strong></div>
      <div class="video-info-card"><span>视频大小</span><strong>${escHtml(size)}</strong></div>
      <div class="video-info-card"><span>视频分段</span><strong>${chunks} 段</strong></div>
      <div class="video-info-card"><span>时间标记</span><strong>${markerCount} 个</strong></div>
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
      if (previousTime > 0 && Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = Math.min(previousTime, Math.max(0, video.duration - 0.25));
      }
      if (!wasPaused) video.play().catch(() => {});
    }, { once: true });
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
      .filter((item) => Number.isFinite(item.t));
  }

  function updateChat() {
    const all = chatEvents();
    const visible = all.filter((item) => item.t <= currentTime).slice(-20);
    const list = $('video-chat-list');
    const count = $('video-chat-count');
    if (count) count.textContent = `${visible.length} / ${all.length} 条`;
    if (!list) return;
    if (!visible.length) {
      list.innerHTML = '<div class="video-empty-line">当前时间点还没有 AI 对话</div>';
      return;
    }
    list.innerHTML = visible.map(({ event, t, isAi, payload }) => `
      <article class="video-chat-item ${isAi ? 'ai' : 'user'} ${Math.abs(t - currentTime) <= 2 ? 'synced' : ''}">
        <div class="video-chat-meta">
          <span>${isAi ? 'AI' : '用户'} #${escHtml(payload.seq ?? event.id)}</span>
          <span>${formatSeconds(t)}</span>
          ${payload.strategy ? `<span class="tag strat">${escHtml(payload.strategy)}</span>` : ''}
          ${payload.expression_label ? `<span class="tag expr">${escHtml(payload.expression_label)}</span>` : ''}
        </div>
        <div class="video-chat-content">${escHtml(payload.text || '')}</div>
      </article>
    `).join('');
    list.scrollTop = list.scrollHeight;
  }

  function syncRows() {
    const frameRows = (latestSt?.frames || []).map((frame, index) => {
      const t = frameTime(frame);
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
    const markerRows = (latestTimeline?.events || []).map((event) => {
      const payload = event.payload || {};
      return {
        key: `event-${event.id}`,
        t: eventTime(event),
        type: event.type || 'marker',
        au1: '-',
        au4: '-',
        au7: '-',
        au12: '-',
        face: '-',
        reliable: '-',
        message: payloadText(payload) || event.type || '',
        detail: event,
      };
    });
    return frameRows.concat(markerRows)
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
      ${expanded ? `<tr class="debug-detail-row video-sync-detail-row"><td colspan="10"><div class="debug-detail-body"><pre>${detailJson}</pre></div></td></tr>` : ''}
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
