/* =========================================================
   OKV CMS Online — shared client code
   Used by app.html, signup.html, reset-password.html, demo.html,
   pricing.html, and the legal pages (privacy-policy.html,
   terms-of-service.html, refund-policy.html).
   ========================================================= */

// >>> SET THIS to your Apps Script Web App deployment URL <<<
const API_BASE_URL = 'https://script.google.com/macros/s/AKfycbxM-bBSSnDyibkfcgHK6iAo--rbG85Kf28wCBJTbdvPYnJl2spmohBH2JZRz3nA-UkS/exec';

/* ---------- Password hashing (client-side SHA-256) ---------- */
async function sha256Hex(text){
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/* ---------- API client ----------
   Uses text/plain content-type on purpose: Apps Script Web Apps don't
   handle CORS preflight (OPTIONS) requests, and a text/plain POST body
   is treated as a "simple request" by the browser, so no preflight is
   triggered. The body is still a JSON string; Code.gs parses it. */
async function api(action, payload){
  const res = await fetch(API_BASE_URL, {
    method:'POST',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body: JSON.stringify(Object.assign({action}, payload||{})),
  });
  return res.json();
}

/* ---------- Session ---------- */
function saveSession(session){ localStorage.setItem('okv_online_session', JSON.stringify(session)); }
function getSession(){ try{ return JSON.parse(localStorage.getItem('okv_online_session')); }catch(e){ return null; } }
function clearSession(){ localStorage.removeItem('okv_online_session'); }

/* ---------- Online/offline ---------- */
function isOnline(){ return navigator.onLine; }

/* =========================================================
   IndexedDB — local cache of synced records, keyed by
   [module, recordId]. Works for any module/data shape; the
   actual church-management modules can be layered on top of
   this the same way Phase 1 uses IndexedDB.
   ========================================================= */
const OKV_IDB_NAME = 'okv_cms_online_db';
const OKV_IDB_VERSION = 1;
let okvIdb = null;

function idbOpen(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OKV_IDB_NAME, OKV_IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains('records')){
        const store = db.createObjectStore('records', {keyPath:'key'}); // key = module+'::'+recordId
        store.createIndex('module', 'module', {unique:false});
        store.createIndex('dirty', 'dirty', {unique:false});
      }
      if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath:'key'});
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}
async function ensureIdb(){ if(!okvIdb) okvIdb = await idbOpen(); return okvIdb; }
function tx(store, mode){ return okvIdb.transaction(store, mode).objectStore(store); }
function reqP(req){ return new Promise((res, rej) => { req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error); }); }

async function localGetAll(moduleName){
  await ensureIdb();
  const all = await reqP(tx('records','readonly').index('module').getAll(moduleName));
  return all.filter(r => !r.deleted);
}
async function localPut(moduleName, recordId, data, opts){
  await ensureIdb();
  opts = opts || {};
  const rec = {
    key: moduleName+'::'+recordId, module: moduleName, recordId, data,
    updatedAt: opts.updatedAt || new Date().toISOString(),
    deleted: !!opts.deleted,
    dirty: opts.dirty !== undefined ? opts.dirty : true,
  };
  await reqP(tx('records','readwrite').put(rec));
  return rec;
}
async function localDelete(moduleName, recordId){
  // Soft delete so the deletion itself can sync to the server.
  const existing = await reqP(tx('records','readonly').get(moduleName+'::'+recordId));
  const data = existing ? existing.data : {};
  return localPut(moduleName, recordId, data, {deleted:true, dirty:true});
}
async function localDirtyRecords(){
  await ensureIdb();
  const all = await reqP(tx('records','readonly').getAll());
  return all.filter(r => r.dirty);
}
async function markClean(keys){
  await ensureIdb();
  const store = tx('records','readwrite');
  for(const k of keys){
    const rec = await reqP(store.get(k));
    if(rec){ rec.dirty = false; await reqP(store.put(rec)); }
  }
}
async function metaGet(key){
  await ensureIdb();
  try{ const r = await reqP(tx('meta','readonly').get(key)); return r ? r.value : null; }catch(e){ return null; }
}
async function metaSet(key, value){
  await ensureIdb();
  await reqP(tx('meta','readwrite').put({key, value}));
}

/* =========================================================
   Sync engine — pulls remote changes, pushes local dirty
   records, reconciles by updatedAt (last write wins).
   ========================================================= */
let syncInProgress = false;
async function runSync(onNotify){
  if(syncInProgress || !isOnline()) return {skipped:true};
  const session = getSession();
  if(!session) return {skipped:true};
  syncInProgress = true;
  try{
    const since = (await metaGet('lastSyncTime')) || '1970-01-01T00:00:00.000Z';
    const pullRes = await api('syncPull', {token:session.token, orgId:session.orgId, userId:session.id, since});
    if(pullRes.error){ if(onNotify) onNotify('error', pullRes.message || pullRes.error); return {error:pullRes.error};  }
    for(const rec of pullRes.records){
      await localPut(rec.module, rec.recordId, rec.data, {updatedAt:rec.updatedAt, deleted:rec.deleted, dirty:false});
    }

    const dirty = await localDirtyRecords();
    let pushedCount = 0;
    if(dirty.length){
      const pushRes = await api('syncPush', {
        token:session.token, orgId:session.orgId, userId:session.id,
        records: dirty.map(r => ({module:r.module, recordId:r.recordId, data:r.data, deleted:r.deleted, updatedAt:r.updatedAt})),
      });
      if(pushRes.error){ if(onNotify) onNotify('error', pushRes.message || pushRes.error); }
      else{
        await markClean(dirty.map(r=>r.key));
        pushedCount = dirty.length;
      }
    }

    await metaSet('lastSyncTime', pullRes.serverTime);
    const total = pullRes.records.length + pushedCount;
    if(onNotify && total > 0) onNotify('success', `Synced ${total} change${total===1?'':'s'}.`);
    return {ok:true, pulled:pullRes.records.length, pushed:pushedCount};
  } catch(err){
    if(onNotify) onNotify('error', 'Sync failed: could not reach the server.');
    return {error:String(err)};
  } finally {
    syncInProgress = false;
  }
}

function initAutoSync(onNotify, intervalMs){
  intervalMs = intervalMs || 60000;
  runSync(onNotify);
  setInterval(() => runSync(onNotify), intervalMs);
  window.addEventListener('online', () => runSync(onNotify));
}

/* ---------- Shared password show/hide toggle ----------
   Used on every password field across the site. Markup pattern:
   <div class="password-wrap">
     <input type="password" class="form-control" id="someId">
     <button type="button" class="password-toggle-btn" onclick="togglePasswordVisibility('someId')" tabindex="-1" aria-label="Show password"><i class="bi bi-eye"></i></button>
   </div>
   The button must immediately follow the input in the DOM (siblings) so
   this can find it without needing a second id. */
function togglePasswordVisibility(inputId){
  const input = document.getElementById(inputId);
  if(!input) return;
  const btn = input.nextElementSibling;
  const icon = btn ? btn.querySelector('i') : null;
  if(input.type === 'password'){
    input.type = 'text';
    if(icon){ icon.classList.remove('bi-eye'); icon.classList.add('bi-eye-slash'); }
    if(btn) btn.setAttribute('aria-label', 'Hide password');
  } else {
    input.type = 'password';
    if(icon){ icon.classList.remove('bi-eye-slash'); icon.classList.add('bi-eye'); }
    if(btn) btn.setAttribute('aria-label', 'Show password');
  }
}
