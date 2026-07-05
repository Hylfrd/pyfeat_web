import './style.css';
import { $, escapeHtml as escHtml } from '../shared/dom.js';
import { createDebugConsole } from './debugConsole.js';
import { renderBaseline, renderChat, renderExpression, renderOverview } from './sessionViews.js';
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
