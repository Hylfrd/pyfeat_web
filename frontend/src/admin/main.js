import './style.css';

const $=id=>document.getElementById(id);
let sessions=[],activeSid=null,sessionCache={};
let debugEvents=[];
let debugBefore=null;
let debugHasMore=false;
let debugEnabled=false;
let debugLoading=false;
let debugDetailCache=new Map();
let debugExpandedIds=new Set();
let debugFilterTimer=null;
let debugPollTimer=null;
let debugHealthTimer=null;
let debugCacheTimer=null;
let debugAutoFollow=true;
let debugPendingReload=false;
let debugLastFilterKey='';
let activeTab='debug';
let refreshTimer=null;
const DEBUG_LIMIT=80;
const DEBUG_POLL_MS=100;
const DEBUG_HEALTH_MS=10000;

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

// ── Helpers ──
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function escAttr(s){return escHtml(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

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

async function setDebugMode(enabled){
  stopDebugFollow();
  const body=new URLSearchParams();
  body.set('enabled', enabled ? 'true' : 'false');
  const r=await adminFetch('/api/admin/debug-mode',{method:'POST',body});
  if(!r.ok){
    toast('日志开关更新失败','err');
    return;
  }
  const data=await r.json();
  debugEnabled=!!data.enabled;
  updateDebugControls();
  await loadDebugPage({live:true,silent:true});
}

async function checkDebugHealth(){
  stopDebugFollow();
  setDebugOutput('检测模型状态中...');
  const r=await adminFetch('/api/admin/debug-health');
  const data=await r.json();
  updatePyfeatStatus(data);
  setDebugOutput(JSON.stringify(data,null,2));
}

async function refreshPyfeatStatus(){
  if(!$('pyfeat-status'))return;
  const r=await adminFetch('/api/admin/debug-health');
  updatePyfeatStatus(await r.json());
}

function updatePyfeatStatus(data={}){
  const el=$('pyfeat-status');
  if(!el)return;
  el.className='debug-status-card '+(data.ok?'ok':'err');
  const ms=data.elapsed_ms!==undefined?` · ${data.elapsed_ms} ms`:'';
  el.textContent=data.ok?`PyFeat 正常${ms}`:`模型离线${ms}`;
  el.title=JSON.stringify(data,null,2);
}

async function uploadDebugImage(){
  stopDebugFollow();
  const file=$('debug-upload')?.files?.[0];
  if(!file){
    $('debug-upload')?.click();
    return;
  }
  setDebugOutput('上传并检测中...');
  const body=new FormData();
  body.append('file',file);
  const r=await adminFetch('/api/admin/debug-detect',{method:'POST',body});
  setDebugOutput(JSON.stringify(await r.json(),null,2));
  $('debug-upload').value='';
}

async function renderDebug(){
  stopDebugTimers();
  debugEvents=[];
  debugBefore=null;
  debugHasMore=false;
  debugDetailCache.clear();
  debugExpandedIds.clear();
  debugAutoFollow=true;
  $('detail').innerHTML=`
    <div class="debug-console-bar">
      <button id="debug-toggle" class="primary" data-action="toggle-debug">开启日志记录</button>
      <div id="pyfeat-status" class="debug-status-card">PyFeat 检测中...</div>
      <button class="danger" data-action="clear-debug">清空当前日志</button>
      <div id="debug-cache" class="debug-cache-card">缓存图片：检测中...</div>
    </div>
    <div class="debug-test-bar">
      <button data-action="check-health">检查模型状态</button>
      <button data-action="choose-debug-image">上传图片至 PyFeat</button>
      <button data-action="test-ai" data-provider="deepseek">测试 DeepSeek 状态</button>
      <button data-action="test-ai" data-provider="kimi">测试 Kimi 状态</button>
      <input id="debug-upload" type="file" accept="image/*" hidden>
    </div>
    <pre id="debug-result" class="debug-result"></pre>
    <div class="debug-tools">
      <input id="debug-search" type="text" placeholder="搜索 participant / session / message / API JSON...">
      <input id="debug-participant" type="text" placeholder="参与者">
      <input id="debug-session" type="text" placeholder="Session">
      <select id="debug-kind">
        <option value="">全部类型</option>
        <option value="expression">expression</option>
        <option value="baseline">baseline</option>
        <option value="strategy">strategy</option>
        <option value="ai">ai</option>
        <option value="eval">eval</option>
        <option value="debug">debug</option>
      </select>
    </div>
    <div id="debug-scroll" class="debug-table-wrap" tabindex="0">
      <table class="frame-table">
        <thead><tr><th>时间</th><th>类型</th><th>参与者</th><th>Session</th><th>KB</th><th>ms</th><th>Face</th><th>Reliable</th><th>信息</th><th>详情</th></tr></thead>
        <tbody id="debug-rows"></tbody>
      </table>
    </div>
  `;
  bindDebugScroll();
  updateDebugControls();
  await Promise.all([
    refreshPyfeatStatus(),
    refreshDebugCache(),
    loadDebugPage({reset:true}),
  ]);
  startDebugTimers();
}

function debugParams(before=null){
  const params=new URLSearchParams();
  params.set('limit',String(DEBUG_LIMIT));
  if(before!==null&&before!==undefined)params.set('before',String(before));
  const q=$('debug-search')?.value.trim();
  const participant=$('debug-participant')?.value.trim();
  const sid=$('debug-session')?.value.trim();
  const kind=$('debug-kind')?.value;
  if(q)params.set('q',q);
  if(participant)params.set('participant_id',participant);
  if(sid)params.set('session_id',sid);
  if(kind)params.set('kind',kind);
  return params;
}

function currentDebugFilterKey(){
  const params=debugParams(null);
  params.delete('before');
  return params.toString();
}

function scheduleDebugReload(){
  clearTimeout(debugFilterTimer);
  debugFilterTimer=setTimeout(()=>reloadDebug(),350);
}

async function reloadDebug(){
  debugAutoFollow=false;
  if(debugLoading){
    debugPendingReload=true;
    return;
  }
  await loadDebugPage({reset:true});
}

async function loadMoreDebug(){
  if(!debugHasMore||debugBefore===null)return;
  await loadDebugPage({reset:false,before:debugBefore});
}

async function loadDebugPage({reset=false,before=null,live=false,silent=false}={}){
  if(debugLoading||!$('debug-rows')){
    if(reset)debugPendingReload=true;
    return;
  }
  debugLoading=true;
  try{
    const filterKey=currentDebugFilterKey();
    if(live&&filterKey!==debugLastFilterKey){
      reset=true;
      live=false;
      before=null;
    }
    const params=debugParams(reset?null:before);
    const r=await adminFetch(`/api/admin/debug?${params.toString()}`);
    const data=await r.json();
    debugEnabled=!!data.enabled;
    const events=data.events||[];
    if(reset){
      debugBefore=data.next_before??null;
      debugHasMore=!!data.has_more;
      debugEvents=events;
      debugDetailCache.clear();
      debugExpandedIds.clear();
      debugLastFilterKey=filterKey;
    }else if(live){
      const incomingIds=new Set(events.map(e=>String(e.id)));
      debugEvents=events.concat(debugEvents.filter(e=>!incomingIds.has(String(e.id))));
      if(debugBefore===null){
        debugBefore=data.next_before??null;
        debugHasMore=!!data.has_more;
      }
    }else{
      debugBefore=data.next_before??null;
      debugHasMore=!!data.has_more;
      const seen=new Set(debugEvents.map(e=>String(e.id)));
      debugEvents=debugEvents.concat(events.filter(e=>!seen.has(String(e.id))));
    }
    updateDebugControls(data);
    renderDebugRows();
  }finally{
    debugLoading=false;
    if(debugPendingReload){
      debugPendingReload=false;
      setTimeout(()=>reloadDebug(),0);
    }
  }
}

function updateDebugControls(data={}){
  const btn=$('debug-toggle');
  if(btn){
    btn.className=debugEnabled?'danger':'primary';
    btn.textContent=debugEnabled?'关闭日志记录':'开启日志记录';
  }
}

function renderDebugRows(){
  const scroll=$('debug-scroll');
  const keepTop=debugAutoFollow&&scroll;
  const rows=debugEvents.map(e=>{
    const kb=e.bytes?Math.round(e.bytes/1024*10)/10:'';
    const id=String(e.id??'');
    const expanded=debugExpandedIds.has(id);
    const detail=debugDetailCache.get(id);
    return `
      <tr>
        <td>${escHtml(e.ts||'')}</td>
        <td>${escHtml(e.kind||'')}</td>
        <td>${escHtml(e.participant_id||'')}</td>
        <td>${e.session_id??''}</td>
        <td>${kb}</td>
        <td>${e.elapsed_ms??''}</td>
        <td>${e.face_detected?'yes':'no'}</td>
        <td>${e.reliable?'yes':'no'}</td>
        <td>${escHtml(e.message||'')}</td>
        <td>
          <button class="debug-expand" data-action="debug-detail" data-event-id="${Number(e.id??0)}">${expanded?'收起':'展开'}</button>
        </td>
      </tr>
      ${expanded?`<tr class="debug-detail-row"><td colspan="10"><div class="debug-detail-body">${detail||'加载详情中...'}</div></td></tr>`:''}`;
  }).join('');
  $('debug-rows').innerHTML=rows||'<tr><td colspan="10" style="text-align:center;color:#64748b;padding:24px">没有匹配的日志</td></tr>';
  if(keepTop)scroll.scrollTop=0;
}

async function toggleDebugDetail(ev,eventId){
  ev.preventDefault();
  ev.stopPropagation();
  stopDebugFollow();
  const id=String(eventId);
  if(debugExpandedIds.has(id)){
    debugExpandedIds.delete(id);
    renderDebugRows();
    return;
  }
  debugExpandedIds.add(id);
  renderDebugRows();
  if(!debugDetailCache.has(id))await loadDebugDetail(eventId);
}

async function loadDebugDetail(eventId){
  const id=String(eventId);
  try{
    const r=await adminFetch(`/api/admin/debug-event/${eventId}`);
    const e=await r.json();
    debugDetailCache.set(id,renderDebugDetail(e));
  }catch(err){
    debugDetailCache.set(id,'详情加载失败');
  }
  renderDebugRows();
}

function renderDebugDetail(e){
  const kb=e.bytes?Math.round(e.bytes/1024*10)/10:'';
  const eventId=encodeURIComponent(e.id??'');
  const hasApi=e.api_response!==undefined;
  const apiUrl=`/api/admin/debug-event/${eventId}/json?part=api`;
  const eventUrl=`/api/admin/debug-event/${eventId}/json?part=event`;
  const image=e.image?`
    <div class="debug-face">
      <img src="${escAttr(e.image)}" alt="captured frame">
      <div>
        <div style="color:#94a3b8;line-height:1.6">
          Captured frame sent to PyFeat.<br>
          Payload: ${kb||0} KB · Time: ${e.elapsed_ms??''} ms
        </div>
        <a href="${escAttr(e.image)}" download="debug-${escAttr(e.participant_id||'unknown')}-${escAttr(e.session_id??'none')}-${escAttr(e.ts||e.id)}.jpg">&#19979;&#36733;&#22270;&#29255;</a>
      </div>
    </div>`:'<div style="color:#64748b;margin-top:8px">&#36825;&#20010;&#20107;&#20214;&#27809;&#26377;&#22270;&#29255;&#12290;</div>';
  return `
    ${image}
    <div class="debug-detail-summary">
      &#31867;&#22411;: ${escHtml(e.kind||'-')} · &#21442;&#19982;&#32773;: ${escHtml(e.participant_id||'-')} · Session: ${escHtml(e.session_id??'-')} · ${escHtml(e.message||'')}
    </div>
    <div class="debug-json-actions">
      ${hasApi?`<a class="debug-json-link" href="${escAttr(apiUrl)}" target="_blank" rel="noopener noreferrer">&#26597;&#30475; PyFeat JSON</a>`:''}
      <a class="debug-json-link" href="${escAttr(eventUrl)}" target="_blank" rel="noopener noreferrer">&#26597;&#30475;&#23436;&#25972;&#26085;&#24535;&#20107;&#20214;</a>
    </div>`;
}

function bindDebugScroll(){
  const el=$('debug-scroll');
  if(!el)return;
  ['wheel','touchstart','mousedown','keydown'].forEach(type=>{
    el.addEventListener(type,stopDebugFollow,{passive:true});
  });
  el.addEventListener('scroll',()=>{
    if(el.scrollTop+el.clientHeight>=el.scrollHeight-120){
      loadMoreDebug();
    }
  });
}

function stopDebugFollow(){
  debugAutoFollow=false;
}

function startDebugTimers(){
  stopDebugTimers();
  debugPollTimer=setInterval(()=>loadDebugPage({live:true,silent:true}),DEBUG_POLL_MS);
  debugHealthTimer=setInterval(refreshPyfeatStatus,DEBUG_HEALTH_MS);
  debugCacheTimer=setInterval(refreshDebugCache,DEBUG_HEALTH_MS);
}

function stopDebugTimers(){
  if(debugPollTimer)clearInterval(debugPollTimer);
  if(debugHealthTimer)clearInterval(debugHealthTimer);
  if(debugCacheTimer)clearInterval(debugCacheTimer);
  debugPollTimer=null;
  debugHealthTimer=null;
  debugCacheTimer=null;
}

function setDebugOutput(text){
  const el=$('debug-result');
  if(el)el.textContent=text||'';
}

async function refreshDebugCache(){
  if(!$('debug-cache'))return;
  const r=await adminFetch('/api/admin/debug-cache');
  const data=await r.json();
  $('debug-cache').textContent=`缓存图片：${data.count||0} 张 · ${data.kb||0} KB`;
}

async function clearDebugLogs(){
  stopDebugFollow();
  setDebugOutput('正在清空日志和图片缓存...');
  const r=await adminFetch('/api/admin/debug-clear',{method:'POST'});
  const data=await r.json();
  debugEvents=[];
  debugBefore=null;
  debugHasMore=false;
  debugDetailCache.clear();
  debugExpandedIds.clear();
  renderDebugRows();
  updateDebugControls();
  await refreshDebugCache();
  setDebugOutput(JSON.stringify(data,null,2));
}

async function testAIStatus(provider){
  stopDebugFollow();
  setDebugOutput(`测试 ${provider} 状态中...`);
  const r=await adminFetch(`/api/admin/debug-ai/${provider}`);
  setDebugOutput(JSON.stringify(await r.json(),null,2));
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
    renderDebug();
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
  if(action==='toggle-debug')return setDebugMode(!debugEnabled);
  if(action==='clear-debug')return clearDebugLogs();
  if(action==='check-health')return checkDebugHealth();
  if(action==='choose-debug-image'){
    stopDebugFollow();
    return $('debug-upload')?.click();
  }
  if(action==='test-ai')return testAIStatus(el.dataset.provider);
  if(action==='debug-detail')return toggleDebugDetail(e,Number(el.dataset.eventId));
  if(action==='export-session')return exportSession(Number(el.dataset.sessionId));
  if(action==='export-session-csv')return exportSessionCSV(Number(el.dataset.sessionId));
  if(action==='export-expression-csv')return exportExpressionCSV(Number(el.dataset.sessionId));
  if(action==='confirm-delete')return confirmDelete(Number(el.dataset.sessionId),el.dataset.participantId||'');
  if(action==='close-modal')return closeModal();
  if(action==='do-delete')return doDelete(Number(el.dataset.sessionId));
}

function handleAdminInput(e){
  if(['debug-search','debug-participant','debug-session'].includes(e.target.id)){
    stopDebugFollow();
    scheduleDebugReload();
  }
}

function handleAdminChange(e){
  if(e.target.id==='debug-kind'){
    stopDebugFollow();
    reloadDebug();
  }
  if(e.target.id==='debug-upload'){
    uploadDebugImage();
  }
}

bindAdminEvents();
initAuth();
