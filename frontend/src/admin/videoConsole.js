import { $, escapeAttr as escAttr, escapeHtml as escHtml } from '../shared/dom.js';

const VIDEO_POLL_MS = 1500;
const FRAME_WINDOW = 180;

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function safeDateMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function chatTime(log, session) {
  const start = safeDateMs(session?.start_time);
  const at = safeDateMs(log?.timestamp);
  if (start === null || at === null) return null;
  return Math.max(0, (at - start) / 1000);
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

function currentFrameWindow(frames, currentTime) {
  if (!frames.length) return [];
  if (!Number.isFinite(currentTime) || currentTime <= 0) {
    return frames.slice(-FRAME_WINDOW);
  }
  const nearest = frames.findIndex((frame) => frameVideoTime(frame) >= currentTime);
  const center = nearest >= 0 ? nearest : frames.length - 1;
  const start = Math.max(0, center - Math.floor(FRAME_WINDOW / 2));
  return frames.slice(start, start + FRAME_WINDOW);
}

export function createVideoConsole({ adminFetch, toast, getSessionCache }) {
  let pollTimer = null;
  let activeSid = null;
  let loading = false;
  let player = null;
  let videoInfo = null;
  let lastVideoSize = -1;
  let currentTime = 0;

  function stopTimers() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function destroyPlayer() {
    if (player && typeof player.destroy === 'function') {
      try { player.destroy(); } catch (e) {}
    }
    player = null;
    lastVideoSize = -1;
  }

  function ensureShell(sid) {
    const detail = $('detail');
    if (!detail) return;
    if (detail.dataset.videoSid === String(sid) && $('session-video-player')) return;
    destroyPlayer();
    detail.dataset.videoSid = String(sid);
    detail.innerHTML = `
      <div class="video-console">
        <section class="video-panel video-overview-panel">
          <div class="video-panel-title">
            <h3>视频概览</h3>
            <span id="video-live-pill" class="video-live-pill">实时同步</span>
          </div>
          <div id="video-overview" class="video-overview-grid"></div>
        </section>

        <section class="video-panel video-chat-panel">
          <div class="video-panel-title">
            <h3>AI 对话</h3>
            <span id="video-chat-count" class="muted">0 条</span>
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
      updateSyncTime();
      highlightSyncedRows();
      updateFramesFromCache();
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
      currentTime = 0;
    }
    activeSid = sid;
    ensureShell(sid);
    updateOverview(exp, videoInfo);
    updateChat(exp);
    updateFrames(st || {});
    refresh({ silent: true });
    if (!pollTimer) pollTimer = setInterval(() => refresh({ silent: true }), VIDEO_POLL_MS);
  }

  async function refresh({ silent = false } = {}) {
    if (!activeSid || loading) return;
    loading = true;
    try {
      const [infoR, exportR, statsR] = await Promise.all([
        adminFetch(`/api/admin/sessions/${activeSid}/video/info`),
        adminFetch(`/api/admin/sessions/${activeSid}/export`),
        adminFetch(`/api/admin/expression/${activeSid}/stats`),
      ]);
      const [info, exp, st] = await Promise.all([infoR.json(), exportR.json(), statsR.json()]);
      videoInfo = info;
      getSessionCache()[activeSid] = { exp, st };
      ensureShell(activeSid);
      updateOverview(exp, info);
      updatePlayer(info);
      updateChat(exp);
      updateFrames(st);
    } catch (err) {
      if (!silent) toast('视频数据刷新失败', 'err');
    } finally {
      loading = false;
    }
  }

  function updateOverview(exp, info = {}) {
    const session = exp?.session || {};
    const participant = info?.participant_id || session.participant_id || '-';
    const stage = info?.stage || '-';
    const size = info?.size_human || '0 B';
    const chunks = Number(info?.chunk_count || 0);
    const available = !!info?.available;
    const status = available ? '可播放' : (chunks ? '合并中' : '暂无视频');
    const download = available
      ? `<a class="video-link-button" href="${escAttr(info.download_url)}">下载视频</a>`
      : '<button disabled>下载视频</button>';
    const html = `
      <div class="video-info-card"><span>实验者编号</span><strong>${escHtml(participant)}</strong></div>
      <div class="video-info-card"><span>当前阶段</span><strong>${escHtml(stage)}</strong></div>
      <div class="video-info-card"><span>视频状态</span><strong>${escHtml(status)}</strong></div>
      <div class="video-info-card"><span>视频大小</span><strong>${escHtml(size)}</strong></div>
      <div class="video-info-card"><span>视频分段</span><strong>${chunks} 段</strong></div>
      <div class="video-info-card video-action-card">
        ${download}
        <button class="danger" data-action="confirm-delete-video" data-session-id="${session.id}">删除视频</button>
      </div>
    `;
    const overview = $('video-overview');
    if (overview) overview.innerHTML = html;
    const pill = $('video-live-pill');
    if (pill) pill.textContent = available ? '实时同步' : '等待视频';
  }

  function updatePlayer(info = {}) {
    const video = $('session-video-player');
    const empty = $('video-empty');
    if (!video || !empty) return;
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

  function updateChat(exp) {
    const logs = (exp?.chat_logs || []).filter((log) => !log.is_hidden);
    const list = $('video-chat-list');
    const count = $('video-chat-count');
    if (count) count.textContent = `${logs.length} 条`;
    if (!list) return;
    if (!logs.length) {
      list.innerHTML = '<div class="video-empty-line">暂无对话</div>';
      return;
    }
    list.innerHTML = logs.map((log) => {
      const isAi = log.role === 'ai';
      const t = chatTime(log, exp.session);
      return `
        <article class="video-chat-item ${isAi ? 'ai' : 'user'}" data-video-time="${t ?? ''}">
          <div class="video-chat-meta">
            <span>${isAi ? 'AI' : '用户'} #${log.seq}</span>
            <span>${t === null ? escHtml(log.timestamp || '') : formatSeconds(t)}</span>
            ${log.strategy_applied ? `<span class="tag strat">${escHtml(log.strategy_applied)}</span>` : ''}
            ${log.expression_label ? `<span class="tag expr">${escHtml(log.expression_label)}</span>` : ''}
          </div>
          <div class="video-chat-content">${escHtml(log.content || '')}</div>
        </article>
      `;
    }).join('');
    highlightSyncedRows();
  }

  function updateFramesFromCache() {
    const cached = getSessionCache()[activeSid];
    if (cached?.st) updateFrames(cached.st);
  }

  function updateFrames(st = {}) {
    const frames = st.frames || [];
    const table = $('video-frame-table');
    if (!table) return;
    if (!frames.length) {
      table.innerHTML = '<div class="video-empty-line">暂无表情帧</div>';
      return;
    }
    const show = currentFrameWindow(frames, currentTime);
    table.innerHTML = `
      <table class="frame-table video-sync-table">
        <thead><tr><th>时间</th><th>AU1</th><th>AU4</th><th>AU7</th><th>AU12</th><th>Face</th><th>Reliable</th><th>详情</th></tr></thead>
        <tbody>
          ${show.map((frame) => renderFrameRow(frame)).join('')}
        </tbody>
      </table>
    `;
    updateSyncTime();
    highlightSyncedRows();
  }

  function renderFrameRow(frame) {
    const face = frameFace(frame);
    const reliable = frameReliable(frame);
    const t = frameVideoTime(frame);
    const detail = {
      time_s: t,
      au1: frame.au1,
      au4: frame.au4,
      au7: frame.au7,
      au12: frame.au12,
      yaw: frame.yaw,
      pitch: frame.pitch,
      queued_ms: frame.queued_ms || 0,
      drop_reason: frame.drop_reason || '',
      face,
      reliable,
    };
    return `
      <tr data-video-time="${t || 0}" class="${face && reliable ? '' : 'lost'}">
        <td>${formatSeconds(t)}</td>
        <td class="${frame.au1 >= 0.3 ? 'trigger' : ''}">${frame.au1}</td>
        <td class="${frame.au4 >= 0.4 ? 'trigger' : ''}">${frame.au4}</td>
        <td class="${frame.au7 >= 0.4 ? 'trigger' : ''}">${frame.au7}</td>
        <td class="${frame.au12 >= 0.4 ? 'trigger' : ''}">${frame.au12}</td>
        <td>${face ? 'yes' : 'no'}</td>
        <td>${reliable ? 'yes' : 'no'}</td>
        <td>
          <details class="video-frame-detail">
            <summary>展开</summary>
            <pre>${escHtml(JSON.stringify(detail, null, 2))}</pre>
          </details>
        </td>
      </tr>
    `;
  }

  function updateSyncTime() {
    const el = $('video-sync-time');
    if (el) el.textContent = `视频 ${formatSeconds(currentTime)}`;
  }

  function highlightSyncedRows() {
    document.querySelectorAll('[data-video-time]').forEach((row) => {
      const t = Number(row.dataset.videoTime);
      row.classList.toggle('synced', Number.isFinite(t) && Math.abs(t - currentTime) <= 1);
    });
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
    return false;
  }

  return {
    render,
    refresh,
    stopTimers,
    handleAction,
  };
}
