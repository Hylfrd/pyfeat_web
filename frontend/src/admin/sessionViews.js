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

const STRATEGY_TRIGGERS = [
  ['_au4_present', 'AU4 当轮出现'],
  ['_au4_rising', 'AU4 近期上升'],
  ['_input_shrinking', '连续输入缩短'],
  ['_sustained_present', 'AU4 连续三轮出现'],
  ['_idle_with_au1', '空闲伴随 AU1'],
  ['_au4_slope', 'AU4 上升斜率'],
  ['_au4_dropping', 'AU4 回落'],
];
const STRATEGY_UNMATCHED_FILTER='__unmatched__';
const strategyFilterState=new Map();
const strategyExpandedState=new Map();

function defaultStrategyFilters(){
  return new Set([...STRATEGY_TRIGGERS.map(([key])=>key),STRATEGY_UNMATCHED_FILTER]);
}

function strategyFrameMatches(frame,selected){
  const activeKeys=STRATEGY_TRIGGERS.filter(([key])=>frame.triggers?.[key]).map(([key])=>key);
  if(activeKeys.some(key=>selected.has(key)))return true;
  return activeKeys.length===0&&selected.has(STRATEGY_UNMATCHED_FILTER);
}

export function renderOverview(exp,st){
  const s=exp.session;
  const p=exp.participant||{};
  const evals=exp.evaluations||[];
  const dur=s.duration_ms?Math.floor(s.duration_ms/1000):0;
  const durStr=dur?`${Math.floor(dur/60)}分${dur%60}秒`:'-';
  const framesOk=(st.total_frames||0)-(st.face_lost_frames||0);
  const faceOkPct=st.total_frames?Math.round(framesOk/st.total_frames*100):0;
  const exclusionButton = s.excluded
    ? `<button class="success" data-action="set-exclusion" data-session-id="${s.id}" data-excluded="0">不再排除此Session</button>`
    : `<button class="danger" data-action="set-exclusion" data-session-id="${s.id}" data-excluded="1">排除此Session</button>`;
  const exclusionText = s.exclusion_override === 'exclude'
    ? '手动排除'
    : (s.exclusion_override === 'include' ? '否 (手动保留)' : (s.excluded_by_frame_loss ? '是 (>30%丢失)' : '否'));
  const exclusionColor = s.excluded ? '#ef4444' : '#22c55e';
  const consentText = s.consent_agreed ? '已同意' : '未记录';
  const consentColor = s.consent_agreed ? '#22c55e' : '#ef4444';
  const signatureButton = s.consent_signature
    ? `<button data-action="view-consent-signature" data-session-id="${s.id}">查看签名</button>`
    : '<span class="muted">无签名</span>';

  let html=`
    <div class="detail-section">
      <div class="section-heading">
        <h3>会话信息</h3>
        <div class="action-bar compact">
          <button data-action="export-session" data-session-id="${s.id}">⬇ 导出 JSON</button>
          <button data-action="export-session-csv" data-session-id="${s.id}">⬇ 导出 CSV</button>
          ${exclusionButton}
          <button class="danger" data-action="confirm-delete" data-session-id="${s.id}" data-participant-id="${escAttr(s.participant_id)}">✕ 删除此 Session</button>
        </div>
      </div>
      <div class="info-grid">
        <div class="info-card"><div class="lbl">Session ID</div><div class="val mono">#${s.id}</div></div>
        <div class="info-card"><div class="lbl">参与者</div><div class="val mono">${escHtml(s.participant_id)}</div></div>
        <div class="info-card"><div class="lbl">条件</div><div class="val">${s.condition==='affect-aware'?'情感感知 AI':'纯文本 AI'}</div></div>
        <div class="info-card"><div class="lbl">用时</div><div class="val">${durStr}</div></div>
        <div class="info-card"><div class="lbl">对话轮次 / 修改</div><div class="val mono">${s.total_turns||0} 轮 · ${s.total_revisions||0} 修改</div></div>
        <div class="info-card"><div class="lbl">排除</div><div class="val" style="color:${exclusionColor}">${exclusionText}</div></div>
      </div>
    </div>

    <div class="detail-section"><h3>实验者信息</h3>
      <div class="info-grid">
        <div class="info-card"><div class="lbl">知情同意</div><div class="val" style="color:${consentColor}">${consentText}</div></div>
        <div class="info-card"><div class="lbl">获取同意者姓名</div><div class="val">${escHtml(s.consent_taker_name||'-')}</div></div>
        <div class="info-card"><div class="lbl">同意日期</div><div class="val mono">${escHtml(s.consent_date||'-')}</div></div>
        <div class="info-card"><div class="lbl">实验者签名</div><div class="val">${signatureButton}</div></div>
      </div>
    </div>

    <div class="detail-section"><h3>面部检测概况</h3>
      <div class="info-grid">
        <div class="info-card"><div class="lbl">总帧数</div><div class="val mono">${st.total_frames||0}</div></div>
        <div class="info-card"><div class="lbl">可靠帧</div><div class="val" style="color:${(st.reliable_pct||0)<70?'#ef4444':'#22c55e'}">${st.reliable_frames||0} (${st.reliable_pct||0}%)</div></div>
        <div class="info-card"><div class="lbl">检测到面部</div><div class="val" style="color:#22c55e">${framesOk} (${faceOkPct}%)</div></div>
        <div class="info-card"><div class="lbl">面部丢失</div><div class="val" style="color:#ef4444">${st.face_lost_frames||0} (${st.face_lost_pct||0}%)</div></div>
        <div class="info-card"><div class="lbl">队列丢弃</div><div class="val" style="color:#b45309">${st.queue_timeout_frames||0} (${st.queue_timeout_pct||0}%)</div></div>
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
      <span><span class="swatch face-ok"></span>已检测</span>
      <span><span class="swatch face-lost"></span>丢失</span>
      <span><span class="swatch face-unreliable"></span>不可靠</span>
    </div>`;
    html+=`<div class="au-strip">`;
    for(const f of st.frames){
      const reliable=frameReliable(f);
      const face=frameFace(f);
      const cls=!face?'face-lost':(reliable?'face-ok':'face-unreliable');
      const reason=f.drop_reason?` reason:${f.drop_reason}`:'';
      html+=`<div class="cell ${cls}" title="t=${f.t}s AU4:${f.au4} AU12:${f.au12} queued:${f.queued_ms||0}ms${reason} ${face&&reliable?'✅':'⚠️'}"></div>`;
    }
    html+=`</div></div>`;
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

const PRE_SURVEY_ITEMS = [
  ['a1_age','1. 年龄'],
  ['a2_gender','2. 性别'],
  ['a3_ai_frequency','3. 你使用 ChatGPT 或类似 AI 工具的频率是？'],
  ['a4_ai_experience','4. 我有使用 AI 工具进行写作或修改文本的经验。'],
  ['a6_ai_tool_confidence','5. 我有信心使用 AI 工具来辅助写作任务。'],
  ['a7_email_familiarity','6. 我熟悉如何给教授或授课教师写邮件。'],
  ['b1_calm','7. 我现在感到平静。'],
  ['b2_stressed','8. 我现在感到精神压力较大。'],
  ['b3_uncertain','9. 我对即将开始的写作任务感到不确定。'],
  ['b4_confident','10. 我有信心成功完成这项写作任务。'],
  ['b5_ready','11. 我已经做好开始任务的心理准备。'],
  ['b6_webcam_comfort','12. 我能接受在本研究过程中开启摄像头。'],
  ['c1_expect_helpful','13. 我预计 AI 系统能有效帮助我完成写作任务。'],
  ['c2_expect_understand','14. 我预计 AI 系统能理解我的写作需求。'],
  ['c3_expect_easy','15. 我预计 AI 系统能让写作过程变得更轻松。'],
  ['c4_expect_collaborative','16. 我预计与 AI 的互动会有协作感。'],
];

const POST_SURVEY_ITEMS = [
  ['q1','1. AI 理解了我试图达成的目标。'],['q2','2. AI 和我在同一频道上。'],['q3','3. AI 知道我在交互中需要什么。'],['q4','4. AI 与我建立了连接感。'],
  ['q5','5. 这次体验让我感到有收获。'],['q6','6. 我对这次体验感到有兴趣。'],['q7','7. 这次体验是值得的。'],
  ['q8','8. 使用这个助手让我感到沮丧。'],['q9','9. 我觉得这个助手让人困惑。'],['q10','10. 使用这个助手让我感到脑力消耗很大。'],
  ['u1','11. AI 系统似乎理解我在写作任务中的需求。'],['u2','12. AI 似乎意识到了我在写作过程中的困难、犹豫或困惑。'],['u3','13. AI 的回应方式符合我的写作意图。'],['u4','14. 当我卡住或需要其他帮助时，AI 注意到了这一点。'],['u5','15. AI 的回复与我当时的想法和意图保持一致。'],
  ['s1','16. 在写作过程中，我感到受到了 AI 的支持。'],['s2','17. 当我不确定如何继续时，AI 提供了有用的指导。'],['s3','18. AI 帮助我减少了修改邮件所需的精力。'],['s4','19. AI 提供了具体建议，帮助改进了我的草稿。'],['s5','20. AI 帮助我高效完成了写作任务。'],
  ['sp1','21. AI 在互动中显得具有社交回应性。'],['sp2','22. AI 给人的感觉更像是积极的互动伙伴，而不仅仅是文本生成器。'],['sp3','23. 与 AI 的互动让我感到有社交参与感。'],
  ['cp1','24. 我感觉 AI 在写作任务中是“和我一起”的。'],['cp2','25. AI 似乎意识到我正在如何推进任务。'],['cp3','26. 我感到自己和 AI 之间存在一种相互感知。'],
  ['r1','27. 当我遇到困难或似乎卡住时，AI 对此作出了回应。'],['r2','28. AI 清楚地表明它注意到了我的不确定、困惑或沮丧。'],['r3','29. 在回应我的困难之后，AI 用不同方式帮助了我。'],['r4','30. AI 的修复或澄清信息让互动感觉更有支持性。'],['r5','31. AI 对我状态的回应是恰当的，而不是令人不适的。'],
  ['e1','32. AI 的支持程度与它表现出的感知能力相匹配。'],['e2','33. AI 满足了我对写作支持的期待。'],['e3','34. AI 表现出的情感感知强于它实际提供的帮助。'],['e4','35. 当 AI 没有提供我期待的帮助时，我感到失望。'],['e5','36. AI 的社交回应性让我期待它能提供更好的写作帮助。'],
  ['f1','37. 与 AI 协作时，我感到沮丧。'],['f2','38. 与这个 AI 写作助手协作的过程很顺畅。'],['f3','39. 我对通过 AI 完成的最终邮件草稿感到满意。'],['f4','40. 总体而言，我对这次 AI 写作体验感到满意。'],['f5','41. 未来我愿意使用以这种方式互动的写作工具。'],
  ['m1','42. AI 似乎会回应我的情绪或面部表情线索。'],['m2','43. 我认为摄像头被用于调整 AI 的回应。'],['m3','44. 当我看起来困惑、犹豫或沮丧时，AI 似乎会改变策略。'],
  ['m4','45. 在某个具体时刻，你是否意识到或怀疑 AI 正在回应你的面部表情？如果有，请描述。','text'],
  ['m5','46. 当你看起来困惑、犹豫或沮丧之后，AI 做了什么？','text'],
];

function surveyValue(data,key){
  const value=data?.[key];
  return value===undefined||value===null||value==='' ? '' : String(value);
}

function renderSurveyItems(items,data){
  return items.map(([key,question,type])=>{
    const value=surveyValue(data,key);
    if(type==='text'){
      return `<div class="survey-item open">
        <div class="survey-question">${escHtml(question)}</div>
        <div class="survey-text-answer ${value?'':'empty'}">${escHtml(value)}</div>
      </div>`;
    }
    return `<div class="survey-item">
      <div class="survey-question">${escHtml(question)}</div>
      <div class="survey-answer">${value?escHtml(value):'-'}</div>
    </div>`;
  }).join('');
}

export function renderSurvey(exp){
  const pre=exp.pre_survey||null;
  const post={...(exp.questionnaire||{}),...(exp.post_survey||{})};
  const html=`<div class="detail-section survey-results">
    <h3>问卷前</h3>
    ${pre?renderSurveyItems(PRE_SURVEY_ITEMS,pre):'<div class="loading">暂无问卷前数据</div>'}
  </div>
  <div class="detail-section survey-results">
    <h3>问卷后</h3>
    ${(exp.questionnaire||exp.post_survey)?renderSurveyItems(POST_SURVEY_ITEMS,post):'<div class="loading">暂无问卷后数据</div>'}
  </div>`;
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
      title="t=${f.t}s AU1:${f.au1} AU4:${f.au4} AU7:${f.au7} AU12:${f.au12} queued:${f.queued_ms||0}ms ${f.drop_reason||''} ${face&&reliable?'有效':'不可靠'}"></div>`;
  }
  html+=`</div>`;

  // AU table (first 200 rows for performance)
  const show=frames.slice(0,200);
  html+=`<div class="detail-section expression-table-section"><h3>帧数据表 (显示前 ${show.length} 帧, 共 ${frames.length})</h3>
    <div class="frame-table-wrap">
    <table class="frame-table">
      <thead><tr><th>时间(s)</th><th>AU1</th><th>AU4</th><th>AU7</th><th>AU12</th><th>Yaw°</th><th>Pitch°</th><th>排队(ms)</th><th>原因</th><th>面部</th><th>可靠</th></tr></thead>
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
      <td>${f.queued_ms||0}</td><td>${escHtml(f.drop_reason||'')}</td>
      <td>${face?'✅':'❌'}</td><td>${reliable?'✅':'⚠️'}</td>
    </tr>`;
  }
  html+=`</tbody></table></div></div>`;

  writeDetail(html);
}

// ── Baseline ──
function renderStrategyFrameRows(report,selected,expanded){
  const frames=report?.frames||[];
  if(!frames.length){
    return '<tr><td colspan="10" class="strategy-empty-cell">没有可用的实验阶段照片日志</td></tr>';
  }
  return frames.map((frame)=>{
    const activeKeys=STRATEGY_TRIGGERS.filter(([key])=>frame.triggers?.[key]).map(([key])=>key);
    const eventId=Number(frame.id??0);
    const visible=strategyFrameMatches(frame,selected);
    const isExpanded=visible&&expanded.has(String(eventId));
    const image=frame.image||'';
    const eventUrl=`/api/admin/debug-event/${encodeURIComponent(eventId)}/json?part=event`;
    const apiUrl=`/api/admin/debug-event/${encodeURIComponent(eventId)}/json?part=api`;
    const kb=frame.bytes?Math.round(frame.bytes/1024*10)/10:0;
    const checks=STRATEGY_TRIGGERS.map(([key])=>`<td class="strategy-check">${frame.triggers?.[key]?'<span aria-label="已触发">✓</span>':''}</td>`).join('');
    return `
      <tr class="strategy-frame-row" data-strategy-row data-strategies="${escAttr(activeKeys.join(','))}" ${visible?'':'hidden'}>
        <td>${escHtml(frame.ts||'-')}</td>
        <td>${frame.frame_number??'-'}</td>
        ${checks}
        <td><button class="debug-expand" data-action="strategy-detail" data-event-id="${eventId}">${isExpanded?'收起':'展开'}</button></td>
      </tr>
      <tr id="strategy-detail-${eventId}" class="debug-detail-row strategy-detail-row" data-strategy-detail data-strategies="${escAttr(activeKeys.join(','))}" data-expanded="${isExpanded?'true':'false'}" ${isExpanded?'':'hidden'}>
        <td colspan="10"><div class="debug-detail-body">
          <div class="debug-face">
            <img src="${escAttr(image)}" alt="实验阶段捕获帧">
            <div>
              <div class="debug-detail-summary">第 ${frame.frame_number??'-'} 帧 · ${kb} KB · ${frame.elapsed_ms??'-'} ms<br>${escHtml(frame.message||'')}</div>
              <a href="${escAttr(image)}" download="strategy-session-${report.session_id}-frame-${frame.frame_number??eventId}.jpg">下载图片</a>
            </div>
          </div>
          <div class="debug-json-actions">
            <a class="debug-json-link" href="${escAttr(apiUrl)}" target="_blank" rel="noopener noreferrer">查看 PyFeat JSON</a>
            <a class="debug-json-link" href="${escAttr(eventUrl)}" target="_blank" rel="noopener noreferrer">查看完整日志事件</a>
          </div>
        </div></td>
      </tr>`;
  }).join('');
}

export function applyStrategyFrameFilters(changedInput){
  const root=$('strategy-log-section');
  if(!root)return;
  const sessionId=root.dataset.sessionId||'';
  const all=$('strategy-filter-all');
  const items=[...document.querySelectorAll('[data-strategy-filter]')];
  if(changedInput===all){
    items.forEach(input=>{input.checked=all.checked});
  }else if(all){
    all.checked=items.every(input=>input.checked);
  }
  const selected=new Set(items.filter(input=>input.checked).map(input=>input.value));
  strategyFilterState.set(sessionId,selected);
  const expanded=strategyExpandedState.get(sessionId)||new Set();
  let visible=0;
  document.querySelectorAll('[data-strategy-row]').forEach((row)=>{
    const active=new Set((row.dataset.strategies||'').split(',').filter(Boolean));
    const show=[...selected].some(key=>active.has(key))||(active.size===0&&selected.has(STRATEGY_UNMATCHED_FILTER));
    row.hidden=!show;
    if(show)visible++;
    const eventId=row.querySelector('[data-event-id]')?.dataset.eventId;
    const detail=eventId?document.getElementById(`strategy-detail-${eventId}`):null;
    const isExpanded=expanded.has(String(eventId));
    if(detail){
      detail.dataset.expanded=isExpanded?'true':'false';
      detail.hidden=!show||!isExpanded;
    }
    const button=row.querySelector('[data-action="strategy-detail"]');
    if(button)button.textContent=show&&isExpanded?'收起':'展开';
  });
  const count=$('strategy-filter-count');
  if(count)count.textContent=selected.size?`显示 ${visible} 张照片`:'请选择至少一种筛选项以显示照片';
}

export function toggleStrategyDetail(eventId,button){
  const detail=document.getElementById(`strategy-detail-${eventId}`);
  if(!detail)return;
  const sessionId=$('strategy-log-section')?.dataset.sessionId||'';
  const expanded=strategyExpandedState.get(sessionId)||new Set();
  const key=String(eventId);
  if(expanded.has(key))expanded.delete(key);
  else expanded.add(key);
  strategyExpandedState.set(sessionId,expanded);
  detail.dataset.expanded=expanded.has(key)?'true':'false';
  detail.hidden=!expanded.has(key);
  if(button)button.textContent=detail.hidden?'展开':'收起';
}

export function renderBaseline(exp,report){
  const p=exp.participant;
  let html=`<div class="detail-section"><h3>参与者基线数据</h3>`;
  if(!p){
    html+='<div class="loading">无基线数据</div>';
  }else{
    html+=`
    <div class="info-grid">
      <div class="info-card"><div class="lbl">参与者 ID</div><div class="val mono">${escHtml(p.id)}</div></div>
      <div class="info-card"><div class="lbl">基线 AU1</div><div class="val mono">${p.baseline_au1?.toFixed(3)||'-'}</div></div>
      <div class="info-card"><div class="lbl">基线 AU4</div><div class="val mono">${p.baseline_au4?.toFixed(3)||'-'}</div></div>
      <div class="info-card"><div class="lbl">基线 AU7</div><div class="val mono">${p.baseline_au7?.toFixed(3)||'-'}</div></div>
      <div class="info-card"><div class="lbl">基线 AU12</div><div class="val mono">${p.baseline_au12?.toFixed(3)||'-'}</div></div>
      <div class="info-card"><div class="lbl">基线帧数</div><div class="val mono">${p.baseline_frame_count||0}</div></div>
    </div>`;
  }
  html+='</div>';

  if(!report){
    html+='<div class="detail-section"><h3>策略触发统计</h3><div class="loading strategy-loading">正在读取实验阶段策略日志...</div></div>';
    writeDetail(html);
    return;
  }

  const total=report.total_frames||0;
  const sessionKey=String(report.session_id??exp.session.id);
  const selected=strategyFilterState.get(sessionKey)||defaultStrategyFilters();
  const expanded=strategyExpandedState.get(sessionKey)||new Set();
  const statCards=STRATEGY_TRIGGERS.map(([key,label])=>{
    const count=report.counts?.[key]||0;
    const percent=total?(count/total*100).toFixed(1):'0.0';
    return `<div class="strategy-stat" title="${escAttr(key)}">
      <div class="strategy-stat-name">${escHtml(label)}</div>
      <div class="strategy-stat-rate">${percent}%</div>
      <div class="strategy-stat-count">${count} / ${total} 帧</div>
    </div>`;
  }).join('');
  const allFiltersSelected=selected.size===STRATEGY_TRIGGERS.length+1;
  const strategyFilters=STRATEGY_TRIGGERS.map(([key,label])=>`<label title="${escAttr(key)}"><input type="checkbox" value="${escAttr(key)}" data-strategy-filter ${selected.has(key)?'checked':''}>${escHtml(label)}</label>`).join('');
  const filters=`<label><input id="strategy-filter-all" type="checkbox" data-strategy-filter-all ${allFiltersSelected?'checked':''}>全选</label>${strategyFilters}<label title="七项策略均未触发"><input type="checkbox" value="${STRATEGY_UNMATCHED_FILTER}" data-strategy-filter ${selected.has(STRATEGY_UNMATCHED_FILTER)?'checked':''}>未命中</label>`;
  const visibleCount=(report.frames||[]).filter(frame=>strategyFrameMatches(frame,selected)).length;

  html+=`<div class="detail-section strategy-stats-section">
    <div class="section-heading"><h3>策略触发统计</h3><span class="muted">总实验帧数：${total}</span></div>
    <div class="strategy-stat-grid">${statCards}</div>
  </div>
  <div id="strategy-log-section" class="detail-section strategy-log-section" data-session-id="${escAttr(sessionKey)}">
    <div class="section-heading"><h3>策略照片日志</h3><span id="strategy-filter-count" class="muted">${selected.size?`显示 ${visibleCount} 张照片`:'请选择至少一种筛选项以显示照片'}</span></div>
    <div class="strategy-filter-row filter-row" aria-label="策略筛选">${filters}</div>
    <div class="strategy-table-wrap">
      <table class="frame-table strategy-frame-table">
        <thead><tr><th>时间</th><th>第几帧</th>${STRATEGY_TRIGGERS.map(([key,label])=>`<th title="${escAttr(key)}">${escHtml(label)}</th>`).join('')}<th>详细</th></tr></thead>
        <tbody>${renderStrategyFrameRows(report,selected,expanded)}</tbody>
      </table>
    </div>
  </div>`;
  writeDetail(html);
}

// ── Export ──
