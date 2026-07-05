import './style.css';
import { $, escapeAttr as escAttr, escapeHtml as escHtml } from '../shared/dom.js';
import { createDebugConsole } from './debugConsole.js';
let sessions=[],activeSid=null,sessionCache={};
let activeTab='debug';
let refreshTimer=null;

function showAuth(message=''){
  $('auth-overlay').classList.remove('hidden');
  $('auth-error').textContent=message;
  setTimeout(()=>$('auth-token')?.focus(),0);
  if(refreshTimer){
    clearInterval(refreshTimer);
    refreshTimer=null;
  }
}

function hideAuth(){
  $('auth-overlay').classList.add('hidden');
  $('auth-error').textContent='';
  if(!refreshTimer)refreshTimer=setInterval(refresh,10000);
}

async function adminFetch(url,opts={}){
  const r=await fetch(url,{...opts,credentials:'same-origin'});
  if(r.status===401){
    showAuth('Token 已失效，请重新输入。');
    throw new Error('unauthorized');
  }
  return r;
}

$('auth-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const token=$('auth-token').value.trim();
  if(!token){
    $('auth-error').textContent='请输入 token。';
    return;
  }
  const body=new URLSearchParams();
  body.set('token',token);
  const r=await fetch('/api/admin/login',{method:'POST',body,credentials:'same-origin'});
  if(!r.ok){
    $('auth-error').textContent='Token错误';
    return;
  }
  $('auth-token').value='';
  hideAuth();
  await refresh();
  renderActiveTab();
});

async function initAuth(){
  const r=await fetch('/api/admin/auth',{credentials:'same-origin'});
  if(!r.ok){
    showAuth();
    return;
  }
  hideAuth();
  await refresh();
  renderActiveTab();
}

// ── Toast ──
function toast(msg,type='ok'){
  const el=document.createElement('div');el.className='toast '+type;el.textContent=msg;
  $('toast-container').appendChild(el);
  setTimeout(()=>el.remove(),3000);
}

// ── Fetch & render ──
const debugConsole=createDebugConsole({adminFetch, toast});

async function refresh(){
  const r=await adminFetch('/api/admin/sessions');
  sessions=await r.json();
  renderStats();
  renderList();
  if(activeTab!=='debug'&&activeSid)await loadSession(activeSid,true);
}
async function renderStats(){
  const done=sessions.filter(s=>s.completed);
  const excl=sessions.filter(s=>s.excluded);
  $('stats-row').innerHTML=`
    <div class="stat"><div class="val green">${done.length}</div><div class="lbl">已完成</div></div>
    <div class="stat"><div class="val indigo">${sessions.length}</div><div class="lbl">总计</div></div>
    <div class="stat"><div class="val amber">${excl.length}</div><div class="lbl">已排除</div></div>
  `;
}
function renderList(){
  const q=($('search').value||'').toLowerCase();
  const cond=$('filter-cond').value;
  let filtered=sessions;
  if(q)filtered=filtered.filter(s=>(s.participant_id||'').toLowerCase().includes(q)||String(s.id).includes(q));
  if(cond!=='all')filtered=filtered.filter(s=>s.condition===cond);

  let html='';
  for(const s of filtered){
    const dur=s.duration_ms?Math.floor(s.duration_ms/1000)+'s':'';
    const loss=s.frame_loss_ratio>0.3?`<span style="color:#ef4444">⚠${Math.round(s.frame_loss_ratio*100)}%</span>`:'';
    html+=`<div class="session-item ${s.id===activeSid?'active':''} ${s.excluded?'excluded':''}"
      data-action="select-session" data-session-id="${s.id}">
      <div class="left">
        <div class="top">
          <span class="pid">${escHtml(s.participant_id)}</span>
          <span class="badge ${s.condition==='affect-aware'?'affect':'text'}">${s.condition==='affect-aware'?'情感感知':'纯文本'}</span>
          <span class="badge s">场景${s.task_scenario}</span>
        </div>
        <div class="meta">
          <span>#${s.id}</span>
          <span>单次任务</span>
          <span>${s.completion_type||'进行中'}</span>
          ${loss}
        </div>
      </div>
      <div class="right">
        <div class="status-dot ${s.completed?'done':(s.excluded?'excl':'pending')}" title="${s.completed?'完成':'进行中'}"></div>
        <span class="turns">${s.total_turns||0}轮</span>
      </div>
    </div>`;
  }
  $('session-list').innerHTML=html||'<div style="padding:32px;text-align:center;color:#475569;font-size:.82em">无匹配的 Session</div>';
}

// ── Session selection ──
async function selectSession(sid){
  activeSid=sid;
  activeTab='overview';
  renderList();
  await loadSession(sid);
}
async function loadSession(sid,silent=false){
  if(!silent){$('detail').innerHTML='<div class="loading"><div class="spinner"></div><p>加载中...</p></div>'}

  // Fetch data
  const [exportR,statsR]=await Promise.all([
    adminFetch(`/api/admin/sessions/${sid}/export`),
    adminFetch(`/api/admin/expression/${sid}/stats`)
  ]);
  const exp=await exportR.json();
  const st=await statsR.json();
  sessionCache[sid]={exp,st};

  setActiveTab(activeTab);
  renderActiveTab();
}

// ── Tab switching ──
$('tabs').addEventListener('click',e=>{
  if(e.target.tagName!=='BUTTON')return;
  activeTab=e.target.dataset.tab;
  setActiveTab(activeTab);
  renderActiveTab();
});

function setActiveTab(tab){
  $('tabs').querySelectorAll('button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
}

function renderActiveTab(){
  const {exp,st}=sessionCache[activeSid]||{};
  if(activeTab==='debug'){
    debugConsole.render();
    return;
  }
  debugConsole.stopTimers();
  if(!exp){
    $('detail').innerHTML='<div class="empty-state"><div class="icon">←</div><p>从左侧选择一个 Session 查看详情</p></div>';
    return;
  }
  if(activeTab==='overview')renderOverview(exp,st);
  if(activeTab==='chat')renderChat(exp);
  if(activeTab==='expression')renderExpression(exp,st);
  if(activeTab==='baseline')renderBaseline(exp);
}


// ── Overview ──
function renderOverview(exp,st){
  const s=exp.session;
  const p=exp.participant||{};
  const q=exp.questionnaire;
  const evals=exp.evaluations||[];
  const dur=s.duration_ms?Math.floor(s.duration_ms/1000):0;
  const durStr=dur?`${Math.floor(dur/60)}分${dur%60}秒`:'-';
  const framesOk=(st.total_frames||0)-(st.face_lost_frames||0);
  const faceOkPct=st.total_frames?Math.round(framesOk/st.total_frames*100):0;

  let html=`
    <div class="action-bar">
      <button data-action="export-session" data-session-id="${s.id}">⬇ 导出 JSON</button>
      <button data-action="export-session-csv" data-session-id="${s.id}">⬇ 导出 CSV</button>
      <button class="danger" data-action="confirm-delete" data-session-id="${s.id}" data-participant-id="${escAttr(s.participant_id)}">✕ 删除此 Session</button>
    </div>

    <div class="detail-section"><h3>会话信息</h3>
      <div class="info-grid">
        <div class="info-card"><div class="lbl">Session ID</div><div class="val mono">#${s.id}</div></div>
        <div class="info-card"><div class="lbl">参与者</div><div class="val mono">${escHtml(s.participant_id)}</div></div>
        <div class="info-card"><div class="lbl">条件</div><div class="val">${s.condition==='affect-aware'?'情感感知 AI':'纯文本 AI'}</div></div>
        <div class="info-card"><div class="lbl">场景</div><div class="val">${s.task_scenario==='A'?'场景 A (电脑崩溃)':'场景 B (组员失联)'}</div></div>
        <div class="info-card"><div class="lbl">任务流程</div><div class="val">单次写作任务</div></div>
        <div class="info-card"><div class="lbl">完成方式</div><div class="val">${s.completion_type==='timeout'?'⏱ 超时':'手动提交'} ${s.completed?'✅':''}</div></div>
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
      const cls=f.ok?'':'lost';
      const color=f.ok?(f.face?'#22c55e':'#ef4444'):'#64748b';
      html+=`<div class="cell ${cls}" style="background:${color}" title="t=${f.t}s AU4:${f.au4} AU12:${f.au12} ${f.ok?'✅':'⚠️'}"></div>`;
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
      <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:16px;
        font-family:Georgia,serif;font-size:.85em;line-height:1.7;color:#cbd5e1;white-space:pre-wrap;max-height:300px;overflow-y:auto">${escHtml(s.final_email)}</div>
    </div>`;
  }

  // Evaluations
  if(evals.length){
    html+=`<div class="detail-section"><h3>评估结果</h3>`;
    for(const e of evals){
      let detail='';
      try{detail=JSON.stringify(JSON.parse(e.details_json||'{}'),null,2)}catch(_){detail=e.details_json||''}
      html+=`<div class="info-card" style="margin-bottom:8px">
        <div class="lbl">${e.layer} · 模型 ${e.evaluator_model}</div>
        <div class="val mono">${e.score?.toFixed(1)}</div>
        ${detail?`<pre style="font-size:.7em;color:#94a3b8;margin-top:4px">${escHtml(detail)}</pre>`:''}
      </div>`;
    }
    html+=`</div>`;
  }

  $('detail').innerHTML=html;
}

// ── Chat ──
function renderChat(exp){
  const logs=exp.chat_logs||[];
  let html=`<div class="action-bar">
    <button data-action="export-session" data-session-id="${exp.session.id}">⬇ 导出 JSON</button>
  </div><div class="detail-section"><h3>对话记录 (${logs.length} 条)</h3></div>`;

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
  $('detail').innerHTML=html;
}

// ── Expression ──
function renderExpression(exp,st){
  const frames=st.frames||[];
  let html=`<div class="action-bar">
    <button data-action="export-expression-csv" data-session-id="${exp.session.id}">⬇ 导出 AU 数据 CSV</button>
  </div><div class="detail-section"><h3>表情 AU 数据 (${frames.length} 帧)</h3></div>`;

  // AU timeline strip
  html+=`<div class="au-legend">
    <span><span class="swatch" style="background:#ef4444"></span>AU4≥2 (困惑/沮丧)</span>
    <span><span class="swatch" style="background:#22c55e"></span>AU12≥2 (正向)</span>
    <span><span class="swatch" style="background:#f59e0b"></span>AU7≥2</span>
    <span><span class="swatch" style="background:#818cf8"></span>AU1≥1.5</span>
    <span><span class="swatch" style="background:#334155"></span>中性</span>
  </div>`;
  html+=`<div class="au-strip">`;
  for(const f of frames){
    let color='#334155';
    if(f.au4>=2)color='#ef4444';
    else if(f.au12>=2)color='#22c55e';
    else if(f.au7>=2)color='#f59e0b';
    else if(f.au1>=1.5)color='#818cf8';
    html+=`<div class="cell ${f.ok?'':'lost'}" style="background:${color}"
      title="t=${f.t}s AU1:${f.au1} AU4:${f.au4} AU7:${f.au7} AU12:${f.au12} ${f.ok?'✅':'⚠️'}"></div>`;
  }
  html+=`</div>`;

  // AU table (first 200 rows for performance)
  const show=frames.slice(0,200);
  html+=`<div class="detail-section"><h3>帧数据表 (显示前 ${show.length} 帧, 共 ${frames.length})</h3>
    <div style="max-height:500px;overflow-y:auto;border:1px solid #334155;border-radius:10px">
    <table class="frame-table">
      <thead><tr><th>时间(s)</th><th>AU1</th><th>AU4</th><th>AU7</th><th>AU12</th><th>Yaw°</th><th>Pitch°</th><th>面部</th><th>可靠</th></tr></thead>
      <tbody>`;
  for(const f of show){
    const au4ok=f.au4>=2;
    const au12ok=f.au12>=2;
    const clsRow=f.ok?'':'lost';
    html+=`<tr class="${clsRow}">
      <td>${f.t}</td>
      <td class="${f.au1>=1.5?'trigger':''}">${f.au1}</td>
      <td class="${au4ok?'trigger':''}">${f.au4}</td>
      <td class="${f.au7>=2?'trigger':''}">${f.au7}</td>
      <td class="${au12ok?'trigger':''}">${f.au12}</td>
      <td>${f.yaw}</td><td>${f.pitch}</td>
      <td>${f.face?'✅':'❌'}</td><td>${f.ok?'✅':'⚠️'}</td>
    </tr>`;
  }
  html+=`</tbody></table></div></div>`;

  $('detail').innerHTML=html;
}

// ── Baseline ──
function renderBaseline(exp){
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
    <div style="margin-top:20px;padding:16px;background:#0f172a;border:1px solid #334155;border-radius:10px">
      <p style="font-size:.75em;color:#64748b;margin-bottom:8px">基线 AU 向量 (用于偏差计算)</p>
      <div style="display:flex;gap:24px;font-family:monospace;font-size:.9em">
        <div><span style="color:#818cf8">AU1</span> <strong>${p.baseline_au1?.toFixed(3)||'-'}</strong></div>
        <div><span style="color:#ef4444">AU4</span> <strong>${p.baseline_au4?.toFixed(3)||'-'}</strong></div>
        <div><span style="color:#f59e0b">AU7</span> <strong>${p.baseline_au7?.toFixed(3)||'-'}</strong></div>
        <div><span style="color:#22c55e">AU12</span> <strong>${p.baseline_au12?.toFixed(3)||'-'}</strong></div>
      </div>
    </div>`;
  }
  // Also show the session's expression stats summary
  $('detail').innerHTML=html;
}

// ── Export ──
function downloadJSON(data,filename){
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();
}
async function exportSession(sid){
  const r=await adminFetch(`/api/admin/sessions/${sid}/export`);
  const data=await r.json();
  downloadJSON(data,`session_${sid}_${data.session.participant_id}.json`);
  toast('导出 JSON 完成','ok');
}
function exportSessionCSV(sid){
  const {exp}=sessionCache[sid]||{};
  if(!exp)return;
  const logs=exp.chat_logs||[];
  let csv='seq,role,content,timestamp,expression_label,strategy_applied\n';
  for(const l of logs){
    csv+=`${l.seq},"${l.role}","${(l.content||'').replace(/"/g,'""')}","${l.timestamp}","${l.expression_label||''}","${l.strategy_applied||''}"\n`;
  }
  const blob=new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`session_${sid}_chat.csv`;a.click();
  toast('导出 CSV 完成','ok');
}
async function exportExpressionCSV(sid){
  const r=await adminFetch(`/api/admin/expression/${sid}/stats`);
  const st=await r.json();
  const frames=st.frames||[];
  let csv='time_s,au1,au4,au7,au12,head_yaw,head_pitch,face_detected,reliable\n';
  for(const f of frames){
    csv+=`${f.t},${f.au1},${f.au4},${f.au7},${f.au12},${f.yaw},${f.pitch},${f.face},${f.ok}\n`;
  }
  const blob=new Blob([csv],{type:'text/csv'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`session_${sid}_expression.csv`;a.click();
  toast('导出 AU CSV 完成','ok');
}

// ── Delete ──
function confirmDelete(sid,pid){
  $('modal-overlay').classList.remove('hidden');
  $('modal-overlay').querySelector('.modal').innerHTML=`
    <h3>删除 Session #${sid}</h3>
    <p>确定删除 <strong>${escHtml(pid)}</strong> 的 Session #${sid}？<br>
    这将同时删除所有关联的聊天记录、表情数据、问卷和评估结果。<br><br>
    <span style="color:#ef4444">此操作不可撤销。</span></p>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button data-action="close-modal">取消</button>
      <button class="danger" data-action="do-delete" data-session-id="${sid}">确认删除</button>
    </div>
  `;
}
function closeModal(){$('modal-overlay').classList.add('hidden')}
async function doDelete(sid){
  const r=await adminFetch(`/api/admin/sessions/${sid}`,{method:'DELETE'});
  if(r.ok){
    closeModal();
    activeSid=null;
    activeTab='debug';
    setActiveTab(activeTab);
    debugConsole.render();
    toast('已删除','ok');
    refresh();
  }else{
    let message=r.status===409?'用户正在实验中':'删除失败';
    try{
      const data=await r.json();
      if(data.detail)message=data.detail;
    }catch(e){}
    toast(message,'err');
  }
}


function bindAdminEvents(){
  $('search')?.addEventListener('input', renderList);
  $('filter-cond')?.addEventListener('change', renderList);
  document.addEventListener('click', handleAdminClick);
  document.addEventListener('input', handleAdminInput);
  document.addEventListener('change', handleAdminChange);
}

function handleAdminClick(e){
  if(e.target===$('modal-overlay')){
    closeModal();
    return;
  }
  const el=e.target.closest('[data-action]');
  if(!el)return;
  const action=el.dataset.action;
  if(action==='select-session')return selectSession(Number(el.dataset.sessionId));
  if(action==='toggle-debug')return debugConsole.toggleMode();
  if(action==='clear-debug')return debugConsole.clearLogs();
  if(action==='check-health')return debugConsole.checkHealth();
  if(action==='choose-debug-image'){
    debugConsole.stopFollow();
    return $('debug-upload')?.click();
  }
  if(action==='test-ai')return debugConsole.testAIStatus(el.dataset.provider);
  if(action==='debug-detail')return debugConsole.toggleDetail(e,Number(el.dataset.eventId));
  if(action==='export-session')return exportSession(Number(el.dataset.sessionId));
  if(action==='export-session-csv')return exportSessionCSV(Number(el.dataset.sessionId));
  if(action==='export-expression-csv')return exportExpressionCSV(Number(el.dataset.sessionId));
  if(action==='confirm-delete')return confirmDelete(Number(el.dataset.sessionId),el.dataset.participantId||'');
  if(action==='close-modal')return closeModal();
  if(action==='do-delete')return doDelete(Number(el.dataset.sessionId));
}

function handleAdminInput(e){
  if(['debug-search','debug-participant','debug-session'].includes(e.target.id)){
    debugConsole.stopFollow();
    debugConsole.scheduleReload();
  }
}

function handleAdminChange(e){
  if(e.target.id==='debug-kind'){
    debugConsole.stopFollow();
    debugConsole.reload();
  }
  if(e.target.id==='debug-upload'){
    debugConsole.uploadImage();
  }
}

bindAdminEvents();
initAuth();
