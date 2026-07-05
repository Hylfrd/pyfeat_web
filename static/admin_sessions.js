// ── Fetch & render ──
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
      onclick="selectSession(${s.id})">
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
    renderDebug();
    return;
  }
  stopDebugTimers();
  if(!exp){
    $('detail').innerHTML='<div class="empty-state"><div class="icon">←</div><p>从左侧选择一个 Session 查看详情</p></div>';
    return;
  }
  if(activeTab==='overview')renderOverview(exp,st);
  if(activeTab==='chat')renderChat(exp);
  if(activeTab==='expression')renderExpression(exp,st);
  if(activeTab==='baseline')renderBaseline(exp);
}
