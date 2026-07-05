/* =========================================================================
   PS House Tracker — Application logic
   -------------------------------------------------------------------------
   Sections:
     1.  Config + state
     2.  Storage + small helpers
     3.  PIN fetch (owner login)
     4.  Google Sheets sync  ← duplicate-prevention lives here
     5.  Lock screen / navigation
     6.  Dashboard tabs
     7.  Settings modal
     8.  Shop items render + sale modal
     9.  Shared payment selection
    10.  PS console cards render + live timers
    11.  Start / Collect / Stop session flows
    12.  Game settings + item management
    13.  Dashboard render (metrics, tables, charts)
    14.  CSV export + clear data
    15.  Boot + service-worker registration

   NOTE: Functions used by inline onclick="" handlers in index.html
   (showTab, selectPayment, openSaleModal, askStart, askCollect, askStop,
   toggleSplitPayment, updateSplitRemaining, changeQty, saveGameSettings,
   addItem, updateItemPrice, deleteItem, setFilter, setItemsFilter) are kept
   as top-level globals on purpose — do not wrap this file in an IIFE.
   ========================================================================= */

/* ── 1. CONFIG ─────────────────────────────────────────────────────────── */
let SESSION_DURATION = parseInt(localStorage.getItem('ps_session_duration')) || 12 * 60; // seconds
let PRICE = parseInt(localStorage.getItem('ps_price')) || 20;                             // Birr per session
const NUM_PS = 5;
const SHEET_ID = '1bJXuhnfsXKMCxBKwf7wVBKzSRXiNPQdFPdn2_8lkDGk';

/* ── STATE ─────────────────────────────────────────────────────────────── */
let pendingStartPS=null, pendingStopPS=null, pendingCollectPS=null;
let collectPayment=null, salePayment=null;
let currentSaleItem=null, saleQty=1;

const visits = load('ps_visits',[]);
const itemSales = load('ps_item_sales',[]);
let syncQueue = load('ps_sync_queue',[]);
let scriptUrl = localStorage.getItem('ps_script_url')||'https://script.google.com/macros/s/AKfycbwr-wHlnYwliiKp3ZvpP2WC03n8YLrKO-TfmPthfVt80sQla3oLiEeDYOMpyhuBwVk5/exec';
let pinCell = localStorage.getItem('ps_pin_cell')||'Config!A1';

// Default snack/drink catalogue (owner can edit/add/remove in the dashboard)
const DEFAULT_ITEMS = [
  {id:'qq',emoji:'🍫',name:'QQ',price:25},
  {id:'sunchips',emoji:'🍟',name:'Sunchips',price:35},
  {id:'softdrink',emoji:'🥤',name:'Soft Drink',price:50},
];
let shopItems = load('ps_shop_items', DEFAULT_ITEMS);

// Live state for each physical console. Persisted to localStorage so an
// in-progress customer (running timers + uncollected session count) survives
// a page refresh / PWA reload instead of resetting to 0.
const psState = Array.from({length:NUM_PS},(_,i)=>({
  id:i+1,status:'idle',startTime:null,endTime:null,visitSessions:0,visitStart:null,expiredAt:null
}));
restorePsState();   // rehydrate any live consoles saved before the reload

/* ── 2. STORAGE + HELPERS ──────────────────────────────────────────────── */
function load(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d;}catch{return d;}}
function saveVisits(){localStorage.setItem('ps_visits',JSON.stringify(visits));}
function saveSales(){localStorage.setItem('ps_item_sales',JSON.stringify(itemSales));}
function saveQueue(){localStorage.setItem('ps_sync_queue',JSON.stringify(syncQueue));}
function saveItems(){localStorage.setItem('ps_shop_items',JSON.stringify(shopItems));}
// Persist the live console state (status, timers, uncollected session count).
function savePsState(){
  localStorage.setItem('ps_live_state',JSON.stringify(psState.map(p=>({
    status:p.status,startTime:p.startTime,endTime:p.endTime,
    visitSessions:p.visitSessions,visitStart:p.visitStart,expiredAt:p.expiredAt
  }))));
}
// Restore live console state on boot. A session whose time ran out while the
// page was closed comes back as 'expired' (overtime counted from its end).
function restorePsState(){
  const saved=load('ps_live_state',null);
  if(!Array.isArray(saved)) return;
  saved.forEach((s,i)=>{
    if(i>=psState.length||!s) return;
    Object.assign(psState[i],{
      status:s.status,startTime:s.startTime,endTime:s.endTime,
      visitSessions:s.visitSessions,visitStart:s.visitStart,expiredAt:s.expiredAt
    });
    if(psState[i].status==='active'&&psState[i].endTime&&psState[i].endTime<=now()){
      psState[i].status='expired';
      if(!psState[i].expiredAt) psState[i].expiredAt=psState[i].endTime;
    }
  });
}
function now(){return Date.now();}
function fmt(ms){const s=Math.max(0,Math.ceil(ms/1000));return`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;}
function todayStr(){return new Date().toISOString().split('T')[0];}
function timeStr(ts){return new Date(ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true});}
function dateStr(ts){return new Date(ts).toLocaleDateString('en-GB',{day:'2-digit',month:'short'});}
function getTodayVisits(){return visits.filter(v=>v.date===todayStr());}
function getTodayRevenue(){return getTodayVisits().reduce((s,v)=>s+v.amount,0);}
function isOnline(){return navigator.onLine;}

/* ── 3. PIN FETCH FROM SHEET (owner login) ─────────────────────────────── */
async function fetchPinFromSheet(){
  if(!scriptUrl) return null;
  try {
    const url = `${scriptUrl}?action=getPin&cell=${encodeURIComponent(pinCell)}`;
    const res = await fetch(url, {mode:'cors'});
    const data = await res.json();
    return data.pin ? String(data.pin).trim() : null;
  } catch(e){
    // fallback no-cors — can't read response but we try
    return null;
  }
}

/* ── 4. SYNC TO GOOGLE SHEETS ──────────────────────────────────────────────
   Duplicate prevention (three layers):
     (a) Every queued record carries a unique `id`. The Apps Script skips any
         `id` (UID column) it has already stored, so re-sends never duplicate.
     (b) flushQueue() is guarded by `isFlushing` so the queue can't be drained
         by two overlapping flushes at once (this was the main source of the
         3×/5× duplicate rows).
     (c) A record is only removed from the queue once the server confirms it
         (or a no-cors best-effort send is made), tracked by its `id`.
   ------------------------------------------------------------------------- */
let isFlushing = false;   // (b) concurrency guard — only one flush at a time

async function syncToSheets(row, type){
  if(!scriptUrl) return;
  // `id` is the idempotency key the server dedupes on.
  const item = {id:`q_${now()}_${Math.random().toString(36).slice(2,7)}`, type, ...row};
  syncQueue.push(item);
  saveQueue(); updateSyncUI();
  if(isOnline()) await flushQueue();
}

async function flushQueue(){
  if(!scriptUrl||!isOnline()||syncQueue.length===0) return;
  if(isFlushing) return;          // (b) another flush is already draining the queue
  isFlushing = true;
  try{
    // Snapshot what we'll attempt this round; new items pushed mid-flush are
    // handled by the next flush. Track successes by id so we only drop the
    // records that were actually sent.
    const batch = [...syncQueue];
    const sentIds = new Set();
    for(const item of batch){
      const ok = await sendOneItem(item);
      if(ok) sentIds.add(item.id);
    }
    syncQueue = syncQueue.filter(it => !sentIds.has(it.id));
    saveQueue(); updateSyncUI();
  } finally {
    isFlushing = false;
  }
}

async function sendOneItem(item){
  // Send ONE record per request so a failure never wipes unrelated pending
  // items, and so URLs stay short (mobile Safari is strict about long GET URLs).
  try{
    const payload = item.type==='sale'
      ? {type:'sale', rows:[item]}
      : {type:'visit', rows:[item]};
    const encoded = encodeURIComponent(JSON.stringify(payload));
    const url = `${scriptUrl}?action=sync&data=${encoded}`;
    // Prefer a real cors fetch so we can read {ok:true} and confirm the write.
    try {
      const res = await fetch(url, {mode:'cors'});
      const data = await res.json();
      return !!(data && data.ok);
    } catch(corsErr){
      // CORS/redirect read blocked (common on some mobile browsers) — fire a
      // best-effort no-cors send. We can't read the response, so we assume it
      // landed. Safe because the server dedupes on `item.id` (UID column):
      // if the earlier cors request already wrote the row, this one is ignored.
      await fetch(url, {mode:'no-cors'});
      return true;
    }
  } catch(e){
    return false;
  }
}

function updateSyncUI(){
  const dot=document.getElementById('online-dot');
  const lbl=document.getElementById('online-label');
  if(dot){
    if(syncQueue.length>0){dot.className='sync-dot-sm pending';if(lbl)lbl.textContent=`${syncQueue.length} pending`;}
    else if(isOnline()){dot.className='sync-dot-sm online';if(lbl)lbl.textContent='Online';}
    else{dot.className='sync-dot-sm';if(lbl)lbl.textContent='Offline';}
  }
  const al=document.getElementById('sync-alert');
  if(al){
    if(syncQueue.length>0){
      al.style.display='flex';
      document.getElementById('sync-alert-text').textContent=`${syncQueue.length} record${syncQueue.length>1?'s':''} waiting to sync.`;
    } else { al.style.display='none'; }
  }
  const sd=document.getElementById('sync-dot'),sl=document.getElementById('sync-label');
  if(sd){sd.className=syncQueue.length===0?'sync-dot synced':'sync-dot';}
  if(sl)sl.textContent=syncQueue.length===0?`${visits.length} visits — all synced`:`${visits.length} visits — ${syncQueue.length} pending`;
}

// Retry sync when we come back online and periodically. flushQueue() is now
// self-guarding, so these overlapping triggers can no longer double-send.
window.addEventListener('online',()=>{updateSyncUI();flushQueue();});
window.addEventListener('offline',()=>updateSyncUI());
setInterval(()=>{if(isOnline()&&syncQueue.length>0)flushQueue();},30000);

/* ── 5. LOCK / NAVIGATION ──────────────────────────────────────────────── */
document.getElementById('staff-btn').onclick=()=>showShop();

document.getElementById('owner-login-btn').onclick=async()=>{
  const pin=document.getElementById('pin-input').value.trim();
  if(!pin){document.getElementById('pin-error').textContent='Enter your PIN.';document.getElementById('pin-error').style.display='block';return;}
  if(!isOnline()){
    document.getElementById('pin-error').textContent='No internet. Cannot verify PIN securely.';
    document.getElementById('pin-error').style.display='block';return;
  }
  if(!scriptUrl){
    document.getElementById('pin-error').textContent='Script URL not set. Open Settings first.';
    document.getElementById('pin-error').style.display='block';
    // let them in if no url is set yet (first time setup)
    showDashboard(); return;
  }
  document.getElementById('lock-info').textContent='Verifying PIN…';
  const serverPin=await fetchPinFromSheet();
  if(serverPin===null){
    document.getElementById('pin-error').textContent='Could not reach server. Check script URL.';
    document.getElementById('pin-error').style.display='block';
    document.getElementById('lock-info').textContent='PIN is verified securely online.';
    return;
  }
  if(pin===serverPin){
    document.getElementById('pin-error').style.display='none';
    document.getElementById('pin-input').value='';
    document.getElementById('lock-info').textContent='PIN is verified securely online.';
    showDashboard();
  } else {
    document.getElementById('pin-error').textContent='Wrong PIN. Try again.';
    document.getElementById('pin-error').style.display='block';
    document.getElementById('pin-input').value='';
    document.getElementById('lock-info').textContent='PIN is verified securely online.';
  }
};
document.getElementById('pin-input').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('owner-login-btn').click();});
document.getElementById('go-dashboard-btn').onclick=async()=>{
  const pin=prompt('Enter owner PIN:');
  if(!pin) return;
  if(!isOnline()){alert('No internet. Cannot verify PIN.');return;}
  if(!scriptUrl){showDashboard();return;}
  const serverPin=await fetchPinFromSheet();
  if(pin===serverPin) showDashboard(); else if(pin!==null) alert('Wrong PIN');
};
document.getElementById('back-shop-btn').onclick=()=>showShop();

function showShop(){
  document.getElementById('lock-screen').style.display='none';
  document.getElementById('shop-app').classList.add('active');
  document.getElementById('dash-app').classList.remove('active');
  renderShop(); renderItems(); startClock(); updateSyncUI();
}
async function showDashboard(){
  document.getElementById('lock-screen').style.display='none';
  document.getElementById('shop-app').classList.remove('active');
  document.getElementById('dash-app').classList.add('active');
  updateSyncUI();
  await refreshDashboardData();   // pull all-store data from the Google Sheet
}
document.getElementById('refresh-btn').onclick=()=>refreshDashboardData();

/* ── 6. DASHBOARD TABS ─────────────────────────────────────────────────── */
function showTab(id){
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.dash-tab').forEach(b=>b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  const idx={'tab-ps':0,'tab-items':1,'tab-manage':2}[id]??0;
  document.querySelectorAll('.dash-tab')[idx]?.classList.add('active');
  if(id==='tab-items') renderItemsDash();
  if(id==='tab-manage') renderManageItems();
}

/* ── 7. SETTINGS MODAL ─────────────────────────────────────────────────── */
document.getElementById('settings-btn').onclick=()=>{
  document.getElementById('script-url-input').value=scriptUrl;
  document.getElementById('pin-cell-input').value=pinCell;
  document.getElementById('settings-modal').style.display='flex';
};
document.getElementById('settings-cancel').onclick=()=>document.getElementById('settings-modal').style.display='none';
document.getElementById('settings-save').onclick=()=>{
  scriptUrl=document.getElementById('script-url-input').value.trim();
  pinCell=document.getElementById('pin-cell-input').value.trim()||'Config!A1';
  localStorage.setItem('ps_script_url',scriptUrl);
  localStorage.setItem('ps_pin_cell',pinCell);
  document.getElementById('settings-modal').style.display='none';
  if(scriptUrl&&syncQueue.length>0) flushQueue();
  updateSyncUI();
};
document.getElementById('sync-now-btn').onclick=()=>flushQueue();

/* ── 8. SHOP ITEMS RENDER + SALE MODAL ─────────────────────────────────── */
function renderItems(){
  const grid=document.getElementById('items-grid');
  if(!grid) return;
  grid.innerHTML=shopItems.map(item=>`
    <div class="item-card" onclick="openSaleModal('${item.id}')">
      <div class="item-emoji">${item.emoji}</div>
      <div class="item-name">${item.name}</div>
      <div class="item-price">${item.price} Birr</div>
    </div>`).join('');
}

function openSaleModal(itemId){
  currentSaleItem=shopItems.find(i=>i.id===itemId);
  if(!currentSaleItem) return;
  saleQty=1; salePayment=null;
  document.getElementById('sale-modal-title').textContent=`${currentSaleItem.emoji} ${currentSaleItem.name}`;
  document.querySelectorAll('#sale-pay-methods .pay-btn').forEach(b=>b.classList.remove('selected'));
  document.getElementById('sale-confirm').disabled=true;
  renderSaleCart();
  document.getElementById('sale-modal').style.display='flex';
}
function renderSaleCart(){
  if(!currentSaleItem) return;
  document.getElementById('sale-cart').innerHTML=`
    <div class="item-qty-row">
      <div>
        <div class="item-qty-name">${currentSaleItem.emoji} ${currentSaleItem.name}</div>
        <div class="item-qty-price">${currentSaleItem.price} Birr each</div>
      </div>
      <div class="item-qty-controls">
        <button class="qty-btn" onclick="changeQty(-1)">−</button>
        <div class="qty-num" id="qty-display">${saleQty}</div>
        <button class="qty-btn" onclick="changeQty(1)">+</button>
      </div>
    </div>`;
  document.getElementById('sale-total').textContent=`${saleQty*currentSaleItem.price} Birr`;
}
function changeQty(d){
  saleQty=Math.max(1,saleQty+d);
  document.getElementById('qty-display').textContent=saleQty;
  document.getElementById('sale-total').textContent=`${saleQty*currentSaleItem.price} Birr`;
}
document.getElementById('sale-cancel').onclick=()=>{document.getElementById('sale-modal').style.display='none';};
document.getElementById('sale-confirm').onclick=()=>{
  document.getElementById('sale-modal').style.display='none';
  completeSale();
};
function completeSale(){
  if(!currentSaleItem||!salePayment) return;
  const sale={
    id:`s_${now()}`,date:todayStr(),time:timeStr(now()),
    itemId:currentSaleItem.id,item:currentSaleItem.name,
    qty:saleQty,amount:saleQty*currentSaleItem.price,
    payment:salePayment
  };
  itemSales.push(sale); saveSales();
  syncToSheets({date:sale.date,time:sale.time,item:sale.item,qty:sale.qty,amount:sale.amount,payment:sale.payment},'sale');
  updateSyncUI();
}

/* ── 9. PAYMENT SELECTION (shared by collect + sale) ───────────────────── */
function selectPayment(method,context){
  const containerId=context==='collect'?'collect-pay-methods':'sale-pay-methods';
  document.querySelectorAll(`#${containerId} .pay-btn`).forEach(b=>b.classList.toggle('selected',b.dataset.method===method));
  if(context==='collect'){collectPayment=method;document.getElementById('collect-confirm').disabled=false;}
  else{salePayment=method;document.getElementById('sale-confirm').disabled=false;}
}

/* ── 10. PS CARDS RENDER + LIVE TIMERS ─────────────────────────────────── */
function renderShop(){
  const grid=document.getElementById('ps-grid');
  grid.innerHTML='';
  psState.forEach(ps=>{
    const card=document.createElement('div');
    const hasVisit=ps.visitSessions>0;
    card.className=`ps-card ${ps.status}${hasVisit&&ps.status==='idle'?' has-visit':''}`;
    card.id=`ps-card-${ps.id}`;
    const remaining=ps.status==='active'?ps.endTime-now():0;
    const pct=ps.status==='active'?Math.max(0,remaining/(SESSION_DURATION*1000)*100):(ps.status==='idle'?100:0);
    const barClass=pct<20?'danger':pct<40?'warning':'';
    const timerText=ps.status==='active'?fmt(remaining):ps.status==='expired'?'00:00':`${Math.floor(SESSION_DURATION/60).toString().padStart(2,'0')}:00`;
    const endTime = ps.endTime ? new Date(ps.endTime) : null;
    const startTimeStr = ps.startTime ? timeStr(ps.startTime) : null;
    const endTimeStr = endTime ? endTime.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true}) : null;
    card.innerHTML=`
      ${ps.status==='expired'?'<div class="expired-banner">⏰ TIME UP</div>':''}
      <div class="ps-card-header" style="${ps.status==='expired'?'margin-top:34px':''}">
        <div class="ps-name">PS ${ps.id}</div>
        <div class="ps-status ${ps.status}">${ps.status==='idle'?'Available':ps.status==='active'?'Playing':'Time Up'}</div>
      </div>
      ${hasVisit?`<div class="visit-strip">
        <div><div class="visit-strip-label">Current Customer</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${ps.visitSessions} session${ps.visitSessions!==1?'s':''}</div></div>
        <div class="visit-strip-count">${ps.visitSessions}</div>
        <div class="visit-strip-amount">${ps.visitSessions*PRICE} Birr</div>
      </div>`:''}
      <div class="ps-timer ${ps.status}" id="timer-${ps.id}">${timerText}</div>
      ${ps.status==='expired'?`<div class="overtime-row"><span class="overtime-label">⚠ Overtime</span><span class="overtime-timer" id="overtime-${ps.id}">00:00</span></div>`:'<div style="height:30px"></div>'}
      ${startTimeStr&&endTimeStr?`<div class="time-range">🕐 ${startTimeStr} → ${endTimeStr}</div>`:'<div style="height:18px"></div>'}
      <div class="ps-progress"><div class="ps-progress-bar ${barClass}" id="bar-${ps.id}" style="width:${pct}%"></div></div>
      <div class="ps-meta">
        <span>${ps.startTime?'Started '+timeStr(ps.startTime):hasVisit?'Waiting':'No customer'}</span>
        <span style="color:var(--accent2)">${getTodayVisits().filter(v=>v.psId===ps.id).length} visits today</span>
      </div>
      <div class="ps-actions" id="actions-${ps.id}">${buildActions(ps)}</div>`;
    grid.appendChild(card);
  });
  updateDayTotal();
}

function buildActions(ps){
  const h=ps.visitSessions>0;
  if(ps.status==='active') return `
    <button class="btn-start" style="background:transparent;border:1px solid var(--border2);color:var(--muted);cursor:default;flex:1">Running…</button>
    <button class="btn-stop" onclick="askStop(${ps.id})">■ Stop</button>`;
  return `
    <button class="btn-start" onclick="askStart(${ps.id})">${h?'▶ Next Session':'▶ Start Session — 20 Birr'}</button>
    ${h?`<button class="btn-collect" onclick="askCollect(${ps.id})">✓ Collect ${ps.visitSessions*PRICE} Birr</button>`:''}`;
}

function updateDayTotal(){
  const el=document.getElementById('day-total-display');
  const snackToday=itemSales.filter(s=>s.date===todayStr()).reduce((a,s)=>a+s.amount,0);
  if(el) el.textContent=`Today: ${getTodayRevenue()+snackToday} Birr`;
}

function startClock(){
  clearInterval(window._clockInt);
  window._clockInt=setInterval(()=>{
    const d=new Date();
    const cl=document.getElementById('live-clock');
    if(cl) cl.textContent=d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    tickTimers();
  },1000);
}

function tickTimers(){
  psState.forEach(ps=>{
    // tick overtime for expired cards
    if(ps.status==='expired'&&ps.expiredAt){
      const overEl=document.getElementById(`overtime-${ps.id}`);
      if(overEl) overEl.textContent=fmtUp(now()-ps.expiredAt);
    }
    if(ps.status!=='active') return;
    const remaining=ps.endTime-now();
    const timerEl=document.getElementById(`timer-${ps.id}`);
    const barEl=document.getElementById(`bar-${ps.id}`);
    if(!timerEl) return;
    if(remaining<=0){
      ps.status='expired';
      ps.expiredAt=now();
      savePsState();
      timerEl.textContent='00:00';timerEl.className='ps-timer expired';
      barEl.style.width='0%';barEl.className='ps-progress-bar danger';
      const card=document.getElementById(`ps-card-${ps.id}`);
      if(card){
        card.className='ps-card expired';
        if(!card.querySelector('.expired-banner')){
          const b=document.createElement('div');b.className='expired-banner';b.textContent='⏰ TIME UP';
          card.insertBefore(b,card.firstChild);
          const hdr=card.querySelector('.ps-card-header');if(hdr)hdr.style.marginTop='34px';
        }
        card.querySelector('.ps-status').textContent='Time Up';
        card.querySelector('.ps-status').className='ps-status expired';
        document.getElementById(`actions-${ps.id}`).innerHTML=buildActions(ps);
        updateVisitStrip(ps);
        // inject overtime row if not present
        if(!card.querySelector('.overtime-row')){
          const spacer=card.querySelector('.ps-timer').nextSibling;
          const ot=document.createElement('div');ot.className='overtime-row';
          ot.innerHTML=`<span class="overtime-label">⚠ Overtime</span><span class="overtime-timer" id="overtime-${ps.id}">00:00</span>`;
          card.querySelector('.ps-timer').insertAdjacentElement('afterend',ot);
        }
      }
      playAlarm();
    } else {
      const pct=remaining/(SESSION_DURATION*1000)*100;
      timerEl.textContent=fmt(remaining);
      barEl.style.width=pct+'%';
      barEl.className='ps-progress-bar'+(pct<20?' danger':pct<40?' warning':'');
    }
  });
}

function fmtUp(ms){
  const s=Math.floor(ms/1000);
  const m=Math.floor(s/60);
  return`${String(m).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
}

function updateVisitStrip(ps){
  const card=document.getElementById(`ps-card-${ps.id}`);if(!card) return;
  let strip=card.querySelector('.visit-strip');
  if(ps.visitSessions>0&&!strip){
    strip=document.createElement('div');strip.className='visit-strip';
    card.insertBefore(strip,card.querySelector('.ps-timer'));
  }
  if(strip){
    if(ps.visitSessions>0){
      strip.innerHTML=`<div><div class="visit-strip-label">Current Customer</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${ps.visitSessions} session${ps.visitSessions!==1?'s':''}</div></div>
        <div class="visit-strip-count">${ps.visitSessions}</div>
        <div class="visit-strip-amount">${ps.visitSessions*PRICE} Birr</div>`;
    } else { strip.remove(); }
  }
}

function playAlarm(){
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    [0,.3,.6].forEach(t=>{
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.connect(g);g.connect(ctx.destination);o.frequency.value=880;
      g.gain.setValueAtTime(.3,ctx.currentTime+t);
      g.gain.exponentialRampToValueAtTime(.001,ctx.currentTime+t+.25);
      o.start(ctx.currentTime+t);o.stop(ctx.currentTime+t+.25);
    });
  }catch(e){}
}

/* ── 11a. START SESSION ────────────────────────────────────────────────── */
function askStart(psId){
  pendingStartPS=psId;
  const ps=psState[psId-1],h=ps.visitSessions>0;
  document.getElementById('start-modal-title').textContent=h?`PS ${psId} — Session ${ps.visitSessions+1}`:`Start PS ${psId}`;
  document.getElementById('start-modal-body').textContent=h
    ?`Add another ${Math.floor(SESSION_DURATION/60)}-min session? (${ps.visitSessions+1} sessions = ${(ps.visitSessions+1)*PRICE} Birr total)`
    :`Start a ${Math.floor(SESSION_DURATION/60)}-minute session for PS ${psId}. Customer pays ${PRICE} Birr per session.`;
  document.getElementById('start-modal').style.display='flex';
}
document.getElementById('start-cancel').onclick=()=>{document.getElementById('start-modal').style.display='none';pendingStartPS=null;};
document.getElementById('start-confirm').onclick=()=>{
  document.getElementById('start-modal').style.display='none';
  if(pendingStartPS!==null) startSession(pendingStartPS);
  pendingStartPS=null;
};
function startSession(psId){
  const ps=psState[psId-1];
  ps.status='active';ps.startTime=now();ps.endTime=now()+SESSION_DURATION*1000;
  ps.expiredAt=null;
  ps.visitSessions+=1;if(!ps.visitStart) ps.visitStart=ps.startTime;
  savePsState();
  renderShop();
}

/* ── 11b. COLLECT PAYMENT ──────────────────────────────────────────────── */
let isSplitPayment=false;
let splitTotal=0;

function askCollect(psId){
  pendingCollectPS=psId;collectPayment=null;isSplitPayment=false;
  document.querySelectorAll('#collect-pay-methods .pay-btn').forEach(b=>b.classList.remove('selected'));
  document.getElementById('collect-confirm').disabled=true;
  document.getElementById('single-pay-section').style.display='block';
  document.getElementById('split-pay-section').style.display='none';
  document.getElementById('split-toggle-btn').textContent='🔀 Split Payment';
  const ps=psState[psId-1];
  splitTotal=ps.visitSessions*PRICE;
  document.getElementById('collect-desc').textContent=`PS ${psId} — customer is done.`;
  document.getElementById('collect-amount').textContent=`${splitTotal} Birr`;
  document.getElementById('collect-breakdown').textContent=`${ps.visitSessions} session${ps.visitSessions!==1?'s':''} × ${PRICE} Birr`;
  document.getElementById('collect-modal').style.display='flex';
}

function toggleSplitPayment(){
  isSplitPayment=!isSplitPayment;
  document.getElementById('single-pay-section').style.display=isSplitPayment?'none':'block';
  document.getElementById('split-pay-section').style.display=isSplitPayment?'block':'none';
  document.getElementById('split-toggle-btn').textContent=isSplitPayment?'← Single Payment':'🔀 Split Payment';
  if(isSplitPayment){
    document.getElementById('split-inputs').innerHTML=`
      <div class="split-row"><label>💵 Cash</label><input type="number" id="split-cash" min="0" oninput="updateSplitRemaining()" placeholder="0"/></div>
      <div class="split-row"><label>🏦 CBE</label><input type="number" id="split-cbe" min="0" oninput="updateSplitRemaining()" placeholder="0"/></div>
      <div class="split-row"><label>📱 TeleBirr</label><input type="number" id="split-telebirr" min="0" oninput="updateSplitRemaining()" placeholder="0"/></div>
      <div class="split-row"><label>🏧 BOA</label><input type="number" id="split-boa" min="0" oninput="updateSplitRemaining()" placeholder="0"/></div>`;
    updateSplitRemaining();
    document.getElementById('collect-confirm').disabled=true;
  } else {
    document.getElementById('collect-confirm').disabled = !collectPayment;
  }
}

function updateSplitRemaining(){
  const cash=parseFloat(document.getElementById('split-cash').value)||0;
  const cbe=parseFloat(document.getElementById('split-cbe').value)||0;
  const tb=parseFloat(document.getElementById('split-telebirr').value)||0;
  const boa=parseFloat(document.getElementById('split-boa').value)||0;
  const sum=cash+cbe+tb+boa;
  const remaining=splitTotal-sum;
  const el=document.getElementById('split-remaining');
  if(remaining===0){
    el.textContent=`✓ Fully covered — ${splitTotal} Birr`;
    el.style.color='var(--accent2)';
    document.getElementById('collect-confirm').disabled=false;
  } else if(remaining>0){
    el.textContent=`${remaining} Birr remaining`;
    el.style.color='var(--amber)';
    document.getElementById('collect-confirm').disabled=true;
  } else {
    el.textContent=`${Math.abs(remaining)} Birr over the total!`;
    el.style.color='var(--danger)';
    document.getElementById('collect-confirm').disabled=true;
  }
}

document.getElementById('collect-cancel').onclick=()=>{document.getElementById('collect-modal').style.display='none';pendingCollectPS=null;};
document.getElementById('collect-confirm').onclick=()=>{
  document.getElementById('collect-modal').style.display='none';
  if(pendingCollectPS!==null) collectAndReset(pendingCollectPS);
  pendingCollectPS=null;
};
function collectAndReset(psId){
  const ps=psState[psId-1];
  const overSecs=ps.expiredAt?Math.floor((now()-ps.expiredAt)/1000):0;
  const overFmt=overSecs>0?fmtUp(overSecs*1000):'00:00';
  const sessionEndTs = ps.endTime || ps.expiredAt || now();

  let paymentMethod, splitDetail='';
  if(isSplitPayment){
    const cash=parseFloat(document.getElementById('split-cash').value)||0;
    const cbe=parseFloat(document.getElementById('split-cbe').value)||0;
    const tb=parseFloat(document.getElementById('split-telebirr').value)||0;
    const boa=parseFloat(document.getElementById('split-boa').value)||0;
    const parts=[];
    if(cash>0) parts.push(`Cash:${cash}`);
    if(cbe>0) parts.push(`CBE:${cbe}`);
    if(tb>0) parts.push(`TeleBirr:${tb}`);
    if(boa>0) parts.push(`BOA:${boa}`);
    paymentMethod='split';
    splitDetail=parts.join(', ');
  } else {
    paymentMethod=collectPayment||'cash';
  }

  const visit={id:`v_${now()}_${psId}`,psId,date:todayStr(),
    visitStart:ps.visitStart||now(),collectedAt:now(),
    sessionEnd: sessionEndTs,
    overtime:overFmt,
    sessions:ps.visitSessions,amount:ps.visitSessions*PRICE,
    paymentMethod, splitDetail};
  visits.push(visit);saveVisits();
  syncToSheets({psId:visit.psId,date:visit.date,
    startTime:timeStr(visit.visitStart),
    endTime:timeStr(visit.sessionEnd),
    overtime:visit.overtime,
    sessions:visit.sessions,
    duration:Math.floor(SESSION_DURATION/60),
    amount:visit.amount,
    paymentMethod:visit.paymentMethod,
    splitDetail:visit.splitDetail,
    collectedAt:timeStr(visit.collectedAt)},'visit');
  ps.status='idle';ps.startTime=null;ps.endTime=null;ps.visitSessions=0;ps.visitStart=null;ps.expiredAt=null;
  savePsState();
  renderShop();updateSyncUI();
}

/* ── 11c. STOP SESSION EARLY ───────────────────────────────────────────── */
function askStop(psId){pendingStopPS=psId;document.getElementById('stop-modal').style.display='flex';}
document.getElementById('stop-cancel').onclick=()=>{document.getElementById('stop-modal').style.display='none';pendingStopPS=null;};
document.getElementById('stop-confirm').onclick=()=>{
  document.getElementById('stop-modal').style.display='none';
  if(pendingStopPS!==null){psState[pendingStopPS-1].status='expired';savePsState();renderShop();}
  pendingStopPS=null;
};

/* ── 12a. GAME SETTINGS (duration + price) ─────────────────────────────── */
function saveGameSettings(){
  const mins=parseInt(document.getElementById('setting-duration').value)||7;
  const price=parseInt(document.getElementById('setting-price').value)||20;
  SESSION_DURATION=mins*60;
  PRICE=price;
  localStorage.setItem('ps_session_duration',SESSION_DURATION);
  localStorage.setItem('ps_price',PRICE);
  const msg=document.getElementById('settings-saved');
  msg.style.display='block';
  setTimeout(()=>msg.style.display='none',3000);
}

/* ── 12b. MANAGE SHOP ITEMS ────────────────────────────────────────────── */
function renderManageItems(){
  const durInput=document.getElementById('setting-duration');
  const priceInput=document.getElementById('setting-price');
  if(durInput) durInput.value=Math.floor(SESSION_DURATION/60);
  if(priceInput) priceInput.value=PRICE;
  document.getElementById('manage-items-list').innerHTML=shopItems.map((item,i)=>`
    <div class="item-manage-row">
      <div class="item-manage-emoji">${item.emoji}</div>
      <div class="item-manage-name">${item.name}</div>
      <input class="item-price-input" type="number" value="${item.price}" onchange="updateItemPrice('${item.id}',this.value)" />
      <span style="font-size:12px;color:var(--muted)">Birr</span>
      <button class="item-del-btn" onclick="deleteItem('${item.id}')">Delete</button>
    </div>`).join('');
}
function updateItemPrice(id,val){
  const item=shopItems.find(i=>i.id===id);
  if(item){item.price=parseInt(val)||0;saveItems();renderItems();}
}
function deleteItem(id){
  const idx=shopItems.findIndex(i=>i.id===id);
  if(idx>-1){shopItems.splice(idx,1);saveItems();renderManageItems();renderItems();}
}
function addItem(){
  const emoji=document.getElementById('new-item-emoji').value.trim()||'📦';
  const name=document.getElementById('new-item-name').value.trim();
  const price=parseInt(document.getElementById('new-item-price').value)||0;
  if(!name) return;
  shopItems.push({id:`item_${now()}`,emoji,name,price});
  saveItems();
  document.getElementById('new-item-emoji').value='';
  document.getElementById('new-item-name').value='';
  document.getElementById('new-item-price').value='';
  renderManageItems();renderItems();
}

/* ── 13. DASHBOARD RENDER ──────────────────────────────────────────────────
   The owner dashboard renders from `dashVisits` / `dashSales`, which are
   pulled from the Google Sheet (all devices / whole shop) when online, and
   fall back to this device's local records when offline. The Customer Visit
   Log date filter (`dashFilter`) drives the ENTIRE PS tab — metrics, payment
   breakdown, sessions-per-console and the log all respect it.
   ------------------------------------------------------------------------- */
let dashFilter='all', itemsFilter='all';

// Normalized data the dashboard renders from (source of truth for the owner view)
let dashVisits=[], dashSales=[], dashSource='local';

// ── Normalizers → one common shape for both sheet rows and local records ──
function normalizeRemoteVisit(r){
  return {
    psId: parseInt(String(r['Console']||'').replace(/\D/g,''))||0,
    date: String(r['Date']||'').trim(),
    startTimeStr: r['Start Time']||'',
    endTimeStr: r['End Time']||'',
    sessions: parseInt(r['Sessions'])||0,
    minutes: parseInt(r['Minutes']) || (parseInt(r['Sessions'])||0)*Math.floor(SESSION_DURATION/60),
    amount: parseFloat(r['Amount'])||0,
    paymentMethod: String(r['Payment']||'cash').toLowerCase(),
    splitDetail: r['Split Detail']||'',
    overtime: r['Overtime']||'',
    collectedAt: r['Collected At']||''
  };
}
function normalizeRemoteSale(r){
  return {
    date: String(r['Date']||'').trim(),
    time: r['Time']||'',
    item: r['Item']||'',
    itemId: (shopItems.find(i=>i.name===r['Item'])||{}).id||'',
    qty: parseInt(r['Qty'])||0,
    amount: parseFloat(r['Amount'])||0,
    payment: String(r['Payment']||'cash').toLowerCase()
  };
}
function normalizeLocalVisit(v){
  return {
    psId:v.psId, date:v.date,
    startTimeStr:timeStr(v.visitStart),
    endTimeStr:v.sessionEnd?timeStr(v.sessionEnd):'',
    sessions:v.sessions, minutes:v.sessions*Math.floor(SESSION_DURATION/60),
    amount:v.amount, paymentMethod:v.paymentMethod||'cash',
    splitDetail:v.splitDetail||'', overtime:v.overtime||'',
    collectedAt:v.collectedAt?timeStr(v.collectedAt):''
  };
}
function normalizeLocalSale(s){
  return {date:s.date,time:s.time,item:s.item,itemId:s.itemId,qty:s.qty,amount:s.amount,payment:s.payment};
}

// ── Pull all-store data from the sheet; fall back to this device's data ───
async function refreshDashboardData(){
  const src=document.getElementById('dash-source');
  if(src) src.textContent='⏳ Loading data from Google Sheet…';
  let loaded=false;
  if(scriptUrl && isOnline()){
    try{
      const res=await fetch(`${scriptUrl}?action=getAll`,{mode:'cors'});
      const data=await res.json();
      if(data && data.ok){
        dashVisits=(data.visits||[]).map(normalizeRemoteVisit);
        dashSales=(data.sales||[]).map(normalizeRemoteSale);
        dashSource='sheet'; loaded=true;
      }
    }catch(e){ /* fall through to local data below */ }
  }
  if(!loaded){
    dashVisits=visits.map(normalizeLocalVisit);
    dashSales=itemSales.map(normalizeLocalSale);
    dashSource='local';
  }
  renderDashboard();
  if(document.getElementById('tab-items').classList.contains('active')) renderItemsDash();
}

// ── Filter helpers (dashFilter drives the whole PS tab) ────────────────────
function filterByDash(list){
  if(dashFilter==='today') return list.filter(x=>x.date===todayStr());
  if(dashFilter==='all') return list;
  return list.filter(x=>x.date===dashFilter);
}
function scopeLabel(){
  return dashFilter==='today'?'Today':dashFilter==='all'?'All-Time':dateLabel(dashFilter);
}
function dateLabel(iso){
  const d=new Date(iso+'T00:00:00');
  return isNaN(d.getTime())?iso:d.toLocaleDateString('en-GB',{day:'2-digit',month:'short'});
}

function renderDashboard(){
  const scope=scopeLabel();
  const fVisits=filterByDash(dashVisits);
  const fSales=filterByDash(dashSales);

  document.getElementById('dash-date').textContent=
    new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  const srcEl=document.getElementById('dash-source');
  if(srcEl) srcEl.textContent=dashSource==='sheet'
    ? '🟢 Showing all shops — live from Google Sheet'
    : '📱 Showing this device only — offline / sheet unreachable';

  // Metrics (respect the date filter; Total Revenue stays all-time)
  const psRev=fVisits.reduce((s,v)=>s+v.amount,0);
  const snackRev=fSales.reduce((a,s)=>a+s.amount,0);
  const totalAll=dashVisits.reduce((s,v)=>s+v.amount,0)+dashSales.reduce((a,s)=>a+s.amount,0);
  document.getElementById('metrics-grid').innerHTML=[
    {label:`${scope} Customers`,value:fVisits.length,cls:'purple'},
    {label:`${scope} PS Revenue`,value:`${psRev} Birr`,cls:'green'},
    {label:`${scope} Snack Revenue`,value:`${snackRev} Birr`,cls:'amber'},
    {label:'Total Revenue (All-Time)',value:`${totalAll} Birr`,cls:'green'},
  ].map(m=>`<div class="metric-card"><div class="metric-label">${m.label}</div><div class="metric-value ${m.cls}">${m.value}</div></div>`).join('');

  // Payment breakdown (filtered)
  const ptitle=document.getElementById('pay-breakdown-title');
  if(ptitle) ptitle.textContent=`Revenue by Payment (${scope})`;
  const methods=['cash','cbe','telebirr','boa'];
  const icons={cash:'💵',cbe:'🏦',telebirr:'📱',boa:'🏧'};
  document.getElementById('pay-breakdown').innerHTML=methods.map(m=>{
    const v=fVisits.filter(x=>x.paymentMethod===m);
    const clr=m==='cash'?'#4ade80':m==='cbe'?'#60a5fa':m==='telebirr'?'var(--amber)':'var(--danger)';
    return`<div class="pay-stat"><div class="pay-stat-label">${icons[m]} ${m.toUpperCase()}</div>
      <div class="pay-stat-val" style="color:${clr}">${v.reduce((s,x)=>s+x.amount,0)} Birr</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px">${v.length} customer${v.length!==1?'s':''}</div></div>`;
  }).join('');

  // Sessions per console (filtered)
  const maxS=Math.max(1,...Array.from({length:NUM_PS},(_,i)=>fVisits.filter(v=>v.psId===i+1).reduce((s,v)=>s+v.sessions,0)));
  document.getElementById('ps-bars').innerHTML=Array.from({length:NUM_PS},(_,i)=>{
    const s=fVisits.filter(v=>v.psId===i+1).reduce((a,v)=>a+v.sessions,0);
    return`<div class="ps-bar-row"><div class="ps-bar-label">PS ${i+1}</div>
      <div class="ps-bar-track"><div class="ps-bar-fill" style="width:${(s/maxS)*100}%"></div></div>
      <div class="ps-bar-val">${s*PRICE}B</div></div>`;
  }).join('');

  // Filter bar: All / Today / recent dates + a date picker for ANY day
  const dates=[...new Set(dashVisits.map(v=>v.date))].filter(Boolean).sort().reverse();
  const pickerVal=(dashFilter!=='all'&&dashFilter!=='today')?dashFilter:'';
  document.getElementById('filter-bar').innerHTML=
    `<button class="filter-btn ${dashFilter==='all'?'active':''}" onclick="setFilter('all')">All</button>
     <button class="filter-btn ${dashFilter==='today'?'active':''}" onclick="setFilter('today')">Today</button>`+
    dates.slice(0,7).map(d=>`<button class="filter-btn ${dashFilter===d?'active':''}" onclick="setFilter('${d}')">${dateLabel(d)}</button>`).join('')+
    `<input type="date" id="date-filter" class="filter-btn" style="padding:5px 10px;color:var(--text)"
       value="${pickerVal}" onchange="setFilter(this.value||'all')" title="Pick any date"/>`;

  // Customer visit log (filtered, newest first)
  const rows=[...fVisits].reverse();
  const tbl=document.getElementById('sessions-table');
  if(!rows.length){tbl.innerHTML='<div class="empty-state">No visits for this filter.</div>';}
  else{
    tbl.innerHTML=`<div class="table-row header" style="grid-template-columns:50px 70px 70px 55px 60px 80px 80px">
      <span>PS</span><span>Time</span><span>Date</span><span>Sess.</span><span>Mins</span><span>Amount</span><span>Payment</span></div>`+
    rows.map(v=>`<div class="table-row" style="grid-template-columns:50px 70px 70px 55px 60px 80px 80px">
      <span><span class="ps-badge">${v.psId}</span></span>
      <span style="color:var(--muted)">${v.startTimeStr}</span>
      <span style="color:var(--muted)">${dateLabel(v.date)}</span>
      <span style="color:var(--amber)">${v.sessions}</span>
      <span style="color:var(--muted)">${v.minutes}m</span>
      <span class="amount-cell">${v.amount}B</span>
      <span><span class="pay-pill ${v.paymentMethod||'cash'}">${(v.paymentMethod||'cash').toUpperCase()}</span></span>
    </div>`).join('');
  }
  updateSyncUI();
}

function setFilter(f){dashFilter=f;renderDashboard();}

function renderItemsDash(){
  const allSales=dashSales;
  const filt=list=>itemsFilter==='today'?list.filter(s=>s.date===todayStr()):itemsFilter==='all'?list:list.filter(s=>s.date===itemsFilter);
  const fSales=filt(allSales);
  const rev=fSales.reduce((a,s)=>a+s.amount,0);
  const scope=itemsFilter==='today'?'Today':itemsFilter==='all'?'All-Time':dateLabel(itemsFilter);
  const topItem=shopItems.map(i=>({...i,total:allSales.filter(s=>s.itemId===i.id||s.item===i.name).reduce((a,s)=>a+s.qty,0)}))
    .sort((a,b)=>b.total-a.total)[0];
  document.getElementById('items-metrics').innerHTML=[
    {label:`${scope} Sales`,value:fSales.length,cls:'purple'},
    {label:`${scope} Revenue`,value:`${rev} Birr`,cls:'green'},
    {label:'Top Item',value:topItem&&topItem.total?`${topItem.emoji} ${topItem.name}`:'—',cls:'amber'},
    {label:'Total Snack Revenue',value:`${allSales.reduce((a,s)=>a+s.amount,0)} Birr`,cls:'green'},
  ].map(m=>`<div class="metric-card"><div class="metric-label">${m.label}</div><div class="metric-value ${m.cls}" style="font-size:${m.label==='Top Item'?'18px':'28px'}">${m.value}</div></div>`).join('');

  const dates2=[...new Set(allSales.map(s=>s.date))].filter(Boolean).sort().reverse();
  const pickerVal=(itemsFilter!=='all'&&itemsFilter!=='today')?itemsFilter:'';
  document.getElementById('items-filter-bar').innerHTML=
    `<button class="filter-btn ${itemsFilter==='all'?'active':''}" onclick="setItemsFilter('all')">All</button>
     <button class="filter-btn ${itemsFilter==='today'?'active':''}" onclick="setItemsFilter('today')">Today</button>`+
    dates2.slice(0,7).map(d=>`<button class="filter-btn ${itemsFilter===d?'active':''}" onclick="setItemsFilter('${d}')">${dateLabel(d)}</button>`).join('')+
    `<input type="date" class="filter-btn" style="padding:5px 10px;color:var(--text)"
       value="${pickerVal}" onchange="setItemsFilter(this.value||'all')" title="Pick any date"/>`;

  const rows=[...fSales].reverse();
  const tbl=document.getElementById('items-table');
  if(!rows.length){tbl.innerHTML='<div class="empty-state">No snack sales for this filter.</div>';}
  else{
    tbl.innerHTML=`<div class="table-row header" style="grid-template-columns:1fr 70px 60px 70px 80px">
      <span>Item</span><span>Time</span><span>Qty</span><span>Amount</span><span>Payment</span></div>`+
    rows.map(s=>`<div class="table-row" style="grid-template-columns:1fr 70px 60px 70px 80px">
      <span style="font-weight:600">${(shopItems.find(i=>i.id===s.itemId||i.name===s.item)||{}).emoji||'📦'} ${s.item}</span>
      <span style="color:var(--muted)">${s.time}</span>
      <span style="color:var(--amber)">×${s.qty}</span>
      <span class="amount-cell">${s.amount}B</span>
      <span><span class="pay-pill ${s.payment}">${(s.payment||'cash').toUpperCase()}</span></span>
    </div>`).join('');
  }
}
function setItemsFilter(f){itemsFilter=f;renderItemsDash();}

/* ── 14. CSV EXPORT + CLEAR DATA ───────────────────────────────────────── */
// Export what the owner is currently viewing (all-store data when loaded from
// the sheet, respecting the active date filter).
document.getElementById('export-btn').onclick=()=>{
  const v1=filterByDash(dashVisits), s1=filterByDash(dashSales);
  const h1='Console,Date,StartTime,EndTime,Sessions,Minutes,Amount(Birr),Payment,Overtime\n';
  const r1=v1.map(v=>`PS ${v.psId},${v.date},${v.startTimeStr},${v.endTimeStr},${v.sessions},${v.minutes},${v.amount},${v.paymentMethod||'cash'},${v.overtime||''}`).join('\n');
  const h2='\n\nItem,Date,Time,Qty,Amount,Payment\n';
  const r2=s1.map(s=>`${s.item},${s.date},${s.time},${s.qty},${s.amount},${s.payment}`).join('\n');
  const blob=new Blob([h1+r1+h2+r2],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download=`ps-house-${todayStr()}.csv`;a.click();
  URL.revokeObjectURL(url);
};
// Clears only THIS device's local records + pending sync queue (the Google
// Sheet is the shared source of truth and is not touched here).
document.getElementById('clear-btn').onclick=()=>{
  if(confirm('Delete all data stored ON THIS DEVICE? The Google Sheet is not affected. This cannot be undone.')){
    visits.length=0;itemSales.length=0;syncQueue=[];
    saveVisits();saveSales();saveQueue();
    psState.forEach(p=>Object.assign(p,{status:'idle',startTime:null,endTime:null,visitSessions:0,visitStart:null,expiredAt:null}));
    savePsState();
    refreshDashboardData();
  }
};

/* ── 15. BOOT + SERVICE WORKER ─────────────────────────────────────────── */
if(isOnline()&&syncQueue.length>0) flushQueue();
updateSyncUI();

// PWA: register service worker for offline support
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  });
}
