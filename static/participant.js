// ── DOM refs ──
const $ = id => document.getElementById(id);
const views = ['setup-view','pre-survey-view','baseline-view','task-view','questionnaire-view','post-survey-view','complete-view'];
function showView(id){views.forEach(v=>$(v).classList.add('hidden'));$(id).classList.remove('hidden')}
function setStage(id){
  currentStage=id;
  showView(id);
  writeProgress();
  if(currentSessionId&&id!=='complete-view')startSessionStatusCheck();
  if(id==='complete-view')stopSessionStatusCheck();
}
const STORAGE_KEY='hmcl-helper-progress-v1';
let currentStage='setup-view';
let chatTranscript=[];

function readProgress(){
  try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'null')}catch(e){return null}
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
    orderGroup:orderGroup||previous.orderGroup,
    language:language||previous.language,
    currentSessionId:currentSessionId||previous.currentSessionId,
    currentCondition:currentCondition||previous.currentCondition,
    currentScenario:currentScenario||previous.currentScenario,
    currentStage,turnCounter,revisionCounter,taskStartTime,
    draftText:currentDraft||previous.draftText||'',
    chatTranscript:chatTranscript.length?chatTranscript:(previous.chatTranscript||[]),
    forms,
    updatedAt:Date.now(),...extra
  };
  localStorage.setItem(STORAGE_KEY,JSON.stringify(state));
}
function clearProgress(){localStorage.removeItem(STORAGE_KEY)}
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

function appendDebugLog(event){
  const panel=$('debug-panel');
  if(!panel)return;
  panel.classList.add('on');
  const line=document.createElement('div');
  line.className='line';
  const kb=event.bytes?`${(event.bytes/1024).toFixed(1)}KB`:'0KB';
  const face=event.face_detected?(event.reliable?'face ok':'pose bad'):'no face';
  line.textContent=`[${event.ts}] ${event.kind} ${kb} ${event.elapsed_ms}ms ${face}`;
  panel.appendChild(line);
  while(panel.children.length>40)panel.removeChild(panel.firstChild);
  panel.scrollTop=panel.scrollHeight;
}

// ── Global state ──
let ws, participantId, orderGroup, language;
let currentSessionId, currentCondition, currentScenario;
let turnCounter = 0, revisionCounter = 0, taskStartTime = 0;
let timerInterval, expressionInterval, expressionWatchdogInterval, baselineInterval;
let aiSyncTimer = null;
let mediaRecorder, webcamStream, chunkIndex = 0;
let isAiWaiting = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let lastExpressionSentAt = 0;
let lastCaptureNoticeAt = 0;
let captureState = '';
let sessionStatusTimer = null;

// ── Toast ──
function toast(msg, duration=3000, kind=''){
  const el = document.createElement('div');el.className='toast';el.textContent=msg;
  if(kind)el.dataset.kind=kind;
  if(duration<=0)el.classList.add('sticky');
  $('toast-container').appendChild(el);
  if(duration>0)setTimeout(()=>el.remove(),duration);
  return el;
}
function clearToasts(kind){
  const selector=kind?`.toast[data-kind="${kind}"]`:'.toast';
  document.querySelectorAll(selector).forEach(el=>el.remove());
}

// ── Build Likert ──
document.querySelectorAll('.likert-line').forEach(row=>{
  for(let v=1;v<=7;v++){
    const lbl=document.createElement('label');lbl.className='likert-dot';
    lbl.innerHTML=`<input type="radio" name="${row.id}" value="${v}" required><div class="dot"></div><span class="dot-label">${v}</span>`;
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
      if(currentStage==='task-view')setCapturePaused('连接恢复中',true);
      if(isAiWaiting){
        updateThinking('连接中断，正在恢复...');
        startAiSyncPolling();
      }
      if(e.code!==1000)scheduleReconnect();
    };
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if(msg.type==='baseline_ack'){
        baselineAckedCount=msg.collected;
        const pct=Math.min(100,(msg.collected/10)*100);
        $('baseline-bar').style.width=pct+'%';
        $('baseline-count').textContent=msg.collected;
        if(msg.collected>=10 && !baselineDone){
          baselineDone=true;clearInterval(baselineInterval);finishBaseline();
        }
      }
      if(msg.type==='ai_response'){
        isAiWaiting=false;
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
      }
      if(msg.type==='prompt'){
        toast(msg.message,4000);
      }
      if(msg.type==='face_status'){
        captureState='';
        if(msg.face_detected&&msg.reliable){
          setFaceStatus('found','面部已检测');
        }else if(msg.face_detected){
          setFaceStatus('lost','头部角度不佳');
        }else{
          setFaceStatus('lost','未检测到面部');
        }
      }
      if(msg.type==='debug_log'){
        appendDebugLog(msg.event);
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
      toast('连接已恢复。',2000,'connection');
    }catch(e){
      scheduleReconnect();
    }
  },delay);
}

// ── Webcam ──
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
    if(isAiWaiting){
      setCapturePaused('AI 回复中，采集暂停');
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
  if(currentScenario){
    $('scenario-text').innerHTML=currentScenario==='A'
      ?'<strong>情境 A</strong><br>你的电脑意外关机，期末项目数据全部丢失，今天就是截止日。请与 AI 协作写一封邮件向教授请求短期延期。'
      :'<strong>情境 B</strong><br>小组项目中一名组员始终没有回应，你独自承担了全部工作量。请与 AI 协作写一封邮件向教授请求帮助。';
  }
}
function applyChatSync(msg){
  const messages=Array.isArray(msg.messages)?msg.messages:[];
  if(currentStage!=='task-view'||messages.length<chatTranscript.length)return;
  const incoming=messages.map(m=>({role:m.role,text:m.text||''}));
  const changed=incoming.length!==chatTranscript.length||incoming.some((m,i)=>m.role!==chatTranscript[i]?.role||m.text!==chatTranscript[i]?.text);
  if(msg.session_id)currentSessionId=msg.session_id;
  if(msg.condition)currentCondition=msg.condition;
  if(msg.scenario)currentScenario=msg.scenario;
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
    stopAiSyncPolling();
    removeThinking();
    const draft=parseDraft(last.text);
    if(draft){
      $('draft-text').textContent=draft;
      $('draft-panel').classList.remove('hidden');
    }
  }else if(isAiWaiting){
    ensureThinking();
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
function closeWS(){
  if(ws&&(ws.readyState===WebSocket.OPEN||ws.readyState===WebSocket.CONNECTING)){
    try{ws.close(1000,'task complete')}catch(e){}
  }
  ws=null;
}
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
  }catch(err){}
}
function forceRestartExperiment(){
  stopSessionStatusCheck();
  stopAiSyncPolling();
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
async function resumeProgress(saved){
  participantId=saved.participantId;
  orderGroup=saved.orderGroup;
  language=saved.language||'zh';
  currentSessionId=saved.currentSessionId;
  if(currentSessionId)startSessionStatusCheck();
  currentCondition=saved.currentCondition;
  currentScenario=saved.currentScenario;
  currentStage=saved.currentStage||'setup-view';
  if(currentStage==='break-view')currentStage='complete-view';
  turnCounter=saved.turnCounter||0;
  revisionCounter=saved.revisionCounter||0;
  taskStartTime=saved.taskStartTime||Date.now();
  chatTranscript=Array.isArray(saved.chatTranscript)?saved.chatTranscript:[];
  restoreFormValues(saved.forms||{});
  let cameraReady=true;
  if(['pre-survey-view','baseline-view','task-view'].includes(currentStage)){
    try{await startWebcam();}catch(err){cameraReady=false;toast('无法访问摄像头。请允许摄像头权限并确保没有其他程序占用摄像头。',6000);}
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
    if(saved.draftText)$('draft-panel').classList.remove('hidden');
    renderRestoredChat();
    $('turn-num').textContent=turnCounter;
    $('rev-num').textContent=revisionCounter;
    const last=chatTranscript[chatTranscript.length-1];
    if(last&&last.role==='user'){
      isAiWaiting=true;
      showThinking();
      startAiSyncPolling();
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
  if(confirm('检测到未完成的实验进度。是否继续上次实验？')){
    resumeProgress(saved);
  }else{
    clearProgress();
  }
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
      setCapturePaused('AI 回复中，采集暂停');
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

// ── Baseline ──
let baselineSentCount = 0;
let baselineAckedCount = 0;
let baselineDone = false;
let baselineSendComplete = false;
async function startBaseline(){
  if(!await checkModelReady())return;
  setStage('baseline-view');
  try{
    await connectWS();
  }catch(err){
    toast('无法连接到服务器，请刷新页面重试。', 0, 'connection');
    console.error('Baseline websocket failed:', err);
    return;
  }
  baselineSentCount=0; baselineAckedCount=0; baselineDone=false; baselineSendComplete=false;
  baselineInterval=setInterval(()=>{
    if(baselineDone) return;
    if(ws.readyState===WebSocket.OPEN){
      ws.send(JSON.stringify({type:'baseline_frame',frame:captureFrame()}));
      baselineSentCount++;
      if(baselineSentCount>=20 && baselineAckedCount===0){
        toast('未收到有效面部基线，请确认摄像头开启并正对屏幕。',4000);
        baselineSentCount=0;
      }
    }else{
      scheduleReconnect();
    }
  },500);
}
async function finishBaseline(){
  if(baselineAckedCount<10){
    baselineDone=false;
    await startBaseline();
    return;
  }
  clearInterval(baselineInterval);
  const f=new FormData();f.append('participant_id',participantId);
  const r=await fetch('/api/baseline-calibrate',{method:'POST',body:f});
  if(!r.ok){
    baselineDone=false;
    baselineAckedCount=0;
    baselineSentCount=0;
    $('baseline-bar').style.width='0%';
    $('baseline-count').textContent='0';
    toast('未采集到有效面部基线，请确认摄像头开启并正对屏幕。',5000);
    setFaceLost();
    await startBaseline();
    return;
  }
  startTask();
}

// ── Task ──
async function startTask(){
  if(!currentSessionId){
    const f=new FormData();
    f.append('language',language);
    const r=await fetch('/api/session/start',{method:'POST',body:f});
    const d=await r.json();
    participantId=d.participant_id;
    orderGroup=d.order_group;
    currentSessionId=d.session_id;currentCondition=d.condition;currentScenario=d.scenario;
  }
  if(!webcamLive())await startWebcam();
  ws.send(JSON.stringify({type:'session_init',session_id:currentSessionId}));

  // Update UI
  $('task-label').textContent='写作任务';
  $('condition-badge').textContent=currentCondition==='affect-aware'?'情感感知 AI':'纯文本 AI';
  $('condition-badge').style.background=currentCondition==='affect-aware'?'#e0e7ff':'#f1f5f9';
  $('condition-badge').style.color=currentCondition==='affect-aware'?'#4f46e5':'#64748b';
  $('scenario-text').innerHTML=currentScenario==='A'
    ?'<strong>情境 A</strong><br>你的电脑意外关机，期末项目数据全部丢失，今天就是截止日。请与 AI 协作写一封邮件向教授请求短期延期。'
    :'<strong>情境 B</strong><br>小组项目中一名组员始终没有回应，你独自承担了全部工作量。请与 AI 协作写一封邮件向教授请求帮助。';

  setStage('task-view');
  turnCounter=0;revisionCounter=0;taskStartTime=Date.now();
  lastExpressionSentAt=Date.now();
  captureState='';
  chatTranscript=[];
  $('turn-num').textContent='0';$('rev-num').textContent='0';
  $('chat-area').innerHTML='<div class="empty-state"><div class="ai-avatar">AI</div><p>你好！我是你的 AI 写作助手。</p><p style="font-size:.85em;margin-top:4px">今天我可以如何帮助你撰写邮件？</p></div>';
  $('draft-panel').classList.add('hidden');$('draft-text').textContent='';
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
  if(remaining<=0){clearInterval(timerInterval);submitEmail(true);}
}

function appendChat(role,text,record=true){
  const area=$('chat-area');
  if(area.querySelector('.empty-state'))area.innerHTML='';
  const wrap=document.createElement('div');wrap.className='msg-wrap '+role;
  const now=new Date();
  const timeStr=now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
  const clean=text.replace(/\[DRAFT_START\]|\[DRAFT_END\]/g,'');
  wrap.innerHTML=`
    <div class="sender">${role==='ai'?'AI 助手':'你'}</div>
    <div class="bubble">${escapeHtml(clean)}</div>
    ${role==='ai'&&text.includes('[DRAFT_START]')?`<button class="draft-btn" onclick="extractDraft(\`${escapeHtml(text)}\`)">→ 应用草稿</button>`:''}
    <div class="time">${timeStr}</div>
  `;
  area.appendChild(wrap);
  area.scrollTop=area.scrollHeight;
  if(record){
    chatTranscript.push({role,text});
    writeProgress();
  }
}

function escapeHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

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
  isAiWaiting=true;
  showThinking();
  startAiSyncPolling();
  ws.send(JSON.stringify({type:'chat',text,condition:currentCondition,language}));
  input.value='';input.disabled=true;$('submit-email').disabled=true;
});
function showThinking(){
  if(thinkingEl){
    updateThinking();
    return;
  }
  thinkingStartedAt=Date.now();
  const area=$('chat-area');
  if(area.querySelector('.empty-state'))area.innerHTML='';
  const wrap=document.createElement('div');wrap.className='msg-wrap ai';wrap.id='thinking-msg';
  wrap.innerHTML=`
    <div class="sender">AI 助手</div>
    <div class="bubble" style="padding:10px 20px">
      <div class="thinking-dots"><span></span><span></span><span></span></div>
      <div style="font-size:.7em;color:#94a3b8;margin-top:4px">思考中...</div>
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
      toast('评估失败，请重试。');
      btn.textContent=origText;btn.disabled=false;evalInFlight=false;
      resumeTaskCapture();
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
    确定性评分 ${result.det_score ?? score} × 60% + LLM评分 ${result.llm_score ?? 0} × 40% = ${score} 分
  </div>`;

  // Actions
  html += `<div class="eval-actions">`;
  if(canSubmit){
    html += `<button class="btn-green" onclick="closeEvalModal(false);doFinalSubmit(${isTimeout});">提交并进入问卷</button>`;
  }
  html += `<button class="${canSubmit?'btn-secondary':'btn-primary'}" onclick="closeEvalModal(true)">继续修改</button>`;
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
  clearInterval(timerInterval);clearInterval(expressionInterval);
  pauseTaskCapture();
  stopAiSyncPolling();
  closeWS();
  const draftText=$('draft-text').textContent||'';
  const f=new FormData();
  f.append('session_id',currentSessionId);
  f.append('final_email',draftText);
  f.append('duration_ms',Date.now()-taskStartTime);
  f.append('completion_type',isTimeout?'timeout':'manual');
  f.append('total_turns',turnCounter);
  f.append('total_revisions',revisionCounter);
  f.append('total_frames',Math.floor((Date.now()-taskStartTime)/500));
  f.append('unreliable_frames',0);
  try{
    const r=await fetch('/api/session/complete',{method:'POST',body:f});
    if(!r.ok)throw new Error(`complete failed: ${r.status}`);
  }catch(e){
    finalSubmitting=false;
    resumeTaskCapture();
    toast('提交失败，请重试。',4000);
    return;
  }
  setStage('questionnaire-view');
}

// ── Questionnaire ──
$('q-form').addEventListener('submit',async e=>{
  e.preventDefault();
  const f=new FormData();f.append('session_id',currentSessionId);
  for(let i=1;i<=10;i++){
    const v=document.querySelector(`input[name="likert-q${i}"]:checked`)?.value;
    if(!v){toast('请完成所有 10 道题目。');return;}
    f.append(`q${i}`,v);
  }
  await fetch('/api/questionnaire',{method:'POST',body:f});
  setStage('post-survey-view');
});

// ── Pre-Survey Submit ──
document.getElementById('pre-survey-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData();
  f.append('participant_id', participantId);
  const preFields = {
    a1_age: 'pre-a1_age', a2_gender: 'pre-a2_gender', a3_ai_frequency: 'pre-a3_ai_frequency',
    a4_ai_experience: 'likert-pre-a4', a5_writing_confidence: 'likert-pre-a5',
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
      const checked = el.querySelector('input:checked');
      f.append(key, checked ? checked.value : '');
    }
  }
  // Also get text input/select values for A1-A3
  for (const name of ['pre-a1_age', 'pre-a2_gender', 'pre-a3_ai_frequency']) {
    const el = document.querySelector(`[name="${name}"]`);
    if (el) f.append(name.replace('pre-', ''), el.value);
  }
  try {
    const r = await fetch('/api/pre-survey', {method:'POST', body: new URLSearchParams(f)});
    if (!r.ok) { const d = await r.json(); throw new Error(d.detail || r.statusText); }
  } catch(err) {
    toast('Failed to save pre-survey: ' + err.message, 5000);
    return;
  }
  await startBaseline();
});

// ── Post-Survey Submit ──
document.getElementById('post-survey-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData();
  f.append('session_id', currentSessionId);
  const postFields = [
    'u1','u2','u3','u4','u5',
    's1','s2','s3','s4','s5',
    'sp1','sp2','sp3',
    'cp1','cp2','cp3',
    'r1','r2','r3','r4','r5',
    'e1','e2','e3','e4','e5',
    'f1','f2','f3','f4','f5',
    'm1','m2','m3','m4','m5'
  ];
  for (const key of postFields) {
    const el = document.querySelector(`[name="post-${key}"]`);
    if (el) {
      f.append(key, el.value || '');
      continue;
    }
    const likertEl = document.getElementById('likert-post-' + key);
    if (likertEl) {
      const checked = likertEl.querySelector('input:checked');
      f.append(key, checked ? checked.value : '');
    }
  }
  try {
    const r = await fetch('/api/post-survey', {method:'POST', body: new URLSearchParams(f)});
    if (!r.ok) { const d = await r.json(); throw new Error(d.detail || r.statusText); }
  } catch(err) {
    toast('Failed to save post-survey: ' + err.message, 5000);
    return;
  }
  setStage('complete-view');
  writeProgress({completed:true});
});

// ── Setup ──

$('setup-form').addEventListener('submit',async e=>{
  e.preventDefault();
  language=$('lang').value;
  if(!await checkModelReady())return;
  try {
    const f=new FormData();
    f.append('language',language);
    const r=await fetch('/api/session/start',{method:'POST',body:f});
    const d=await r.json();
    participantId=d.participant_id;
    orderGroup=d.order_group;
    currentSessionId=d.session_id;
    currentCondition=d.condition;
    currentScenario=d.scenario;
    currentStage='pre-survey-view';
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
});

initProgressRecovery();
