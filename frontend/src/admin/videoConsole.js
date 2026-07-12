import { $, escapeAttr as escAttr, escapeHtml as escHtml } from '../shared/dom.js';

const VIDEO_POLL_MS = 2500;

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

function frameReliable(frame) {
  return !!(frame?.ok ?? frame?.reliable);
}

function frameFace(frame) {
  return !!(frame?.face ?? frame?.face_detected);
}

function payloadText(payload = {}) {
  return payload.message || payload.text || payload.filename || payload.value || '';
}

function shortJson(value) {
  return JSON.stringify(value, null, 2);
}

function eventLabel(type) {
  const labels = {
    session_started: 'Session 开始',
    pre_survey_submitted: '实验前问卷提交',
    pre_survey_finished: '实验前问卷完成',
    baseline_started: '基准测试开始',
    baseline_completed: '基准测试完成',
    task_started: '实验开始',
    task_completed: '实验完成',
    questionnaire_submitted: '任务后问卷提交',
    post_survey_submitted: '实验后问卷提交',
    video_final_uploaded: '视频上传完成',
    chat_user: '用户消息',
    chat_ai: 'AI 回复',
  };
  return labels[type] || type || '日志';
}

function stageLabel(exp, timeline) {
  const session = exp?.session || {};
  const events = timeline?.events || [];
  if (events.some((event) => event.type === 'post_survey_submitted')) return '实验后问卷';
  if (events.some((event) => event.type === 'task_started' || event.type === 'chat_user' || event.type === 'chat_ai')) {
    return session.completed ? '实验后问卷' : '实验中';
  }
  if (events.some((event) => event.type === 'baseline_started' || event.type === 'baseline_completed')) return '基准测试';
  return '实验前问卷';
}

function preserveScroll(id, renderFn) {
  const el = $(id);
  const top = el?.scrollTop || 0;
  renderFn();
  const next = $(id);
  if (next) next.scrollTop = top;
}

export function createVideoConsole({ adminFetch, toast, getSessionCache, isActive = () => true }) {
  let pollTimer = null;
  let activeSid = null;
  let loading = false;
  let videoInfo = null;
  let latestExp = null;
  let latestSt = null;
  let latestTimeline = null;
  let viewToken = 0;
  const expandedKeys = new Set();

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
        <section class="video-panel video-overview-panel">
          <div class="video-panel-title">
            <h3>视频索引</h3>
          </div>
          <div id="video-overview" class="video-overview-grid"></div>
        </section>

        <section class="video-panel video-meta-panel">
          <div class="video-panel-title">
            <h3>杂项</h3>
          </div>
          <div id="video-meta" class="video-meta-grid"></div>
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
      expandedKeys.clear();
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
    updateMeta();
    preserveScroll('video-chat-list', updateChat);
    preserveScroll('video-frame-table', updateLogRows);
  }

  function updateOverview() {
    const session = latestExp?.session || {};
    const participant = videoInfo?.participant_id || session.participant_id || '-';
    const size = videoInfo?.size_human || '0 B';
    const duration = videoInfo?.duration_human || '-';
    const download = videoInfo?.available
      ? `<a class="video-link-button primary" href="${escAttr(videoInfo.download_url)}">下载视频</a>`
      : '<button disabled>下载视频</button>';
    const overview = $('video-overview');
    if (!overview) return;
    overview.innerHTML = `
      <div class="video-info-card"><span>实验者编号</span><strong>${escHtml(participant)}</strong></div>
      <div class="video-info-card"><span>视频大小</span><strong>${escHtml(size)}</strong></div>
      <div class="video-info-card"><span>视频时长</span><strong>${escHtml(duration)}</strong></div>
      <div class="video-action-row">
        ${download}
        <button class="danger" data-action="confirm-delete-video" data-session-id="${session.id}">删除视频</button>
      </div>
    `;
  }

  function updateMeta() {
    const session = latestExp?.session || {};
    const markerCount = latestTimeline?.events?.length || 0;
    const meta = $('video-meta');
    if (!meta) return;
    meta.innerHTML = `
      <div class="video-info-card"><span>Session ID</span><strong>#${escHtml(session.id ?? '-')}</strong></div>
      <div class="video-info-card"><span>条件</span><strong>${escHtml(session.condition_label || session.condition || '-')}</strong></div>
      <div class="video-info-card"><span>阶段</span><strong>${escHtml(stageLabel(latestExp, latestTimeline))}</strong></div>
      <div class="video-info-card"><span>完成状态</span><strong>${session.completed ? '已完成' : '未完成'}</strong></div>
      <div class="video-info-card"><span>对话轮次</span><strong>${escHtml(session.total_turns ?? 0)} 轮</strong></div>
      <div class="video-info-card"><span>修改次数</span><strong>${escHtml(session.total_revisions ?? 0)} 次</strong></div>
      <div class="video-info-card"><span>视频分段</span><strong>${escHtml(videoInfo?.chunk_count ?? 0)} 段</strong></div>
      <div class="video-info-card"><span>视频标记</span><strong>${markerCount} 个</strong></div>
    `;
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

  function logRows() {
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
          video_time: formatSeconds(t),
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
      const t = eventTime(event);
      return {
        key: `event-${event.id}`,
        t,
        type: eventLabel(event.type),
        au1: '-',
        au4: '-',
        au7: '-',
        au12: '-',
        face: '-',
        reliable: '-',
        message: payloadText(payload) || eventLabel(event.type),
        detail: { ...event, video_time: formatSeconds(t) },
      };
    });
    return frameRows.concat(markerRows)
      .filter((row) => Number.isFinite(row.t))
      .sort((a, b) => a.t - b.t || String(a.key).localeCompare(String(b.key)));
  }

  function updateLogRows() {
    const rows = logRows();
    const table = $('video-frame-table');
    const count = $('video-log-count');
    if (count) count.textContent = `${rows.length} 条`;
    if (!table) return;
    if (!rows.length) {
      table.innerHTML = '<div class="video-empty-line">暂无日志或 AU 数据</div>';
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

  function renderLogRow(row) {
    const expanded = expandedKeys.has(row.key);
    const detailJson = escHtml(shortJson(row.detail));
    return `
      <tr>
        <td><span class="video-time-pill">视频 ${formatSeconds(row.t)}</span></td>
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

  function toggleDetail(key) {
    if (!key) return;
    if (expandedKeys.has(key)) expandedKeys.delete(key);
    else expandedKeys.add(key);
    preserveScroll('video-frame-table', updateLogRows);
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
