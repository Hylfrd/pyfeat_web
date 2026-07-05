import { $, escapeAttr as escAttr, escapeHtml as escHtml } from '../shared/dom.js';

function frameReliable(frame){
  return !!(frame?.ok ?? frame?.reliable);
}

function frameFace(frame){
  return !!(frame?.face ?? frame?.face_detected);
}

function writeDetail(html){
  const detail=$('detail');
  if(detail)detail.innerHTML=html;
}

export function renderOverview(exp,st){
  const s=exp.session;
  const p=exp.participant||{};
  const q=exp.questionnaire;
  const evals=exp.evaluations||[];
  const dur=s.duration_ms?Math.floor(s.duration_ms/1000):0;
  const durStr=dur?`${Math.floor(dur/60)}分${dur%60}秒`:'-';
  const framesOk=(st.total_frames||0)-(st.face_lost_frames||0);
  const faceOkPct=st.total_frames?Math.round(framesOk/st.total_frames*100):0;

  let html=`
    <div class="detail-section">
      <div class="section-heading">
        <h3>会话信息</h3>
        <div class="action-bar compact">
          <button data-action="export-session" data-session-id="${s.id}">⬇ 导出 JSON</button>
          <button data-action="export-session-csv" data-session-id="${s.id}">⬇ 导出 CSV</button>
          <button class="danger" data-action="confirm-delete" data-session-id="${s.id}" data-participant-id="${escAttr(s.participant_id)}">✕ 删除此 Session</button>
        </div>
      </div>
      <div class="info-grid">
        <div class="info-card"><div class="lbl">Session ID</div><div class="val mono">#${s.id}</div></div>
        <div class="info-card"><div class="lbl">参与者</div><div class="val mono">${escHtml(s.participant_id)}</div></div>
        <div class="info-card"><div class="lbl">条件</div><div class="val">${s.condition==='affect-aware'?'情感感知 AI':'纯文本 AI'}</div></div>
        <div class="info-card"><div class="lbl">场景</div><div class="val">${s.task_scenario==='A'?'场景 A (电脑崩溃)':'场景 B (组员失联)'}</div></div>
        <div class="info-card"><div class="lbl">任务流程</div><div class="val">单次写作任务</div></div>
        <div class="info-card"><div class="lbl">完成方式</div><div class="val">${s.completion_type==='timeout'?'超时':'手动提交'}</div></div>
        <div class="info-card"><div class="lbl">用时</div><div class="val">${durStr}</div></div>
        <div class="info-card"><div class="lbl">对话轮次 / 修改</div><div class="val mono">${s.total_turns||0} 轮 · ${s.total_revisions||0} 修改</div></div>
        <div class="info-card"><div class="lbl">表情帧</div><div class="val mono">${st.total_frames||0} 帧 (可靠 ${st.reliable_frames||0})</div></div>
        <div class="info-card"><div class="lbl">帧丢失率</div><div class="val" style="color:${s.frame_loss_ratio>0.3?'#ef4444':'#22c55e'}">${Math.round(s.frame_loss_ratio*100)}%</div></div>
        <div class="info-card"><div class="lbl">排除</div><div class="val" style="color:${s.excluded_by_frame_loss?'#ef4444':'#22c55e'}">${s.excluded_by_frame_loss?'是 (>30%丢失)':'否'}</div></div>
      </div>
    </div>

    <div class="detail-section"><h3>面部检测概况</h3>
      <div class="info-grid">
        <div class="info-card"><div class="lbl">总帧数</div><div class="val mono">${st.total_frames||0}</div></div>
        <div class="info-card"><div class="lbl">检测到面部</div><div class="val" style="color:#22c55e">${framesOk} (${faceOkPct}%)</div></div>
        <div class="info-card"><div class="lbl">面部丢失</div><div class="val" style="color:#ef4444">${st.face_lost_frames||0} (${st.face_lost_pct||0}%)</div></div>
        <div class="info-card"><div class="lbl">均值 AU4 (困惑)</div><div class="val mono">${st.means?.au4||'-'}</div></div>
        <div class="info-card"><div class="lbl">均值 AU12 (正向)</div><div class="val mono">${st.means?.au12||'-'}</div></div>
        <div class="info-card"><div class="lbl">触发帧 (AU4≥2)</div><div class="val mono">${st.triggers_above_2?.au4||0} / ${st.total_frames||0}</div></div>
        <div class="info-card"><div class="lbl">触发帧 (AU12≥2)</div><div class="val mono">${st.triggers_above_2?.au12||0} / ${st.total_frames||0}</div></div>
      </div>
    </div>`;

  // Face detection timeline
  if(st.frames&&st.frames.length){
    html+=`<div class="detail-section"><h3>面部检测时间线 (每点 = 1 帧, ${st.frames.length} 帧)</h3>`;
    html+=`<div class="au-legend">
      <span><span class="swatch" style="background:#22c55e"></span>已检测</span>
      <span><span class="swatch" style="background:#ef4444"></span>丢失</span>
      <span><span class="swatch" style="background:#64748b;opacity:.4"></span>不可靠</span>
    </div>`;
    html+=`<div class="au-strip">`;
    for(const f of st.frames){
      const reliable=frameReliable(f);
      const face=frameFace(f);
      const cls=face&&reliable?'':'lost';
      const color=!face?'#ef4444':(reliable?'#22c55e':'#64748b');
      html+=`<div class="cell ${cls}" style="background:${color}" title="t=${f.t}s AU4:${f.au4} AU12:${f.au12} ${face&&reliable?'✅':'⚠️'}"></div>`;
    }
    html+=`</div></div>`;
  }

  // Questionnaire
  if(q){
    html+=`<div class="detail-section"><h3>问卷结果</h3>
      <div class="info-grid">
        <div class="info-card"><div class="lbl">Q1 理解目标</div><div class="val mono">${q.q1||'-'}</div></div>
        <div class="info-card"><div class="lbl">Q2 同一频道</div><div class="val mono">${q.q2||'-'}</div></div>
        <div class="info-card"><div class="lbl">Q3 了解需求</div><div class="val mono">${q.q3||'-'}</div></div>
        <div class="info-card"><div class="lbl">Q4 连接感</div><div class="val mono">${q.q4||'-'}</div></div>
        <div class="info-card"><div class="lbl">Q5 有收获</div><div class="val mono">${q.q5||'-'}</div></div>
        <div class="info-card"><div class="lbl">Q6 有兴趣</div><div class="val mono">${q.q6||'-'}</div></div>
        <div class="info-card"><div class="lbl">Q7 值得</div><div class="val mono">${q.q7||'-'}</div></div>
        <div class="info-card"><div class="lbl">Q8 沮丧 [R]</div><div class="val mono">${q.q8||'-'}</div></div>
        <div class="info-card"><div class="lbl">Q9 困惑 [R]</div><div class="val mono">${q.q9||'-'}</div></div>
        <div class="info-card"><div class="lbl">Q10 费力 [R]</div><div class="val mono">${q.q10||'-'}</div></div>
      </div>
    </div>`;
  }

  // Final email
  if(s.final_email){
    html+=`<div class="detail-section"><h3>最终草稿</h3>
      <div class="final-email">${escHtml(s.final_email)}</div>
    </div>`;
  }

  // Evaluations
  if(evals.length){
    html+=`<div class="detail-section"><h3>评估结果</h3>`;
    for(const e of evals){
      let detail='';
      try{detail=JSON.stringify(JSON.parse(e.details_json||'{}'),null,2)}catch(_){detail=e.details_json||''}
      html+=`<div class="info-card evaluation-card">
        <div class="lbl">${e.layer} · 模型 ${e.evaluator_model}</div>
        <div class="val mono">${e.score?.toFixed(1)}</div>
        ${detail?`<pre class="evaluation-json">${escHtml(detail)}</pre>`:''}
      </div>`;
    }
    html+=`</div>`;
  }

  writeDetail(html);
}

// ── Chat ──
export function renderChat(exp){
  const logs=exp.chat_logs||[];
  let html=`<div class="detail-section">
    <div class="section-heading">
      <h3>对话记录 (${logs.length} 条)</h3>
      <div class="action-bar compact">
        <button data-action="export-session" data-session-id="${exp.session.id}">⬇ 导出 JSON</button>
      </div>
    </div>
  </div>`;

  for(const l of logs){
    const isUser=l.role==='user';
    html+=`<div class="chat-entry ${isUser?'user':'ai'}">
      <div class="ch-meta">
        <span>${isUser?'👤 用户':'🤖 AI'} · #${l.seq}</span>
        <span>${l.timestamp||''}</span>
        ${l.expression_label?`<span class="tag expr">面部: ${l.expression_label}</span>`:''}
        ${l.strategy_applied?`<span class="tag strat">策略: ${l.strategy_applied}</span>`:''}
      </div>
      <div class="ch-content">${escHtml(l.content)}</div>
    </div>`;
  }
  if(!logs.length)html+='<div class="loading">暂无对话记录</div>';
  writeDetail(html);
}

// ── Expression ──
export function renderExpression(exp,st){
  const frames=st.frames||[];
  let html=`<div class="expression-head">
    <h3>表情 AU 数据 (${frames.length} 帧)</h3>
    <button data-action="export-expression-csv" data-session-id="${exp.session.id}">⬇ 导出 AU 数据 CSV</button>
  </div>`;

  // AU timeline strip
  html+=`<div class="au-legend">
    <span><span class="swatch au4"></span>AU4≥2 (困惑/沮丧)</span>
    <span><span class="swatch au12"></span>AU12≥2 (正向)</span>
    <span><span class="swatch au7"></span>AU7≥2</span>
    <span><span class="swatch au1"></span>AU1≥1.5</span>
    <span><span class="swatch neutral"></span>中性有效帧</span>
    <span><span class="swatch lost"></span>不可靠/丢失</span>
  </div>`;
  html+=`<div class="au-strip">`;
  for(const f of frames){
    const reliable=frameReliable(f);
    const face=frameFace(f);
    let tone='neutral';
    if(!face)tone='lost';
    else if(!reliable)tone='unreliable';
    else if(f.au4>=2)tone='au4';
    else if(f.au12>=2)tone='au12';
    else if(f.au7>=2)tone='au7';
    else if(f.au1>=1.5)tone='au1';
    html+=`<div class="cell ${tone}"
      title="t=${f.t}s AU1:${f.au1} AU4:${f.au4} AU7:${f.au7} AU12:${f.au12} ${face&&reliable?'有效':'不可靠'}"></div>`;
  }
  html+=`</div>`;

  // AU table (first 200 rows for performance)
  const show=frames.slice(0,200);
  html+=`<div class="detail-section"><h3>帧数据表 (显示前 ${show.length} 帧, 共 ${frames.length})</h3>
    <div class="frame-table-wrap">
    <table class="frame-table">
      <thead><tr><th>时间(s)</th><th>AU1</th><th>AU4</th><th>AU7</th><th>AU12</th><th>Yaw°</th><th>Pitch°</th><th>面部</th><th>可靠</th></tr></thead>
      <tbody>`;
  for(const f of show){
    const reliable=frameReliable(f);
    const face=frameFace(f);
    const au4ok=f.au4>=2;
    const au12ok=f.au12>=2;
    const clsRow=face&&reliable?'':'lost';
    html+=`<tr class="${clsRow}">
      <td>${f.t}</td>
      <td class="${f.au1>=1.5?'trigger':''}">${f.au1}</td>
      <td class="${au4ok?'trigger':''}">${f.au4}</td>
      <td class="${f.au7>=2?'trigger':''}">${f.au7}</td>
      <td class="${au12ok?'trigger':''}">${f.au12}</td>
      <td>${f.yaw}</td><td>${f.pitch}</td>
      <td>${face?'✅':'❌'}</td><td>${reliable?'✅':'⚠️'}</td>
    </tr>`;
  }
  html+=`</tbody></table></div></div>`;

  writeDetail(html);
}

// ── Baseline ──
export function renderBaseline(exp){
  const p=exp.participant;
  let html=`<div class="detail-section"><h3>参与者基线数据</h3>`;
  if(!p){
    html+='<div class="loading">无基线数据</div>';
  }else{
    html+=`
    <div class="info-grid">
      <div class="info-card"><div class="lbl">参与者 ID</div><div class="val mono">${escHtml(p.id)}</div></div>
      <div class="info-card"><div class="lbl">顺序组</div><div class="val mono">${p.order_group}</div></div>
      <div class="info-card"><div class="lbl">基线 AU1</div><div class="val mono">${p.baseline_au1?.toFixed(3)||'-'}</div></div>
      <div class="info-card"><div class="lbl">基线 AU4</div><div class="val mono">${p.baseline_au4?.toFixed(3)||'-'}</div></div>
      <div class="info-card"><div class="lbl">基线 AU7</div><div class="val mono">${p.baseline_au7?.toFixed(3)||'-'}</div></div>
      <div class="info-card"><div class="lbl">基线 AU12</div><div class="val mono">${p.baseline_au12?.toFixed(3)||'-'}</div></div>
      <div class="info-card"><div class="lbl">基线帧数</div><div class="val mono">${p.baseline_frame_count||0}</div></div>
    </div>
    <div class="baseline-vector">
      <p>基线 AU 向量 (用于偏差计算)</p>
      <div class="baseline-vector-row">
        <div><span class="au-name au1">AU1</span> <strong>${p.baseline_au1?.toFixed(3)||'-'}</strong></div>
        <div><span class="au-name au4">AU4</span> <strong>${p.baseline_au4?.toFixed(3)||'-'}</strong></div>
        <div><span class="au-name au7">AU7</span> <strong>${p.baseline_au7?.toFixed(3)||'-'}</strong></div>
        <div><span class="au-name au12">AU12</span> <strong>${p.baseline_au12?.toFixed(3)||'-'}</strong></div>
      </div>
    </div>`;
  }
  // Also show the session's expression stats summary
  writeDetail(html);
}

// ── Export ──
