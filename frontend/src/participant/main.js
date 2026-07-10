import './style.css';
import { $, escapeHtml } from '../shared/dom.js';

// ── DOM refs ──
const views = ['setup-view','pre-survey-view','queue-view','baseline-view','task-view','questionnaire-view','complete-view','duplicate-tab-view'];
function showView(id){
  views.forEach(v=>$(v).classList.add('hidden'));
  $(id).classList.remove('hidden');
  document.documentElement.dataset.stage=id;
  document.documentElement.classList.toggle('task-page', id==='task-view');
}
function setStage(id){
  currentStage=id;
  showView(id);
  writeProgress();
  refreshDebugStatus();
  startDebugStatus();
  if(currentSessionId&&id!=='complete-view')startSessionStatusCheck();
  if(id==='complete-view')stopSessionStatusCheck();
  if(id!=='queue-view')stopQueuePolling();
}
const STORAGE_KEY='hmcl-helper-progress-v1';
const ACTIVE_TAB_KEY='hmcl-helper-active-tab-v1';
const TAB_ID_KEY='hmcl-helper-tab-id-v1';
const TAB_CHANNEL_NAME='hmcl-helper-tab-control';
let tabId=sessionStorage.getItem(TAB_ID_KEY);
if(!tabId){
  tabId=(window.crypto&&crypto.randomUUID&&crypto.randomUUID())||`${Date.now()}-${Math.random().toString(16).slice(2)}`;
  sessionStorage.setItem(TAB_ID_KEY,tabId);
}
let tabChannel=null;
try{tabChannel=new BroadcastChannel(TAB_CHANNEL_NAME)}catch(e){tabChannel=null}
let currentStage='setup-view';
let chatTranscript=[];
let draftActionCounter=0;
const draftActionText=new Map();
document.documentElement.dataset.stage=currentStage;

function readProgress(){
  try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'null')}catch(e){return null}
}
function readActiveTab(){
  try{return JSON.parse(localStorage.getItem(ACTIVE_TAB_KEY)||'null')}catch(e){return null}
}
function sameSession(a,b){
  return a&&b&&String(a.participantId)===String(b.participantId)&&String(a.sessionId)===String(b.sessionId);
}
function currentSessionRef(){
  return participantId&&currentSessionId?{participantId,sessionId:currentSessionId}:null;
}
function progressSessionRef(progress){
  return progress&&progress.participantId&&progress.currentSessionId
    ? {participantId:progress.participantId,sessionId:progress.currentSessionId}
    : null;
}
function releaseSessionSlot(ref, beacon=false){
  if(!ref||!ref.participantId||!ref.sessionId)return Promise.resolve();
  const body=new URLSearchParams({participant_id:ref.participantId,session_id:String(ref.sessionId)});
  if(beacon&&navigator.sendBeacon){
    const blob=new Blob([body.toString()],{type:'application/x-www-form-urlencoded'});
    navigator.sendBeacon('/api/session/slot/release',blob);
    return Promise.resolve();
  }
  return fetch('/api/session/slot/release',{method:'POST',body,keepalive:true}).catch(()=>{});
}
function postTabControl(message){
  const payload={...message,tabId,nonce:`${Date.now()}-${Math.random().toString(16).slice(2)}`};
  try{tabChannel?.postMessage(payload)}catch(e){}
  try{localStorage.setItem(ACTIVE_TAB_KEY,JSON.stringify({...payload,updatedAt:Date.now()}))}catch(e){}
}
function claimTabOwnership(reason){
  const next=currentSessionRef();
  const previous=readActiveTab();
  const saved=progressSessionRef(readProgress());
  const releaseList=[];
  if(previous?.participantId&&previous?.sessionId&&!sameSession(previous,next)){
    releaseList.push({participantId:previous.participantId,sessionId:previous.sessionId});
  }
  if(saved&&!sameSession(saved,next)&&!releaseList.some(item=>sameSession(item,saved))){
    releaseList.push(saved);
  }
  for(const ref of releaseList)releaseSessionSlot(ref);
  postTabControl({
    type:'takeover',
    reason,
    participantId:next?.participantId||'',
    sessionId:next?.sessionId||0,
  });
}
function writeProgress(extra={}){
  if(!participantId)return;
  const previous=readProgress()||{};
  const currentDraft=$('draft-text')?.textContent||'';
  const currentForms=collectFormValues();
  const forms={...(previous.forms||{})};
  for(const [key,value] of Object.entries(currentForms)){
    if(value!==''&&value!==undefined&&value!==null)forms[key]=value;
  }
  const state={
    participantId,
    currentSessionId:currentSessionId||previous.currentSessionId,
    currentCondition:currentCondition||previous.currentCondition,
    currentStage,turnCounter,revisionCounter,taskStartTime,
    taskElapsedMs:taskStartTime?Math.max(0,Date.now()-taskStartTime):(previous.taskElapsedMs||0),
    aiWaiting:isAiWaiting,
    aiWaitStartedAt:isAiWaiting?(aiWaitStartedAt||previous.aiWaitStartedAt||Date.now()):0,
    aiWaitDeadlineAt:isAiWaiting?(aiWaitDeadlineAt||previous.aiWaitDeadlineAt||Date.now()+AI_WAIT_TIMEOUT_MS):0,
    draftText:currentDraft||previous.draftText||'',
    chatTranscript:chatTranscript.length?chatTranscript:(previous.chatTranscript||[]),
    forms,
    updatedAt:Date.now(),...extra
  };
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
}
function clearProgress(){localStorage.removeItem(STORAGE_KEY)}
async function discardSavedProgress(){
  const saved=pendingResumeProgress||readProgress();
  const ref=progressSessionRef(saved);
  if(ref)await releaseSessionSlot(ref);
  pendingResumeProgress=null;
  clearProgress();
  postTabControl({
    type:'takeover',
    reason:'discard',
    participantId:'',
    sessionId:0,
  });
}
function collectFormValues(){
  const values={};
  document.querySelectorAll('input,select,textarea').forEach(el=>{
    if(!el.name&&!el.id)return;
    const key=el.name||el.id;
    if(el.type==='radio'){
      if(el.checked)values[key]=el.value;
    }else if(el.type==='checkbox'){
      values[key]=el.checked;
    }else{
      values[key]=el.value;
    }
  });
  return values;
}
function restoreFormValues(values={}){
  document.querySelectorAll('input,select,textarea').forEach(el=>{
    const key=el.name||el.id;
    if(!(key in values))return;
    if(el.type==='radio')el.checked=el.value===values[key];
    else if(el.type==='checkbox')el.checked=!!values[key];
    else el.value=values[key];
  });
}
document.addEventListener('input',()=>writeProgress());
document.addEventListener('change',()=>writeProgress());

// ── Global state ──
let ws, participantId;
let currentSessionId, currentCondition;
let turnCounter = 0, revisionCounter = 0, taskStartTime = 0;
let timerInterval, expressionInterval, expressionWatchdogInterval, baselineInterval;
let aiSyncTimer = null;
let mediaRecorder, webcamStream, chunkIndex = 0;
let isAiWaiting = false;
let aiWaitStartedAt = 0;
let aiWaitDeadlineAt = 0;
let aiWaitTimeoutTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let intentionalWsClose = false;
let lastExpressionSentAt = 0;
let expressionFramePending = false;
let expressionFramePendingAt = 0;
let baselineFramePendingAt = 0;
let baselineRecoveryTimer = null;
let lastCaptureNoticeAt = 0;
let captureState = '';
let sessionStatusTimer = null;
let queuePollTimer = null;
let debugStatusTimer = null;
let timeoutSubmitRetryTimer = null;

let consentSignatureSaved = false;
let consentSignatureDrawing = false;
let consentSignatureTouched = false;

function setupConsentDate(){
  const el=$('consent-date-display');
  if(!el)return;
  const now=new Date();
  el.textContent=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}（系统自动记录）`;
}

function resizeSignatureCanvas(){
  const canvas=$('consent-signature-pad');
  if(!canvas)return null;
  const rect=canvas.getBoundingClientRect();
  const ratio=window.devicePixelRatio||1;
  canvas.width=Math.max(1,Math.floor(rect.width*ratio));
  canvas.height=Math.max(1,Math.floor(rect.height*ratio));
  const ctx=canvas.getContext('2d');
  ctx.setTransform(ratio,0,0,ratio,0,0);
  ctx.fillStyle='#fff';
  ctx.fillRect(0,0,rect.width,rect.height);
  ctx.lineWidth=2;
  ctx.lineCap='round';
  ctx.lineJoin='round';
  ctx.strokeStyle='#111827';
  return {canvas,ctx};
}

function signaturePoint(e){
  const canvas=$('consent-signature-pad');
  const rect=canvas.getBoundingClientRect();
  return {x:e.clientX-rect.left,y:e.clientY-rect.top};
}

function openConsentSignature(){
  $('consent-signature-overlay')?.classList.remove('hidden');
  consentSignatureTouched=false;
  resizeSignatureCanvas();
}

function closeConsentSignature(){
  $('consent-signature-overlay')?.classList.add('hidden');
  consentSignatureDrawing=false;
  consentSignatureTouched=false;
}

function clearConsentSignature(){
  resizeSignatureCanvas();
  consentSignatureTouched=false;
  consentSignatureSaved=false;
  const input=$('consent-signature-data');
  if(input)input.value='';
  const status=$('consent-signature-status');
  if(status)status.textContent='尚未签名';
  writeProgress();
}

function saveConsentSignature(){
  const canvas=$('consent-signature-pad');
  if(!canvas||!consentSignatureTouched){
    toast('请先在签名区域完成签名。',4000);
    return;
  }
  const input=$('consent-signature-data');
  if(input)input.value=canvas.toDataURL('image/png');
  consentSignatureSaved=true;
  const status=$('consent-signature-status');
  if(status)status.textContent='已签名';
  closeConsentSignature();
  writeProgress();
}

function refreshConsentSignatureStatus(){
  const input=$('consent-signature-data');
  const status=$('consent-signature-status');
  consentSignatureSaved=!!input?.value;
  if(status)status.textContent=consentSignatureSaved?'已签名':'尚未签名';
}

function initConsentSignature(){
  setupConsentDate();
  refreshConsentSignatureStatus();
  $('open-consent-signature')?.addEventListener('click',openConsentSignature);
  $('cancel-consent-signature')?.addEventListener('click',closeConsentSignature);
  $('clear-consent-signature')?.addEventListener('click',clearConsentSignature);
  $('save-consent-signature')?.addEventListener('click',saveConsentSignature);
  $('consent-signature-overlay')?.addEventListener('click',e=>{
    if(e.target===$('consent-signature-overlay'))closeConsentSignature();
  });
  const canvas=$('consent-signature-pad');
  if(!canvas)return;
  canvas.addEventListener('pointerdown',e=>{
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    consentSignatureDrawing=true;
    consentSignatureTouched=true;
    const ctx=canvas.getContext('2d');
    if(!ctx)return;
    const p=signaturePoint(e);
    ctx.beginPath();
    ctx.moveTo(p.x,p.y);
  });
  canvas.addEventListener('pointermove',e=>{
    if(!consentSignatureDrawing)return;
    e.preventDefault();
    const ctx=canvas.getContext('2d');
    const p=signaturePoint(e);
    ctx.lineTo(p.x,p.y);
    ctx.stroke();
  });
  const stop=e=>{
    if(!consentSignatureDrawing)return;
    consentSignatureDrawing=false;
    try{canvas.releasePointerCapture(e.pointerId)}catch(err){}
  };
  canvas.addEventListener('pointerup',stop);
  canvas.addEventListener('pointercancel',stop);
}

function validateConsentForm(){
  const missing=[...document.querySelectorAll('[name^="consent_item_"]')].filter(el=>!el.checked);
  if(missing.length){
    toast('请先勾选全部知情同意条款。',5000);
    missing[0].focus();
    return null;
  }
  const takerName=($('consent-taker-name')?.value||'').trim();
  if(!takerName){
    toast('请填写获取同意者姓名。',5000);
    $('consent-taker-name')?.focus();
    return null;
  }
  const signature=($('consent-signature-data')?.value||'').trim();
  if(!signature||!consentSignatureSaved){
    toast('请先点击“签名”并保存实验者签名。',5000);
    openConsentSignature();
    return null;
  }
  return {takerName,signature};
}
let pendingResumeProgress = null;
const AI_WAIT_TIMEOUT_MS = 75000;
const AI_RECOVERY_GRACE_MS = 12000;
const BASELINE_FACE_TOAST_MS = 5000;
const FRAME_ACK_TIMEOUT_MS = 8000;

const TASK_PROMPT_HTML = '<strong>情境</strong><br>你的电脑意外关机，期末项目数据全部丢失，今天就是截止日。请与 AI 协作写一封邮件向教授请求短期延期。';
const recordingDrawer = $('webcam-wrap');
const recordingStorageKey = 'hmcl-recording-drawer-top-v2';
let recordingPeekTimer = null;

function restoreTaskStartTime(saved={}){
  const explicit=Number(saved.taskStartTime);
  if(Number.isFinite(explicit)&&explicit>0)return explicit;
  const elapsed=Number(saved.taskElapsedMs);
  if(Number.isFinite(elapsed)&&elapsed>0)return Date.now()-elapsed;
  const updated=Number(saved.updatedAt);
  if(Number.isFinite(updated)&&updated>0)return updated;
  return Date.now();
}

function clampRecordingTop(top){
  if(!recordingDrawer)return top;
  const footerHeight=document.querySelector('.site-footer')?.offsetHeight||48;
  const margin=8;
  const drawerHeight=recordingDrawer.offsetHeight||148;
  const minTop=margin;
  const maxTop=Math.max(minTop, window.innerHeight-footerHeight-drawerHeight-margin);
  return Math.min(Math.max(top,minTop),maxTop);
}

function setRecordingTop(top,persist=false){
  if(!recordingDrawer)return;
  const nextTop=clampRecordingTop(top);
  recordingDrawer.style.setProperty('--recording-drawer-top',`${nextTop}px`);
  recordingDrawer.style.bottom='auto';
  if(persist)localStorage.setItem(recordingStorageKey,String(nextTop));
}

function getDefaultRecordingTop(){
  if(!recordingDrawer)return 0;
  const footerHeight=document.querySelector('.site-footer')?.offsetHeight||48;
  const drawerHeight=recordingDrawer.offsetHeight||148;
  return window.innerHeight-footerHeight-drawerHeight-32;
}

function initRecordingDrawer(){
  if(!recordingDrawer)return;
  const savedTop=Number(localStorage.getItem(recordingStorageKey));
  const defaultTop=getDefaultRecordingTop();
  setRecordingTop(Number.isFinite(savedTop)&&savedTop>0?savedTop:defaultTop);

  let dragStartY=0;
  let dragStartTop=0;
  recordingDrawer.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    dragStartY=event.clientY;
    dragStartTop=recordingDrawer.getBoundingClientRect().top;
    recordingDrawer.classList.add('dragging');
    recordingDrawer.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  recordingDrawer.addEventListener('pointermove',event=>{
    if(!recordingDrawer.classList.contains('dragging'))return;
    setRecordingTop(dragStartTop+event.clientY-dragStartY);
  });
  function finishDrag(event){
    if(!recordingDrawer.classList.contains('dragging'))return;
    recordingDrawer.classList.remove('dragging');
    if(recordingDrawer.hasPointerCapture(event.pointerId)){
      recordingDrawer.releasePointerCapture(event.pointerId);
    }
    setRecordingTop(recordingDrawer.getBoundingClientRect().top,true);
  }
  recordingDrawer.addEventListener('pointerup',finishDrag);
  recordingDrawer.addEventListener('pointercancel',finishDrag);
  window.addEventListener('resize',()=>setRecordingTop(recordingDrawer.getBoundingClientRect().top,true));
}

function peekRecordingDrawer(duration=2000){
  if(!recordingDrawer||recordingDrawer.classList.contains('hidden'))return;
  clearTimeout(recordingPeekTimer);
  recordingDrawer.classList.add('peek');
  recordingPeekTimer=setTimeout(()=>{
    recordingDrawer.classList.remove('peek');
  },duration);
}

// ── Toast ──
function toast(msg, duration=3000, kind='', tone='err'){
  const el = document.createElement('div');el.className=`toast ${tone}`;el.textContent=msg;
  if(kind)el.dataset.kind=kind;
  if(duration>0)el.style.setProperty('--toast-duration',`${duration}ms`);
  else el.classList.add('sticky');
  $('toast-container').appendChild(el);
  if(duration>0)setTimeout(()=>dismissToast(el),duration);
  return el;
}
function dismissToast(el){
  if(!el||el.classList.contains('leaving'))return;
  el.classList.add('leaving');
  setTimeout(()=>el.remove(),220);
}
function clearToasts(kind){
  const selector=kind?`.toast[data-kind="${kind}"]`:'.toast';
  document.querySelectorAll(selector).forEach(el=>el.remove());
}

// ── Participant debug panel ──
const DEBUG_PANEL_ENABLED = false;
let debugFrameStats = [];
function debugEl(id){return document.getElementById(id)}
function debugTime(){
  const d=new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
function average(values){
  return values.length?values.reduce((sum,value)=>sum+value,0)/values.length:0;
}
function percentile(values,pct){
  if(!values.length)return 0;
  const sorted=[...values].sort((a,b)=>a-b);
  const index=Math.min(sorted.length-1,Math.ceil(sorted.length*pct)-1);
  return sorted[index];
}
function updateDebugMetrics(){
  if(!DEBUG_PANEL_ENABLED)return;
  const waits=debugFrameStats.map(item=>item.queued_ms);
  const runs=debugFrameStats.map(item=>item.elapsed_ms);
  const timeouts=debugFrameStats.filter(item=>item.drop_reason==='queue_timeout').length;
  debugEl('debug-avg-wait').textContent=waits.length?`${average(waits).toFixed(0)}ms`:'-';
  debugEl('debug-p95-wait').textContent=waits.length?`${percentile(waits,0.95).toFixed(0)}ms`:'-';
  debugEl('debug-avg-run').textContent=runs.length?`${average(runs).toFixed(0)}ms`:'-';
  debugEl('debug-timeout-count').textContent=String(timeouts);
  debugEl('debug-frame-count').textContent=String(debugFrameStats.length);
}
function setDebugStatus(text,tone=''){
  const el=debugEl('debug-status-pill');
  if(!el)return;
  el.textContent=text;
  el.className=tone;
}
function appendDebugLog(kind,msg={}){
  if(!DEBUG_PANEL_ENABLED)return;
  const log=debugEl('debug-log');
  if(!log)return;
  const queuedRaw=Number(msg.queued_ms||0);
  const elapsedRaw=Number(msg.elapsed_ms||0);
  const queued=queuedRaw.toFixed(1);
  const elapsed=elapsedRaw.toFixed(1);
  const reason=msg.drop_reason?` ${msg.drop_reason}`:'';
  const ok=msg.reliable!==false&&!msg.drop_reason;
  debugFrameStats.push({
    kind,
    queued_ms: queuedRaw,
    elapsed_ms: elapsedRaw,
    drop_reason: msg.drop_reason||'',
  });
  updateDebugMetrics();
  const line=document.createElement('div');
  line.className=`debug-line ${ok?'ok':'warn'}`;
  line.innerHTML=`
    <span>${debugTime()}</span>
    <strong>${kind}</strong>
    <span>wait ${queued}ms · run ${elapsed}ms${reason}</span>
  `;
  log.prepend(line);
  while(log.children.length>80)log.lastElementChild.remove();
  setDebugStatus(ok?'ok':'warn',ok?'ok':'warn');
}
function isDroppedFrameStatus(msg={}){
  return ['queue_timeout','scheduler_stop','pyfeat_run_timeout'].includes(msg.drop_reason||'');
}
function renderDebugSlot(data={}){
  if(!DEBUG_PANEL_ENABLED)return;
  debugEl('debug-participant').textContent=participantId||'-';
  debugEl('debug-session').textContent=currentSessionId?`#${currentSessionId}`:'-';
  debugEl('debug-stage').textContent=currentStage||'-';
  debugEl('debug-slot').textContent=data.state||'-';
  debugEl('debug-wait').textContent=data.estimated_wait_s!==undefined?formatWait(data.estimated_wait_s):'-';
  debugEl('debug-active').textContent=`${data.active_count??0}/${data.max_active??2}`;
  debugEl('debug-queue').textContent=String(data.queue_length??0);
  const active=Array.isArray(data.active_slots)?data.active_slots:[];
  const queued=Array.isArray(data.queued_slots)?data.queued_slots:[];
  const activeText=active.map(s=>`${s.participant_id} #${s.session_id} ${s.phase} ${formatWait(s.remaining_s)}`);
  const queuedText=queued.map(s=>`Q${s.position} ${s.participant_id} #${s.session_id} wait ${formatWait(s.estimated_wait_s)}`);
  debugEl('debug-lanes').textContent=[...activeText,...queuedText].join(' | ')||'No active experiment slots.';
}
async function refreshDebugStatus(){
  if(!DEBUG_PANEL_ENABLED)return;
  renderDebugSlot({});
  if(!participantId||!currentSessionId)return;
  try{
    const data=await fetchQueueStatus();
    if(data)renderDebugSlot(data);
  }catch(err){}
}
function startDebugStatus(){
  if(!DEBUG_PANEL_ENABLED)return;
  if(debugStatusTimer)return;
  refreshDebugStatus();
  debugStatusTimer=setInterval(refreshDebugStatus,1000);
}
function stopDebugStatus(){
  if(!DEBUG_PANEL_ENABLED)return;
  if(debugStatusTimer){clearInterval(debugStatusTimer);debugStatusTimer=null}
}
debugEl('participant-debug-toggle')?.addEventListener('click',()=>{
  debugEl('participant-debug')?.classList.toggle('collapsed');
});

// ── Build Likert ──
document.querySelectorAll('.likert-line').forEach(row=>{
  for(let v=1;v<=7;v++){
    const lbl=document.createElement('label');lbl.className='likert-dot';
    const label=v===1?'1 - 非常不同意':(v===7?'非常同意 - 7':String(v));
    lbl.innerHTML=`<input type="radio" name="${row.id}" value="${v}"><div class="dot"></div><span class="dot-label">${label}</span>`;
    row.appendChild(lbl);
  }
});

// ── WebSocket ──
function connectWS(){
  return new Promise((resolve, reject) => {
    if(ws&&ws.readyState===WebSocket.OPEN){resolve();return;}
    let settled=false;
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${wsProtocol}//${location.host}/ws/${participantId}`);
    ws.onopen = () => {
      console.log('[WS] Connected');
      intentionalWsClose=false;
      expressionFramePending=false;
      expressionFramePendingAt=0;
      baselineFramePending=false;
      baselineFramePendingAt=0;
      reconnectAttempts=0;
      clearToasts('connection');
      if(currentSessionId)ws.send(JSON.stringify({type:'session_init',session_id:currentSessionId}));
      if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null;}
      settled=true;
      resolve();
    };
    ws.onerror = (err) => {
      console.error('[WS] Connection error:', err);
      if(!settled){
        settled=true;
        reject(new Error('WebSocket connection failed'));
      }
    };
    ws.onclose = (e) => {
      console.log('[WS] Closed:', e.code, e.reason);
      expressionFramePending=false;
      expressionFramePendingAt=0;
      baselineFramePending=false;
      baselineFramePendingAt=0;
      const intentional= intentionalWsClose || e.reason==='task complete';
      intentionalWsClose=false;
      if(intentional){
        clearToasts('connection');
        return;
      }
      if(currentStage==='task-view')setCapturePaused('连接恢复中',true);
      if(isAiWaiting){
        updateThinking('连接中断，正在恢复...');
        startAiSyncPolling();
        armAiWaitTimeout();
      }
      if(e.code!==1000)scheduleReconnect();
    };
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if(msg.type==='baseline_ack'){
        baselineFramePending=false;
        baselineFramePendingAt=0;
        appendDebugLog('base',msg);
        baselineAckedCount=msg.collected;
        const pct=Math.min(100,(msg.collected/10)*100);
        $('baseline-bar').style.width=pct+'%';
        $('baseline-count').textContent=msg.collected;
        if(currentStage==='baseline-view'&&!isDroppedFrameStatus(msg)&&(msg.face_detected===false||msg.reliable===false)){
          showBaselineFaceToast();
        }
        if(msg.collected>=10 && !baselineDone && !baselineCalibrating){
          baselineDone=true;clearInterval(baselineInterval);finishBaseline();
        }
      }
      if(msg.type==='baseline_calibrated'){
        baselineCalibrating=false;
        if(msg.ok){
          startTask();
        }else{
          baselineDone=false;
          baselineAckedCount=0;
          baselineSentCount=0;
          baselineFaceToastVisible=false;
          $('baseline-bar').style.width='0%';
          $('baseline-count').textContent='0';
          showBaselineFaceToast();
          setFaceLost();
          setTimeout(()=>{
            if(currentStage==='baseline-view')startBaseline();
          },1000);
        }
      }
      if(msg.type==='ai_response'){
        isAiWaiting=false;
        aiWaitStartedAt=0;
        aiWaitDeadlineAt=0;
        clearAiWaitTimeout();
        stopAiSyncPolling();
        removeThinking();
        appendChat('ai',msg.text);
        $('turn-num').textContent=msg.turn;
        turnCounter=msg.turn;
        if(msg.revision)revisionCounter=msg.revision;
        $('rev-num').textContent=revisionCounter;
        extractDraft(msg.text);
      }
      if(msg.type==='chat_sync'){
        applyChatSync(msg);
      }
      if(msg.type==='session_missing'){
        forceRestartExperiment();
      }
      if(msg.type==='ai_wait'){
        updateThinking();
        armAiWaitTimeout();
      }
      if(msg.type==='prompt'){
        toast(msg.message,4000);
      }
      if(msg.type==='slot_status'){
        handleSlotStatus(msg);
      }
      if(msg.type==='face_status'){
        expressionFramePending=false;
        expressionFramePendingAt=0;
        appendDebugLog('expr',msg);
        if(isDroppedFrameStatus(msg)){
          return;
        }
        captureState='';
        if(msg.face_detected&&msg.reliable){
          setFaceStatus('found','面部已检测');
        }else if(msg.face_detected){
          setFaceStatus('lost','头部角度不佳');
        }else{
          setFaceStatus('lost','未检测到面部');
        }
      }
    };
    // Timeout after 5 seconds
    setTimeout(() => {
      if(ws.readyState !== WebSocket.OPEN) {
        try{ws.close();}catch(e){}
        if(!settled){
          settled=true;
          reject(new Error('WebSocket connection timeout'));
        }
      }
    }, 15000);
  });
}

function scheduleReconnect(){
  if(!participantId||reconnectTimer)return;
  reconnectAttempts++;
  toast('连接中断，正在自动重连...',4000,'connection');
  const delay=Math.min(30000,1000*Math.pow(2,Math.min(reconnectAttempts,5)));
  reconnectTimer=setTimeout(async()=>{
    reconnectTimer=null;
    try{
      await connectWS();
      clearToasts('connection');
      toast('连接已恢复。',2000,'connection','ok');
    }catch(e){
      scheduleReconnect();
    }
  },delay);
}

// ── Webcam ──
function recoverBaselineAckTimeout(){
  if(currentStage!=='baseline-view'||baselineRecoveryTimer)return;
  baselineFramePending=false;
  baselineFramePendingAt=0;
  clearInterval(baselineInterval);baselineInterval=null;
  toast('基线校准响应超时，正在重新连接...',4000,'connection','info');
  try{
    if(ws&&ws.readyState!==WebSocket.CLOSED)ws.close(4000,'baseline ack timeout');
  }catch(e){}
  baselineRecoveryTimer=setTimeout(async()=>{
    baselineRecoveryTimer=null;
    if(currentStage==='baseline-view'){
      await startBaseline();
    }
  },800);
}
function recoverExpressionAckTimeout(){
  if(currentStage!=='task-view')return;
  expressionFramePending=false;
  expressionFramePendingAt=0;
  setCapturePaused('连接恢复中',true);
  try{
    if(ws&&ws.readyState!==WebSocket.CLOSED)ws.close(4001,'expression ack timeout');
  }catch(e){}
  scheduleReconnect();
}
async function checkModelReady(){
  try{
    const r=await fetch('/api/model-health',{cache:'no-store'});
    const d=await r.json();
    if(d.ok)return true;
  }catch(e){}
  toast('模型未启动，请联系管理员。',0);
  return false;
}

async function startWebcam(){
  const stream=await navigator.mediaDevices.getUserMedia({video:{width:640,height:480,frameRate:15},audio:false});
  webcamStream=stream;
  $('webcam').srcObject=stream;
  $('webcam-wrap').classList.remove('hidden');
  // Wait for video to actually start playing (first frame rendered)
  await new Promise(resolve => {
    const v = $('webcam');
    if(v.readyState >= 2) { resolve(); return; }
    v.addEventListener('loadeddata', resolve, {once: true});
    // Fallback: resolve after 2 seconds even if event doesn't fire
    setTimeout(resolve, 2000);
  });
  document.querySelector('.camera-mock')?.classList.remove('camera-off');
  document.querySelector('.camera-mock')?.classList.add('camera-on');
  mediaRecorder=new MediaRecorder(stream,{mimeType:'video/webm'});
  mediaRecorder.ondataavailable=async e=>{
    if(e.data.size>0){
      const f=new FormData();
      f.append('participant_id',participantId);f.append('session_id',currentSessionId);
      f.append('chunk_index',chunkIndex++);f.append('chunk',e.data);
      fetch('/api/video-chunk',{method:'POST',body:f}).catch(()=>{});
    }
  };
  mediaRecorder.start(10000);
}
function startRecordingCapture(){
  if(mediaRecorder||!webcamStream)return;
  mediaRecorder=new MediaRecorder(webcamStream,{mimeType:'video/webm'});
  mediaRecorder.ondataavailable=async e=>{
    if(e.data.size>0){
      const f=new FormData();
      f.append('participant_id',participantId);f.append('session_id',currentSessionId);
      f.append('chunk_index',chunkIndex++);f.append('chunk',e.data);
      fetch('/api/video-chunk',{method:'POST',body:f}).catch(()=>{});
    }
  };
  mediaRecorder.start(10000);
}
function startExpressionCapture(){
  clearInterval(expressionInterval);
  expressionInterval=setInterval(()=>{
    if(currentStage!=='task-view')return;
    if(expressionFramePending){
      if(Date.now()-expressionFramePendingAt>FRAME_ACK_TIMEOUT_MS){
        recoverExpressionAckTimeout();
      }
      return;
    }
    if(isAiWaiting){
      setFaceStatus('found','面部已检测');
      return;
    }
    if(!ws||ws.readyState!==WebSocket.OPEN){
      setCapturePaused('连接恢复中',true);
      scheduleReconnect();
      return;
    }
    const frame=captureFrame();
    if(!frame){
      setCapturePaused('摄像头中断',true);
      return;
    }
    expressionFramePending=true;
    expressionFramePendingAt=Date.now();
    ws.send(JSON.stringify({type:'expression_frame',frame}));
    lastExpressionSentAt=Date.now();
  },500);
  startExpressionWatchdog();
}
function pauseTaskCapture(){
  clearInterval(expressionInterval);
  clearInterval(expressionWatchdogInterval);
  expressionInterval=null;
  expressionWatchdogInterval=null;
  if(mediaRecorder&&mediaRecorder.state!=='inactive'){
    mediaRecorder.ondataavailable=null;
    mediaRecorder.stop();
  }
  mediaRecorder=null;
  expressionFramePending=false;
  expressionFramePendingAt=0;
  baselineFramePendingAt=0;
}
function resumeTaskCapture(){
  startRecordingCapture();
  startExpressionCapture();
}
function renderRestoredChat(){
  if(!chatTranscript.length)return;
  $('chat-area').innerHTML='';
  for(const msg of chatTranscript)appendChat(msg.role,msg.text,false);
}
function renderTaskMeta(){
  $('task-label').textContent='写作任务';
  if(currentCondition){
    $('condition-badge').textContent=currentCondition==='affect-aware'?'情感感知 AI':'纯文本 AI';
    $('condition-badge').style.background=currentCondition==='affect-aware'?'#e0e7ff':'#f1f5f9';
    $('condition-badge').style.color=currentCondition==='affect-aware'?'#4f46e5':'#64748b';
  }
  $('task-prompt').innerHTML=TASK_PROMPT_HTML;
}
function applyChatSync(msg){
  const messages=Array.isArray(msg.messages)?msg.messages:[];
  if(currentStage!=='task-view'||messages.length<chatTranscript.length)return;
  const incoming=messages.map(m=>({role:m.role,text:m.text||''}));
  const changed=incoming.length!==chatTranscript.length||incoming.some((m,i)=>m.role!==chatTranscript[i]?.role||m.text!==chatTranscript[i]?.text);
  if(msg.session_id)currentSessionId=msg.session_id;
  if(msg.condition)currentCondition=msg.condition;
  renderTaskMeta();
  chatTranscript=incoming;
  if(changed)renderRestoredChat();
  if(msg.turn!==undefined){
    turnCounter=msg.turn;
    $('turn-num').textContent=turnCounter;
  }
  if(msg.revision!==undefined){
    revisionCounter=msg.revision;
    $('rev-num').textContent=revisionCounter;
  }
  const last=chatTranscript[chatTranscript.length-1];
  if(last&&last.role==='ai'){
    isAiWaiting=false;
    aiWaitStartedAt=0;
    aiWaitDeadlineAt=0;
    clearAiWaitTimeout();
    stopAiSyncPolling();
    removeThinking();
    const draft=parseDraft(last.text);
    if(draft){
      $('draft-text').textContent=draft;
      $('draft-panel').classList.remove('hidden');
    }
  }else if(isAiWaiting){
    ensureThinking();
    armAiWaitTimeout();
  }
  writeProgress();
}

async function fetchChatSync(){
  if(!participantId||!currentSessionId||currentStage!=='task-view')return;
  try{
    const params=new URLSearchParams({participant_id:participantId});
    const r=await fetch(`/api/session/sync/${currentSessionId}?${params.toString()}`,{cache:'no-store'});
    if(r.status===404){forceRestartExperiment();return;}
    if(!r.ok)return;
    const data=await r.json();
    applyChatSync(data);
  }catch(err){
    console.warn('[sync] chat sync failed',err);
  }
}
function startAiSyncPolling(){
  if(aiSyncTimer)return;
  fetchChatSync();
  aiSyncTimer=setInterval(fetchChatSync,3000);
}
function stopAiSyncPolling(){
  if(aiSyncTimer){clearInterval(aiSyncTimer);aiSyncTimer=null}
}
function clearAiWaitTimeout(){
  if(aiWaitTimeoutTimer){clearTimeout(aiWaitTimeoutTimer);aiWaitTimeoutTimer=null}
}
function armAiWaitTimeout(timeoutMs=null){
  clearAiWaitTimeout();
  if(!isAiWaiting||currentStage!=='task-view')return;
  if(!aiWaitDeadlineAt){
    aiWaitDeadlineAt=Date.now()+(timeoutMs??AI_WAIT_TIMEOUT_MS);
  }
  const delay=Math.max(1000,aiWaitDeadlineAt-Date.now());
  aiWaitTimeoutTimer=setTimeout(handleAiWaitTimeout,delay);
}
function startAiWaiting(startedAt=Date.now(), timeoutMs=AI_WAIT_TIMEOUT_MS){
  isAiWaiting=true;
  aiWaitStartedAt=startedAt||Date.now();
  aiWaitDeadlineAt=Date.now()+timeoutMs;
  showThinking();
  startAiSyncPolling();
  armAiWaitTimeout();
  writeProgress();
}
function finishAiWaiting(){
  isAiWaiting=false;
  aiWaitStartedAt=0;
  aiWaitDeadlineAt=0;
  clearAiWaitTimeout();
  stopAiSyncPolling();
  removeThinking();
  writeProgress({aiWaiting:false,aiWaitStartedAt:0,aiWaitDeadlineAt:0});
}
function handleAiWaitTimeout(){
  aiWaitTimeoutTimer=null;
  if(!isAiWaiting||currentStage!=='task-view')return;
  isAiWaiting=false;
  aiWaitStartedAt=0;
  aiWaitDeadlineAt=0;
  stopAiSyncPolling();
  removeThinking();
  toast('AI 回复暂时没有返回，已恢复输入。请检查网络后继续发送。',6500,'ai-timeout');
  if(!ws||ws.readyState!==WebSocket.OPEN)scheduleReconnect();
  writeProgress({aiWaiting:false,aiWaitStartedAt:0,aiWaitDeadlineAt:0});
}
function closeWS(){
  if(ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING)){
    intentionalWsClose=true;
    try{ws.close(1000,'task complete')}catch(e){}
  }
  ws=null;
}
function releaseCurrentSlotOnLeave(){
  if(['queue-view','baseline-view','task-view'].includes(currentStage)){
    releaseSessionSlot(currentSessionRef(),true);
  }
}
window.addEventListener('pagehide',releaseCurrentSlotOnLeave);
function stopSessionStatusCheck(){
  if(sessionStatusTimer){clearInterval(sessionStatusTimer);sessionStatusTimer=null}
}
function startSessionStatusCheck(){
  if(sessionStatusTimer||!participantId||!currentSessionId)return;
  verifySessionExists();
  sessionStatusTimer=setInterval(verifySessionExists,5000);
}
async function verifySessionExists(){
  if(!participantId||!currentSessionId||currentStage==='complete-view')return;
  try{
    const params=new URLSearchParams({participant_id:participantId});
    const r=await fetch(`/api/session/status/${currentSessionId}?${params.toString()}`,{cache:'no-store'});
    if(r.status===404)forceRestartExperiment();
    if(!r.ok)return;
    const data=await r.json();
    if(data.completed&&currentStage==='task-view'){
      finalSubmitting=false;
      clearTimeoutSubmitRetry();
      clearInterval(timerInterval);timerInterval=null;
      clearInterval(expressionInterval);expressionInterval=null;
      pauseTaskCapture();
      stopAiSyncPolling();
      closeWS();
      setStage('questionnaire-view');
    }
  }catch(err){}
}
function clearTimeoutSubmitRetry(){
  if(timeoutSubmitRetryTimer){clearTimeout(timeoutSubmitRetryTimer);timeoutSubmitRetryTimer=null}
}
function scheduleTimeoutSubmitRetry(){
  if(timeoutSubmitRetryTimer||currentStage!=='task-view')return;
  timeoutSubmitRetryTimer=setTimeout(()=>{
    timeoutSubmitRetryTimer=null;
    if(currentStage==='task-view'&&!finalSubmitting){
      doFinalSubmit(true);
    }
  },3000);
}
function forceRestartExperiment(){
  stopSessionStatusCheck();
  stopQueuePolling();
  stopDebugStatus();
  clearTimeoutSubmitRetry();
  debugFrameStats=[];
  updateDebugMetrics();
  stopAiSyncPolling();
  clearAiWaitTimeout();
  isAiWaiting=false;
  aiWaitStartedAt=0;
  aiWaitDeadlineAt=0;
  clearInterval(timerInterval);
  clearInterval(baselineInterval);
  pauseTaskCapture();
  closeWS();
  if(webcamStream){
    webcamStream.getTracks().forEach(track=>track.stop());
    webcamStream=null;
  }
  clearProgress();
  location.replace(location.pathname);
}
function stopForOtherTabOwner(message={}){
  if(message.tabId===tabId)return;
  const next={participantId:message.participantId,sessionId:message.sessionId};
  const own=currentSessionRef()||progressSessionRef(pendingResumeProgress)||progressSessionRef(readProgress());
  stopSessionStatusCheck();
  stopQueuePolling();
  stopDebugStatus();
  clearTimeoutSubmitRetry();
  stopAiSyncPolling();
  clearAiWaitTimeout();
  clearInterval(timerInterval);
  clearInterval(baselineInterval);
  pauseTaskCapture();
  closeWS();
  if(webcamStream){
    webcamStream.getTracks().forEach(track=>track.stop());
    webcamStream=null;
  }
  if(own&&!sameSession(own,next))releaseSessionSlot(own);
  pendingResumeProgress=null;
  $('resume-overlay')?.classList.add('hidden');
  currentStage='duplicate-tab-view';
  showView('duplicate-tab-view');
}
function handleTabControlMessage(message={}){
  if(message.type==='takeover')stopForOtherTabOwner(message);
}
if(tabChannel){
  tabChannel.onmessage=e=>handleTabControlMessage(e.data||{});
}
window.addEventListener('storage',e=>{
  if(e.key!==ACTIVE_TAB_KEY||!e.newValue)return;
  try{handleTabControlMessage(JSON.parse(e.newValue))}catch(err){}
});
async function resumeProgress(saved){
  participantId=saved.participantId;
  currentSessionId=saved.currentSessionId;
  claimTabOwnership('resume');
  if(currentSessionId)startSessionStatusCheck();
  currentCondition=saved.currentCondition;
  currentStage=saved.currentStage||'setup-view';
  if(currentStage==='break-view')currentStage='complete-view';
  if(currentStage==='post-survey-view')currentStage='questionnaire-view';
  turnCounter=saved.turnCounter||0;
  revisionCounter=saved.revisionCounter||0;
  taskStartTime=restoreTaskStartTime(saved);
  chatTranscript=Array.isArray(saved.chatTranscript)?saved.chatTranscript:[];
  restoreFormValues(saved.forms||{});
  refreshConsentSignatureStatus();
  let cameraReady=true;
  if(['pre-survey-view','queue-view','baseline-view','task-view'].includes(currentStage)){
    try{await startWebcam();}catch(err){cameraReady=false;toast('无法访问摄像头。请允许摄像头权限并确保没有其他程序占用摄像头。',6000);}
  }
  if(currentStage==='queue-view'){
    showView(currentStage);
    await startQueuePolling();
    writeProgress();
    return;
  }
  if(currentStage==='baseline-view'&&cameraReady){
    await startBaseline();
    writeProgress();
    return;
  }
  showView(currentStage);
  if(currentStage==='task-view'){
    renderTaskMeta();
    $('draft-text').textContent=saved.draftText||'';
    $('draft-panel').classList.remove('hidden');
    renderRestoredChat();
    $('turn-num').textContent=turnCounter;
    $('rev-num').textContent=revisionCounter;
    const last=chatTranscript[chatTranscript.length-1];
    if(last&&last.role==='user'){
      const savedWaitStarted=Number(saved.aiWaitStartedAt)||Number(saved.updatedAt)||Date.now();
      const savedDeadline=Number(saved.aiWaitDeadlineAt);
      const elapsed=Math.max(0,Date.now()-savedWaitStarted);
      const waitMs=Number.isFinite(savedDeadline)&&savedDeadline>Date.now()
        ? savedDeadline-Date.now()
        : (elapsed>=AI_WAIT_TIMEOUT_MS?AI_RECOVERY_GRACE_MS:AI_WAIT_TIMEOUT_MS-elapsed);
      startAiWaiting(savedWaitStarted,waitMs);
      if(elapsed>=AI_WAIT_TIMEOUT_MS){
        toast('正在尝试恢复上次 AI 回复，若仍无返回会恢复输入。',5000,'ai-timeout','info');
      }
    }
    lastExpressionSentAt=Date.now();
    captureState='';
    try{await connectWS();}catch(err){console.error('Resume websocket failed:',err);scheduleReconnect();}
    startExpressionCapture();
    timerInterval=setInterval(updateTimer,1000);
  }
  writeProgress();
}
function initProgressRecovery(){
  const saved=readProgress();
  if(!saved||!saved.participantId)return;
  if(saved.completed){
    clearProgress();
    currentStage='setup-view';
    showView('setup-view');
    return;
  }
  pendingResumeProgress=saved;
  $('resume-overlay')?.classList.remove('hidden');
}
function webcamLive(){
  const stream=$('webcam').srcObject||webcamStream;
  const track=stream&&stream.getVideoTracks&&stream.getVideoTracks()[0];
  const v=$('webcam');
  return !!(track&&track.readyState==='live'&&track.enabled&&!track.muted&&v.readyState>=2&&v.videoWidth&&v.videoHeight);
}
function setFaceStatus(kind,text){
  const el=$('face-status');
  const txt=$('face-status-text');
  if(el&&txt){el.className=kind;txt.textContent=text}
}
function setFaceLost(){
  setFaceStatus('lost','未检测到面部');
}
function setCapturePaused(reason, notify=false){
  if(captureState!==reason){
    captureState=reason;
    setFaceStatus('paused',reason);
  }
  if(notify&&Date.now()-lastCaptureNoticeAt>8000){
    lastCaptureNoticeAt=Date.now();
    toast(reason,2500);
  }
}
function startExpressionWatchdog(){
  clearInterval(expressionWatchdogInterval);
  expressionWatchdogInterval=setInterval(()=>{
    if(currentStage!=='task-view')return;
    if(!webcamLive()){
      setCapturePaused('摄像头中断',true);
      return;
    }
    if(!ws||ws.readyState!==WebSocket.OPEN){
      setCapturePaused('连接恢复中',true);
      scheduleReconnect();
      return;
    }
    if(isAiWaiting){
      setFaceStatus('found','面部已检测');
      return;
    }
    if(!expressionInterval||Date.now()-lastExpressionSentAt>3000){
      setCapturePaused('采集恢复中',true);
      startExpressionCapture();
    }
  },2000);
}
function captureFrame(){
  if(!webcamLive()){
    setFaceLost();
    return "";
  }
  const v=$('webcam');
  const w=v.videoWidth||640;
  const h=v.videoHeight||480;
  const c=document.createElement('canvas');c.width=w;c.height=h;
  c.getContext('2d').drawImage(v,0,0,w,h);
  return c.toDataURL('image/jpeg',0.7);
}

// ── Experiment queue ──
function formatWait(seconds){
  const total=Math.max(0,Math.ceil(Number(seconds)||0));
  const m=Math.floor(total/60);
  const s=total%60;
  return `${m}:${String(s).padStart(2,'0')}`;
}
function renderQueueStatus(data={}){
  renderDebugSlot(data);
  $('queue-estimate').textContent=formatWait(data.estimated_wait_s);
  $('queue-position').textContent=data.position||'-';
  $('queue-active').textContent=`${data.active_count||0}/${data.max_active||2}`;
  $('queue-length').textContent=data.queue_length||0;
  const wait=Number(data.estimated_wait_s)||0;
  const pct=wait>0?Math.max(4,Math.min(96,100-(wait/900*100))):100;
  $('queue-bar').style.width=`${pct}%`;
  $('queue-note').textContent=data.state==='queued'
    ? '请耐心等待，轮到您时会自动开始基线校准。'
    : '正在为您准备基线校准。';
}
function stopQueuePolling(){
  if(queuePollTimer){clearInterval(queuePollTimer);queuePollTimer=null}
}
async function handleSlotStatus(data={}){
  baselineFramePending=false;
  baselineFramePendingAt=0;
  expressionFramePending=false;
  expressionFramePendingAt=0;
  clearInterval(baselineInterval);baselineInterval=null;
  pauseTaskCapture();
  if(!['queue-view','baseline-view','task-view'].includes(currentStage))return;
  if(data.state==='queued'){
    await startQueuePolling(data);
    return;
  }
  if(data.state!=='active'){
    await requestExperimentSlot();
  }
}
async function fetchQueueStatus(){
  if(!participantId||!currentSessionId)return null;
  const params=new URLSearchParams({participant_id:participantId});
  const r=await fetch(`/api/session/slot/status/${currentSessionId}?${params.toString()}`,{cache:'no-store'});
  if(r.status===404){forceRestartExperiment();return null;}
  if(!r.ok)return null;
  return await r.json();
}
async function startQueuePolling(initial=null){
  if(initial)renderQueueStatus(initial);
  setStage('queue-view');
  stopQueuePolling();
  const tick=async()=>{
    try{
      const data=await fetchQueueStatus();
      if(!data)return;
      renderQueueStatus(data);
      if(data.state==='active'){
        stopQueuePolling();
        await startBaseline();
      }
    }catch(err){
      $('queue-note').textContent='等待信息暂时无法刷新，系统会继续重试。';
    }
  };
  queuePollTimer=setInterval(tick,1000);
  await tick();
}
async function requestExperimentSlot(){
  const f=new FormData();
  f.append('participant_id',participantId);
  f.append('session_id',currentSessionId);
  const r=await fetch('/api/session/slot/request',{method:'POST',body:f});
  if(!r.ok){
    const d=await r.json().catch(()=>({}));
    throw new Error(d.detail||`slot request failed: ${r.status}`);
  }
  const data=await r.json();
  if(data.state==='active'){
    await startBaseline();
  }else{
    await startQueuePolling(data);
  }
}

// ── Baseline ──
let baselineSentCount = 0;
let baselineAckedCount = 0;
let baselineDone = false;
let baselineSendComplete = false;
let baselineCalibrating = false;
let baselineFaceToastVisible = false;
let baselineFramePending = false;
function showBaselineFaceToast(){
  if(baselineFaceToastVisible)return;
  baselineFaceToastVisible=true;
  toast('未采集到有效面部基线，请确认摄像头开启并正对屏幕。',BASELINE_FACE_TOAST_MS,'baseline');
  setTimeout(()=>{baselineFaceToastVisible=false},BASELINE_FACE_TOAST_MS+260);
}
async function startBaseline(){
  if(!await checkModelReady())return;
  stopQueuePolling();
  setStage('baseline-view');
  if(baselineRecoveryTimer){clearTimeout(baselineRecoveryTimer);baselineRecoveryTimer=null}
  try{
    await connectWS();
  }catch(err){
    toast('无法连接到服务器，请刷新页面重试。', 0, 'connection');
    console.error('Baseline websocket failed:', err);
    return;
  }
  clearInterval(baselineInterval);
  baselineSentCount=0; baselineAckedCount=0; baselineDone=false; baselineSendComplete=false; baselineCalibrating=false; baselineFaceToastVisible=false; baselineFramePending=false; baselineFramePendingAt=0;
  if(ws.readyState===WebSocket.OPEN){
    ws.send(JSON.stringify({type:'baseline_reset'}));
  }
  baselineInterval=setInterval(()=>{
    if(baselineDone||baselineCalibrating) return;
    if(baselineFramePending){
      if(Date.now()-baselineFramePendingAt>FRAME_ACK_TIMEOUT_MS){
        recoverBaselineAckTimeout();
      }
      return;
    }
    if(ws.readyState===WebSocket.OPEN){
      const frame=captureFrame();
      if(!frame){
        showBaselineFaceToast();
        return;
      }
      baselineFramePending=true;
      baselineFramePendingAt=Date.now();
      ws.send(JSON.stringify({type:'baseline_frame',frame}));
      baselineSentCount++;
      if(baselineSentCount>=20 && baselineAckedCount===0){
        showBaselineFaceToast();
        baselineSentCount=0;
      }
    }else{
      scheduleReconnect();
    }
  },500);
}
async function finishBaseline(){
  if(baselineCalibrating)return;
  if(baselineAckedCount<10){
    baselineDone=false;
    await startBaseline();
    return;
  }
  clearInterval(baselineInterval);
  if(!ws||ws.readyState!==WebSocket.OPEN){
    baselineDone=false;
    toast('连接正在恢复，请稍后重试。',4000,'connection');
    scheduleReconnect();
    return;
  }
  baselineCalibrating=true;
  ws.send(JSON.stringify({type:'baseline_calibrate'}));
}

// ── Task ──
async function startTask(){
  if(!currentSessionId){
    toast('实验会话丢失，请重新开始并完成知情同意。',6000);
    forceRestartExperiment();
    return;
  }
  if(!webcamLive())await startWebcam();
  ws.send(JSON.stringify({type:'session_init',session_id:currentSessionId}));
  ws.send(JSON.stringify({type:'task_started'}));

  // Update UI
  $('task-label').textContent='写作任务';
  $('condition-badge').textContent=currentCondition==='affect-aware'?'情感感知 AI':'纯文本 AI';
  $('condition-badge').style.background=currentCondition==='affect-aware'?'#e0e7ff':'#f1f5f9';
  $('condition-badge').style.color=currentCondition==='affect-aware'?'#4f46e5':'#64748b';
  $('task-prompt').innerHTML=TASK_PROMPT_HTML;

  setStage('task-view');
  clearTimeoutSubmitRetry();
  turnCounter=0;revisionCounter=0;taskStartTime=Date.now();
  lastExpressionSentAt=Date.now();
  captureState='';
  chatTranscript=[];
  $('turn-num').textContent='0';$('rev-num').textContent='0';
  $('chat-area').innerHTML='<div class="empty-state"><div class="ai-avatar">AI</div><p>你好！我是你的 AI 写作助手。</p><p style="font-size:.85em;margin-top:4px">今天我可以如何帮助你撰写邮件？</p></div>';
  $('draft-panel').classList.remove('hidden');$('draft-text').textContent='';
  $('user-input').value='';$('timer').classList.remove('warn');
  writeProgress();

  timerInterval=setInterval(updateTimer,1000);
  startExpressionCapture();
}

function updateTimer(){
  const remaining=Math.max(0,15*60-(Date.now()-taskStartTime)/1000);
  const m=Math.floor(remaining/60),s=Math.floor(remaining%60);
  const el=$('timer');el.textContent=`${m}:${String(s).padStart(2,'0')}`;
  if(remaining<60)el.classList.add('warn');
  if(remaining<=0&&!finalSubmitting){
    clearInterval(timerInterval);timerInterval=null;
    doFinalSubmit(true);
  }
}

function appendChat(role,text,record=true){
  const area=$('chat-area');
  if(area.querySelector('.empty-state'))area.innerHTML='';
  const wrap=document.createElement('div');wrap.className='msg-wrap '+role;
  const now=new Date();
  const timeStr=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
  const clean=text.replace(/\[DRAFT_START\]|\[DRAFT_END\]/g,'');
  const draftActionId=role==='ai'&&text.includes('[DRAFT_START]')?`draft-${++draftActionCounter}`:'';
  if(draftActionId)draftActionText.set(draftActionId,text);
  wrap.innerHTML=`
    <div class="sender">${role==='ai'?'AI 助手':'你'}</div>
    <div class="bubble">${escapeHtml(clean)}</div>
    ${draftActionId?`<button class="draft-btn" data-action="apply-draft" data-draft-id="${draftActionId}">→ 应用草稿</button>`:''}
    <div class="time">${timeStr}</div>
  `;
  area.appendChild(wrap);
  area.scrollTop=area.scrollHeight;
  if(record){
    chatTranscript.push({role,text});
    writeProgress();
  }
}


function parseDraft(aiText){
  const m=aiText.match(/\[DRAFT_START\]([\s\S]*?)\[DRAFT_END\]/);
  return m?m[1].trim():'';
}

function extractDraft(aiText){
  const draft=parseDraft(aiText);
  if(draft){
    $('draft-text').textContent=draft;
    $('draft-panel').classList.remove('hidden');
    revisionCounter++;
    $('rev-num').textContent=revisionCounter;
    writeProgress();
  }
}

// ── Chat submit ──
let thinkingEl = null;
let thinkingStartedAt = 0;
let thinkingTimer = null;
$('chat-form').addEventListener('submit',e=>{
  e.preventDefault();
  const input=$('user-input'),text=input.value.trim();
  if(!text)return;
  if(!ws||ws.readyState!==WebSocket.OPEN){
    toast('连接正在恢复，请稍后再发送。',3000,'connection');
    scheduleReconnect();
    return;
  }
  appendChat('user',text);
  startAiWaiting();
  try{
    ws.send(JSON.stringify({type:'chat',text,condition:currentCondition}));
  }catch(err){
    finishAiWaiting();
    toast('连接中断，消息可能未发送，请恢复后重试。',5000,'connection');
    scheduleReconnect();
    return;
  }
  input.value='';input.disabled=true;$('submit-email').disabled=true;
  writeProgress();
});
function showThinking(){
  if(thinkingEl){
    updateThinking();
    return;
  }
  thinkingStartedAt=aiWaitStartedAt||Date.now();
  const area=$('chat-area');
  if(area.querySelector('.empty-state'))area.innerHTML='';
  const wrap=document.createElement('div');wrap.className='msg-wrap ai';wrap.id='thinking-msg';
  wrap.innerHTML=`
    <div class="sender">AI 助手</div>
    <div class="bubble thinking-bubble">
      <div class="thinking-dots"><span></span><span></span><span></span></div>
      <div class="thinking-label">思考中...</div>
    </div>
  `;
  area.appendChild(wrap);
  area.scrollTop=area.scrollHeight;
  thinkingEl=wrap;
  updateThinking();
  thinkingTimer=setInterval(updateThinking,1000);
}
function ensureThinking(){
  if(thinkingEl)updateThinking();
  else showThinking();
}
function updateThinking(prefix='思考中...'){
  if(!thinkingEl){
    showThinking();
    return;
  }
  const label=thinkingEl&&(thinkingEl.querySelector('.thinking-label')||thinkingEl.querySelector('.bubble div:last-child'));
  if(label){
    const seconds=Math.max(0,Math.floor((Date.now()-thinkingStartedAt)/1000));
    label.textContent=`${prefix} ${seconds}s`;
  }
}
function removeThinking(){
  if(thinkingTimer){clearInterval(thinkingTimer);thinkingTimer=null}
  if(thinkingEl){thinkingEl.remove();thinkingEl=null}
  $('user-input').disabled=false;$('submit-email').disabled=false;
}

// ── Submit email ──
$('submit-email').addEventListener('click',()=>submitEmail(false));

let evalResult = null;  // cache last evaluation result
let evalInFlight = false;
let finalSubmitting = false;

async function submitEmail(isTimeout){
  if(evalInFlight||finalSubmitting)return;
  const draftText=$('draft-text').textContent||'';
  if(!draftText&&!isTimeout){toast('还没有生成草稿。请先与 AI 对话生成一封草稿。');return;}
  if(!isTimeout){
    // Show loading in button
    const btn=$('submit-email');
    const origText=btn.textContent;
    evalInFlight=true;
    btn.textContent='正在评估...';btn.disabled=true;
    pauseTaskCapture();
    try {
      const ef=new FormData();ef.append('draft_text',draftText);
      evalResult=await(await fetch('/api/evaluate-draft',{method:'POST',body:ef})).json();
    } catch(e) {
      if(finalSubmitting||currentStage!=='task-view')return;
      toast('评估失败，请重试。');
      btn.textContent=origText;btn.disabled=false;evalInFlight=false;
      resumeTaskCapture();
      return;
    }
    if(finalSubmitting||currentStage!=='task-view'){
      evalInFlight=false;
      return;
    }
    evalInFlight=false;
    btn.textContent=origText;btn.disabled=false;
    showEvalModal(evalResult, isTimeout);
    return; // wait for user to see modal
  }
  // Timeout: bypass check
  doFinalSubmit(true);
}

function showEvalModal(result, isTimeout){
  const passed = result.passed || isTimeout;
  const score = result.score;
  const cls = passed ? 'pass' : 'fail';
  const canSubmit = passed;

  let html = `<div class="eval-header">
    <div class="score-ring ${cls}">${score}</div>
    <div class="eval-verdict ${cls}">${isTimeout ? '⏱ 时间到 — 自动提交' : (passed ? '✓ 通过 — 可以提交' : '✗ 未通过 — 请继续修改')}</div>
    <div style="font-size:.72em;color:#94a3b8;margin-top:4px">及格线 ${result.threshold} 分 · 分数越低越像人写的</div>
  </div>`;

  // Hard fail
  if(result.hard_fail){
    html += `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:12px;margin-bottom:16px">
      <strong style="color:#dc2626">硬性失败</strong>
      <p style="font-size:.78em;color:#991b1b;margin-top:4px">${escapeHtml(result.hard_fail_reason)}</p>
    </div>`;
  }

  // Deterministic signals
  if(result.signals && result.signals.length){
    html += `<h3>📊 六维检测</h3>`;
    for(const s of result.signals){
      const pct = Math.round(s.value * 100);
      const level = pct < 40 ? 'low' : (pct < 70 ? 'med' : 'high');
      const hits = (result.matched_markers && result.matched_markers.hits && s.key === 'formulaic_markers')
        ? `<div class="sig-hits">命中: ${result.matched_markers.hits.map(h => '「'+escapeHtml(h)+'」').join(', ')}</div>`
        : '';
      html += `<div class="eval-signal">
        <div class="sig-head"><span class="sig-name">${s.name}</span><span class="sig-val">${pct}% · ${Math.round(s.value*s.weight*100)}分</span></div>
        <div class="sig-bar"><div class="sig-fill ${level}" style="width:${pct}%"></div></div>
        ${pct >= 40 ? `<div class="sig-suggestion">💡 ${s.suggestion}</div>` : ''}
        ${hits}
      </div>`;
    }
  }

  // LLM flags
  if(result.llm_flags && result.llm_flags.length){
    html += `<h3>🤖 AI 语义检测</h3><div class="llm-flags">`;
    for(const f of result.llm_flags){
      html += `<div class="llm-flag ${f.flagged?'warn':'ok'}">
        <span class="flag-dot"></span>${f.name}
      </div>`;
    }
    html += `</div>`;
    const warned = result.llm_flags.filter(f=>f.flagged);
    if(warned.length){
      html += `<div style="margin-top:8px;font-size:.72em;color:#64748b">`;
      for(const f of warned){
        html += `<div style="margin-bottom:2px">• <strong>${f.name}</strong>: ${f.note}</div>`;
      }
      html += `</div>`;
    }
  }

  // Composite info
  html += `<div style="margin-top:16px;font-size:.68em;color:#94a3b8;text-align:center">
    确定性评分 ${result.det_score ?? score} × 30% + LLM评分 ${result.llm_score ?? 0} × 70% = ${score} 分
  </div>`;

  // Actions
  html += `<div class="eval-actions">`;
  if(canSubmit){
    html += `<button class="btn-green" data-action="final-submit" data-timeout="${isTimeout?1:0}">提交并进入问卷</button>`;
  }
  html += `<button class="${canSubmit?'btn-secondary':'btn-primary'}" data-action="close-eval" data-resume="1">继续修改</button>`;
  html += `</div>`;

  $('eval-modal').innerHTML = html;
  $('eval-overlay').classList.remove('hidden');
}

function closeEvalModal(resume=false){
  $('eval-overlay').classList.add('hidden');
  if(resume)resumeTaskCapture();
}

async function doFinalSubmit(isTimeout){
  if(finalSubmitting)return;
  finalSubmitting=true;
  evalInFlight=false;
  isAiWaiting=false;
  aiWaitStartedAt=0;
  aiWaitDeadlineAt=0;
  clearAiWaitTimeout();
  clearTimeoutSubmitRetry();
  clearInterval(timerInterval);timerInterval=null;
  clearInterval(expressionInterval);expressionInterval=null;
  removeThinking();
  pauseTaskCapture();
  stopAiSyncPolling();
  closeWS();
  await new Promise(resolve=>setTimeout(resolve,250));
  const draftText=$('draft-text').textContent||'';
  const elapsedMs=Number.isFinite(taskStartTime)&&taskStartTime>0?Date.now()-taskStartTime:0;
  const safeDuration=Math.max(0,Math.round(elapsedMs));
  const f=new FormData();
  f.append('session_id',String(currentSessionId||''));
  f.append('final_email',draftText);
  f.append('duration_ms',String(safeDuration));
  f.append('completion_type',isTimeout?'timeout':'manual');
  f.append('total_turns',String(Math.max(0,Math.round(Number(turnCounter)||0))));
  f.append('total_revisions',String(Math.max(0,Math.round(Number(revisionCounter)||0))));
  f.append('total_frames',String(Math.max(0,Math.floor(safeDuration/500))));
  f.append('unreliable_frames',0);
  try{
    const r=await fetch('/api/session/complete',{method:'POST',body:f});
    if(!r.ok)throw new Error(`complete failed: ${r.status}`);
  }catch(e){
    finalSubmitting=false;
    if(isTimeout){
      toast('时间已到，提交失败，正在自动重试。',4000);
      scheduleTimeoutSubmitRetry();
    }else{
      resumeTaskCapture();
      toast('提交失败，请重试。',4000);
    }
    return;
  }
  clearTimeoutSubmitRetry();
  setStage('questionnaire-view');
}

// ── Questionnaire ──
function markMissingAnswer(el){
  const row=el?.closest?.('.likert-row')||el;
  toast('您有未作答的题目');
  row?.classList.add('missing');
  row?.scrollIntoView({behavior:'smooth',block:'center'});
  if(el&&typeof el.focus==='function')setTimeout(()=>el.focus({preventScroll:true}),250);
  setTimeout(()=>row?.classList.remove('missing'),2200);
}

function checkedLikert(id){
  return document.querySelector(`#${id} input:checked`)?.value||'';
}

function requireInput(selector){
  const el=document.querySelector(selector);
  if(!el)return '';
  const value=(el.value||'').trim();
  if(!value)markMissingAnswer(el);
  return value;
}

function requireLikert(id){
  const value=checkedLikert(id);
  if(!value)markMissingAnswer(document.getElementById(id));
  return value;
}

$('q-form').addEventListener('submit',async e=>{
  e.preventDefault();

  const qFields=Array.from({length:10},(_,i)=>[`q${i+1}`,`likert-q${i+1}`]);
  const postFields=[
    ['u1','likert-post-u1'],['u2','likert-post-u2'],['u3','likert-post-u3'],['u4','likert-post-u4'],['u5','likert-post-u5'],
    ['s1','likert-post-s1'],['s2','likert-post-s2'],['s3','likert-post-s3'],['s4','likert-post-s4'],['s5','likert-post-s5'],
    ['sp1','likert-post-sp1'],['sp2','likert-post-sp2'],['sp3','likert-post-sp3'],
    ['cp1','likert-post-cp1'],['cp2','likert-post-cp2'],['cp3','likert-post-cp3'],
    ['r1','likert-post-r1'],['r2','likert-post-r2'],['r3','likert-post-r3'],['r4','likert-post-r4'],['r5','likert-post-r5'],
    ['e1','likert-post-e1'],['e2','likert-post-e2'],['e3','likert-post-e3'],['e4','likert-post-e4'],['e5','likert-post-e5'],
    ['f1','likert-post-f1'],['f2','likert-post-f2'],['f3','likert-post-f3'],['f4','likert-post-f4'],['f5','likert-post-f5'],
    ['m1','likert-post-m1'],['m2','likert-post-m2'],['m3','likert-post-m3'],
  ];

  const questionnaireData=new URLSearchParams();
  questionnaireData.append('session_id',currentSessionId);
  for(const [key,id] of qFields){
    const value=requireLikert(id);
    if(!value)return;
    questionnaireData.append(key,value);
  }

  const postData=new URLSearchParams();
  postData.append('session_id',currentSessionId);
  for(const [key,id] of postFields){
    const value=requireLikert(id);
    if(!value)return;
    postData.append(key,value);
  }
  postData.append('m4',document.querySelector('[name="post-m4"]')?.value||'');
  postData.append('m5',document.querySelector('[name="post-m5"]')?.value||'');

  try{
    const questionnaireR=await fetch('/api/questionnaire',{method:'POST',body:questionnaireData});
    if(!questionnaireR.ok){const d=await questionnaireR.json();throw new Error(d.detail||questionnaireR.statusText)}
    const postR=await fetch('/api/post-survey',{method:'POST',body:postData});
    if(!postR.ok){const d=await postR.json();throw new Error(d.detail||postR.statusText)}
  }catch(err){
    toast('保存问卷失败，请重试。' + (err.message ? ` ${err.message}` : ''),5000);
    return;
  }
  setStage('complete-view');
  writeProgress({completed:true});
});

// ── Pre-Survey Submit ──
document.getElementById('pre-survey-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData();
  f.append('participant_id', participantId);
  const age=requireInput('[name="pre-a1_age"]');
  if(!age)return;
  const gender=requireInput('[name="pre-a2_gender"]');
  if(!gender)return;
  const aiFrequency=requireInput('[name="pre-a3_ai_frequency"]');
  if(!aiFrequency)return;
  f.append('a1_age', age);
  f.append('a2_gender', gender);
  f.append('a3_ai_frequency', aiFrequency);
  const preFields = {
    a4_ai_experience: 'likert-pre-a4',
    a6_ai_tool_confidence: 'likert-pre-a6', a7_email_familiarity: 'likert-pre-a7',
    b1_calm: 'likert-pre-b1', b2_stressed: 'likert-pre-b2', b3_uncertain: 'likert-pre-b3',
    b4_confident: 'likert-pre-b4', b5_ready: 'likert-pre-b5', b6_webcam_comfort: 'likert-pre-b6',
    c1_expect_helpful: 'likert-pre-c1', c2_expect_understand: 'likert-pre-c2',
    c3_expect_easy: 'likert-pre-c3', c4_expect_collaborative: 'likert-pre-c4',
  };
  for (const [key, elementId] of Object.entries(preFields)) {
    const el = document.getElementById(elementId);
    if (!el) continue;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
      f.append(key, el.value);
    } else {
      const value = requireLikert(elementId);
      if(!value)return;
      f.append(key, value);
    }
  }
  try {
    const r = await fetch('/api/pre-survey', {method:'POST', body: new URLSearchParams(f)});
    if (!r.ok) { const d = await r.json(); throw new Error(d.detail || r.statusText); }
  } catch(err) {
    toast('保存开场问卷失败，请重试。' + (err.message ? ` ${err.message}` : ''), 5000);
    return;
  }
  try{
    await requestExperimentSlot();
  }catch(err){
    toast('无法进入实验队列，请稍后重试。' + (err.message ? ` ${err.message}` : ''), 5000);
  }
});

// ── Setup ──

$('setup-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const consent=validateConsentForm();
  if(!consent)return;
  if(!await checkModelReady())return;
  try {
    const f=new FormData();
    f.append('consent_agreed','true');
    f.append('consent_taker_name',consent.takerName);
    f.append('consent_signature',consent.signature);
    const r=await fetch('/api/session/start',{method:'POST',body:f});
    const d=await r.json();
    participantId=d.participant_id;
    currentSessionId=d.session_id;
    currentCondition=d.condition;
    currentStage='pre-survey-view';
    claimTabOwnership('start');
    writeProgress();
  } catch(err) {
    toast('无法创建实验会话，请刷新页面重试。', 0);
    console.error('Session start failed:', err);
    return;
  }
  try {
    await connectWS();
  } catch(err) {
    toast('无法连接到服务器，请刷新页面重试。', 0, 'connection');
    console.error('WS connect failed:', err);
    return;
  }
  try {
    await startWebcam();
  } catch(err) {
    toast('无法访问摄像头。请允许摄像头权限并确保没有其他程序占用摄像头。', 6000);
    console.error('Webcam failed:', err);
    return;
  }
  setStage('pre-survey-view');
  peekRecordingDrawer();
});

startDebugStatus();
initProgressRecovery();


function bindParticipantEvents(){
  $('eval-overlay')?.addEventListener('click',e=>{
    if(e.target===$('eval-overlay'))closeEvalModal();
  });
  document.addEventListener('click',async e=>{
    const el=e.target.closest('[data-action]');
    if(!el)return;
    if(el.dataset.action==='apply-draft')return extractDraft(draftActionText.get(el.dataset.draftId)||'');
    if(el.dataset.action==='final-submit'){
      closeEvalModal(false);
      return doFinalSubmit(el.dataset.timeout==='1');
    }
    if(el.dataset.action==='close-eval')return closeEvalModal(el.dataset.resume==='1');
    if(el.dataset.action==='resume-progress'){
      $('resume-overlay')?.classList.add('hidden');
      const saved=pendingResumeProgress;
      pendingResumeProgress=null;
      if(saved)return resumeProgress(saved);
    }
    if(el.dataset.action==='discard-progress'){
      $('resume-overlay')?.classList.add('hidden');
      await discardSavedProgress();
    }
  });
}

bindParticipantEvents();
initConsentSignature();
initRecordingDrawer();
