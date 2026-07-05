import { $, escapeAttr as escAttr, escapeHtml as escHtml } from '../shared/dom.js';

const DEBUG_LIMIT=80;
const DEBUG_POLL_MS=100;
const DEBUG_HEALTH_MS=10000;

export function createDebugConsole({adminFetch, toast}){
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
    toast(debugEnabled?'日志记录已开启':'日志记录已关闭','ok');
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
    const detail=$('detail');
    if(!detail)return;
    detail.innerHTML=`
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
    const tableBody=$('debug-rows');
    if(tableBody)tableBody.innerHTML=rows||'<tr><td colspan="10" style="text-align:center;color:#64748b;padding:24px">没有匹配的日志</td></tr>';
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
    if(!r.ok){
      toast('清空当前日志失败','err');
      return;
    }
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
    toast('当前日志已清空','ok');
  }

  async function testAIStatus(provider){
    stopDebugFollow();
    setDebugOutput(`测试 ${provider} 状态中...`);
    const r=await adminFetch(`/api/admin/debug-ai/${provider}`);
    setDebugOutput(JSON.stringify(await r.json(),null,2));
  }

  function toggleMode(){
    return setDebugMode(!debugEnabled);
  }

  return {
    render: renderDebug,
    stopTimers: stopDebugTimers,
    stopFollow: stopDebugFollow,
    toggleMode,
    checkHealth: checkDebugHealth,
    uploadImage: uploadDebugImage,
    clearLogs: clearDebugLogs,
    testAIStatus,
    toggleDetail: toggleDebugDetail,
    scheduleReload: scheduleDebugReload,
    reload: reloadDebug,
  };
}
