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
