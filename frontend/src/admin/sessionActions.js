import { $, escapeHtml as escHtml } from '../shared/dom.js';

export function createSessionActions({adminFetch, toast, getSessionCache, onDeleted, onChanged}){
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
    const {exp}=getSessionCache()[sid]||{};
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
    let csv='time_s,au1,au4,au7,au12,head_yaw,head_pitch,queued_ms,drop_reason,face_detected,reliable\n';
    for(const f of frames){
      csv+=`${f.t},${f.au1},${f.au4},${f.au7},${f.au12},${f.yaw},${f.pitch},${f.queued_ms||0},"${(f.drop_reason||'').replace(/"/g,'""')}",${f.face},${f.ok}\n`;
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
      if(onDeleted)await onDeleted(sid);
      toast('Session 已删除','ok');
    }else{
      let message=r.status===409?'用户正在实验中':'删除失败';
      try{
        const data=await r.json();
        if(data.detail)message=data.detail;
      }catch(e){}
      toast(message,'err');
    }
  }
  async function setExclusion(sid, excluded){
    const body = new URLSearchParams();
    body.set('excluded', excluded ? 'true' : 'false');
    const r=await adminFetch(`/api/admin/sessions/${sid}/exclusion`,{method:'POST',body});
    if(r.ok){
      toast(excluded?'Session 已排除':'Session 已恢复','ok');
      if(onChanged)await onChanged(sid);
    }else{
      let message=excluded?'排除失败':'恢复失败';
      try{
        const data=await r.json();
        if(data.detail)message=data.detail;
      }catch(e){}
      toast(message,'err');
    }
  }

  return {
    exportSession,
    exportSessionCSV,
    exportExpressionCSV,
    confirmDelete,
    closeModal,
    deleteSession: doDelete,
    setExclusion,
  };
}
