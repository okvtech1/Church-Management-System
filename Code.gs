/* =========================================================
   OKV Church Management System — Online (Subscribe) Backend
   Google Apps Script + Google Sheets — PER-TENANT ARCHITECTURE

   ARCHITECTURE (read this before editing)
   -----------------------------------------------------------
   • MASTER spreadsheet (MASTER_SHEET_ID) — small, never holds member/
     attendance/finance data. It holds:
       - Tenants     : one row per organization (registry: name, admin
                        contact, spreadsheet ID, plan, subscription/trial
                        dates, status, and the cell-capacity numbers).
       - EmailIndex  : email -> orgId, so login can find which tenant
                        spreadsheet to open before anything else is known.
       - ResetIndex  : password-reset token -> orgId (same reason).
       - PlatformUsers: the Super Admin account(s) only.
       - PaymentRequests, Settings : platform-wide, small, unchanged from
                        the previous single-sheet design.
   • TENANT spreadsheets — one per organization, created automatically at
     signup (SpreadsheetApp.create). Each holds that org's own "Users" and
     "Data" tabs ONLY. This is where cell growth actually happens, and
     each org is capped independently by Sheets' 10,000,000-cell limit.
   • getOrgSpreadsheet(orgId) is the ONLY place that resolves a tenant's
     spreadsheet. Every handler goes through it (or the usersSheetFor /
     dataSheetFor wrappers below) instead of a hardcoded/active-sheet
     reference. It's backed by a short-lived script cache so repeated
     lookups don't re-scan the Tenants sheet on every call.

   SETUP (see SETUP_GUIDE.md for the full walkthrough):
   1. Create a new, blank Google Sheet — this becomes your MASTER sheet.
      Copy its ID into MASTER_SHEET_ID below.
   2. Paste this whole file into the Apps Script editor (Extensions > Apps
      Script) bound to that Master sheet.
   3. Set RESET_PASSWORD_BASE_URL below to wherever you host
      reset-password.html.
   4. Run initializeMasterSheets() once from the editor. This creates
      Tenants / EmailIndex / ResetIndex / PlatformUsers / PaymentRequests /
      Settings on the Master sheet. Tenant spreadsheets are created
      automatically per-org at signup — you never create those by hand.
   5. Run createSuperAdmin() once to create your own Super Admin login.
   6. Deploy > New deployment > type: Web app. Execute as: Me. Who has
      access: Anyone. Copy the deployment URL into API_BASE_URL in
      common.js — every page shares that one constant.
   7. Add two time-driven triggers (clock icon in the Apps Script editor):
        - checkAllTenantsCapacity  → daily (or weekly) — see section below.
        - processPaymentRequests   → every 15 minutes.
        - sendRenewalReminders     → once a day.
   8. If you have an existing single-sheet install, run
      migrateLegacySingleSheetToPerTenant('OLD_SHEET_ID_HERE') once — see
      the "One-time migration" section near the bottom of this file.
   ========================================================= */

const MASTER_SHEET_ID = 'PASTE_YOUR_MASTER_GOOGLE_SHEET_ID_HERE';
const RESET_PASSWORD_BASE_URL = 'https://yourdomain.com/reset-password.html'; // where you host reset-password.html
const APP_NAME = 'OKV Church Management System';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;         // 30 minutes
const TRIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;      // 7-day free trial

// Business contact, bank, and payment details live in the Settings sheet
// on the Master spreadsheet — edit them from the Super Admin dashboard's
// System Settings tab, not here. DEFAULT_SETTINGS below is only what a
// brand-new install starts with, seeded once by initializeMasterSheets().

// ---- Master spreadsheet tabs ----
const TENANTS_HEADERS = [
  'orgId','orgName','adminName','adminEmail','adminPhone','spreadsheetId',
  'status','subscriptionStatus','subscriptionPlan','billingCycle','subscriptionExpiry','trialEndsAt','lastReminderSentAt',
  'userCount',
  // Cell-capacity monitoring (Super Admin dashboard only — see section below)
  'cellsUsed','cellsPercent','cellGrowthPerDay','estDaysTo90','capacityStatus','lastCapacityCheckAt',
  // Consent audit trail — proof the Admin agreed to the Terms of Service and
  // Privacy Policy at signup, with a timestamp. Required by handleSignup
  // (see below); left blank for accounts migrated from before these pages
  // existed, since we have no record of their original consent.
  'termsAcceptedAt',
  'createdAt','updatedAt',
];
const EMAIL_INDEX_HEADERS = ['email','orgId'];       // login routing only — no credentials here
const RESET_INDEX_HEADERS = ['token','orgId','expiresAt'];
const PAYMENTS_HEADERS = ['id','orgId','orgName','userId','fullName','email','phone','plan','billingCycle','note','status','processed','createdAt','processedAt'];
const SETTINGS_HEADERS = ['key','value']; // single row: key='config', value=JSON string (see DEFAULT_SETTINGS)

// ---- Tenant spreadsheet tabs (created per-org) ----
// Subscription/trial/plan fields live on the Tenants row now, not per user —
// every user in an org shares one subscription, so it's stored once, in the
// Master registry, and merged onto the user object at request time (see
// publicUser). That's also what per-tenant capacity monitoring depends on.
const USERS_HEADERS = ['id','orgId','orgName','username','email','phone','passwordHash','isAdmin','isSuperAdmin','roles','status','sessionToken','sessionExpiry','resetToken','resetTokenExpiry','createdAt','updatedAt'];
const DATA_HEADERS   = ['id','orgId','userId','module','recordId','dataJson','updatedAt','updatedBy','deleted'];

// Everything here can be changed later from the Super Admin dashboard —
// this is only what a brand-new install starts with.
const DEFAULT_SETTINGS = {
  branding: {
    appName: 'OKV Church Management System',
    tagline: 'Offline & Online Church Management',
    primaryColor: '#0b1b3a',
    accentColor: '#d4af37',
    logoBase64: '', // data URL; empty = use the default building icon
  },
  contact: {
    email: 'technologyokv@gmail.com',
    phone: '+2348104141138',
    website: 'www.okvtechnology.com',
  },
  manualPayment: {
    enabled: true,
    accountNumber: '8104141138',
    bankName: 'OPA MFB',
    accountName: 'OLASILE KEHINDE VICTOR',
  },
  gateways: {
    paystack: {enabled:false, publicKey:'', secretKey:''},
    flutterwave: {enabled:false, publicKey:'', secretKey:''},
    remita: {enabled:false, merchantId:'', apiKey:'', serviceTypeId:''},
  },
  sms: {provider:'', apiKey:'', senderId:''},           // e.g. provider:'termii'
  whatsapp: {provider:'', apiKey:'', senderNumber:''},  // e.g. provider:'termii' or 'whatsapp_business'
  plans: {
    Starter:      {Monthly:7500,  'Bi-Annual':40000,  Yearly:72000,  suitedFor:'Small churches and single-branch congregations just digitizing their records.'},
    Professional: {Monthly:15000, 'Bi-Annual':80000,  Yearly:144000, suitedFor:'Multi-branch churches and ministries needing reports, exports and full team access.'},
  },
};

/* ---------- Platform sender identity — OKV Technology Consults' own outgoing
   email (never the individual church's own emails to its members/team, which
   keep sending as-is). Used for every email OKV itself sends: signup
   welcome, password reset, payment notifications, renewal reminders,
   capacity alerts, and Super Admin broadcasts to org admins. */
function platformSenderName(settings){
  const s = settings || getSettings();
  return 'OKV Technology Consults — ' + (s.branding.appName || APP_NAME);
}
function platformReplyTo(settings){
  const s = settings || getSettings();
  return s.contact.email;
}

/* ---------- One-time setup: Master spreadsheet ---------- */
function initializeMasterSheets(){
  const ss = SpreadsheetApp.openById(MASTER_SHEET_ID);

  const ensure = (name, headers) => {
    let sheet = ss.getSheetByName(name);
    if(!sheet) sheet = ss.insertSheet(name);
    sheet.clear();
    sheet.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return sheet;
  };

  ensure('Tenants', TENANTS_HEADERS);
  ensure('EmailIndex', EMAIL_INDEX_HEADERS);
  ensure('ResetIndex', RESET_INDEX_HEADERS);
  ensure('PlatformUsers', USERS_HEADERS);
  ensure('PaymentRequests', PAYMENTS_HEADERS);

  let settings = ss.getSheetByName('Settings');
  if(!settings) settings = ss.insertSheet('Settings');
  settings.clear();
  settings.getRange(1,1,1,SETTINGS_HEADERS.length).setValues([SETTINGS_HEADERS]).setFontWeight('bold');
  settings.setFrozenRows(1);
  settings.getRange(2,1,1,2).setValues([['config', JSON.stringify(DEFAULT_SETTINGS)]]);

  const sheet1 = ss.getSheetByName('Sheet1');
  if(sheet1) ss.deleteSheet(sheet1);

  Logger.log('Master sheets initialized: Tenants, EmailIndex, ResetIndex, PlatformUsers, PaymentRequests, Settings');
}

/* Creates the two tabs a brand-new TENANT spreadsheet needs. Called at
   signup and by the migration script — never by hand. */
function initializeTenantSheets(ss){
  let users = ss.getSheetByName('Users');
  if(!users) users = ss.insertSheet('Users');
  users.clear();
  users.getRange(1,1,1,USERS_HEADERS.length).setValues([USERS_HEADERS]).setFontWeight('bold');
  users.setFrozenRows(1);

  let data = ss.getSheetByName('Data');
  if(!data) data = ss.insertSheet('Data');
  data.clear();
  data.getRange(1,1,1,DATA_HEADERS.length).setValues([DATA_HEADERS]).setFontWeight('bold');
  data.setFrozenRows(1);

  const sheet1 = ss.getSheetByName('Sheet1');
  if(sheet1) ss.deleteSheet(sheet1);
}

/* Same SHA-256 hex scheme the browser uses (sha256Hex() in the front-end),
   so a password hashed here matches what login expects. */
function sha256HexGS(str){
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8);
  return bytes.map(b => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, '0')).join('');
}

/* Run this ONCE from the Apps Script editor to create your own Super Admin
   login — the platform-wide account (separate from any single church) that
   lets you manage every organization from its own dashboard. It lives only
   in the Master spreadsheet's PlatformUsers tab, with no tenant spreadsheet
   of its own. Log in at app.html (the login/dashboard page — not the
   marketing site at index.html) with the email/password below like anyone
   else, then change the password from My Account right away — this
   default is meant to be temporary. */
function createSuperAdmin(){
  const fullName = 'Olasile Kehinde Victor';
  const email = 'technologyokv@gmail.com';
  const phone = '+2348104141138';
  const password = 'OKVCMS557'; // default — change this from My Account after your first login

  if(findUserByEmail(email)){ Logger.log('A user with this email already exists — aborting.'); return; }
  const user = {
    id: Utilities.getUuid(), orgId: 'PLATFORM', orgName: 'OKV Technology Consults (Platform)',
    username: fullName, email, phone, passwordHash: sha256HexGS(password),
    isAdmin: true, isSuperAdmin: true, roles: 'Church Super Admin',
    status: 'Active',
    sessionToken: '', sessionExpiry: '', resetToken: '', resetTokenExpiry: '',
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  appendUserRow(user);
  Logger.log('Super Admin created: ' + email + ' / password: ' + password + ' — log in at app.html and change it.');
}

/* ---------- Settings (branding, contact, payment config) — Master only ---------- */
function masterSS(){ return SpreadsheetApp.openById(MASTER_SHEET_ID); }
function settingsSheet(){ return masterSS().getSheetByName('Settings'); }
function tenantsSheet(){ return masterSS().getSheetByName('Tenants'); }
function emailIndexSheet(){ return masterSS().getSheetByName('EmailIndex'); }
function resetIndexSheet(){ return masterSS().getSheetByName('ResetIndex'); }
function platformUsersSheet(){ return masterSS().getSheetByName('PlatformUsers'); }
function paymentsSheet(){ return masterSS().getSheetByName('PaymentRequests'); }

function getSettings(){
  const sheet = settingsSheet();
  const values = sheet.getDataRange().getValues();
  for(let i=1; i<values.length; i++){
    if(values[i][0] === 'config'){
      try{ return deepMerge(DEFAULT_SETTINGS, JSON.parse(values[i][1])); }
      catch(e){ return DEFAULT_SETTINGS; }
    }
  }
  return DEFAULT_SETTINGS;
}
function saveSettings(settings){
  const sheet = settingsSheet();
  const values = sheet.getDataRange().getValues();
  for(let i=1; i<values.length; i++){
    if(values[i][0] === 'config'){
      sheet.getRange(i+1, 2).setValue(JSON.stringify(settings));
      return;
    }
  }
  sheet.appendRow(['config', JSON.stringify(settings)]);
}
// Merges saved settings onto the defaults, one level deep per section, so
// a fresh field added to DEFAULT_SETTINGS later always has a safe fallback
// even in a Sheet saved before that field existed.
function deepMerge(defaults, saved){
  const out = {};
  Object.keys(defaults).forEach(section => {
    if(saved && typeof saved[section] === 'object' && saved[section] !== null && !Array.isArray(saved[section])){
      out[section] = Object.assign({}, defaults[section], saved[section]);
    } else {
      out[section] = (saved && saved[section] !== undefined) ? saved[section] : defaults[section];
    }
  });
  return out;
}
// Only what's safe to expose to anyone, unauthenticated — no API secrets.
function publicSettings(s){
  return {
    branding: s.branding,
    contact: s.contact,
    manualPaymentEnabled: !!s.manualPayment.enabled,
    gatewaysEnabled: {
      paystack: !!(s.gateways.paystack.enabled && s.gateways.paystack.publicKey),
      flutterwave: !!(s.gateways.flutterwave.enabled && s.gateways.flutterwave.publicKey),
      remita: !!(s.gateways.remita.enabled && s.gateways.remita.merchantId),
    },
    paystackPublicKey: s.gateways.paystack.enabled ? s.gateways.paystack.publicKey : '',
    flutterwavePublicKey: s.gateways.flutterwave.enabled ? s.gateways.flutterwave.publicKey : '',
    plans: s.plans,
  };
}


function doGet(e){
  // Public, unauthenticated — used by every page to fetch branding/contact/
  // pricing/enabled-payment-methods before anyone logs in. No secrets here.
  if(e && e.parameter && e.parameter.action === 'publicSettings'){
    return jsonOut({ok:true, settings: publicSettings(getSettings())});
  }
  return jsonOut({ok:true, app:APP_NAME, time:new Date().toISOString()});
}
function doPost(e){
  let body = {};
  try{ body = JSON.parse(e.postData.contents); }catch(err){ return jsonOut({error:'bad_request', message:'Invalid JSON body.'}); }
  const action = body.action;
  try{
    switch(action){
      case 'signup':               return jsonOut(handleSignup(body));
      case 'login':                return jsonOut(handleLogin(body));
      case 'forgotPassword':       return jsonOut(handleForgotPassword(body));
      case 'resetPassword':        return jsonOut(handleResetPassword(body));
      case 'changePassword':       return jsonOut(withAuth(body, handleChangePassword));
      case 'whoAmI':                return jsonOut(withAuthNoSubCheck(body, handleWhoAmI));
      case 'adminListUsers':       return jsonOut(withAuth(body, handleAdminListUsers));
      case 'adminCreateUser':      return jsonOut(withAuth(body, handleAdminCreateUser));
      case 'adminEditUser':        return jsonOut(withAuth(body, handleAdminEditUser));
      case 'adminSetUserPassword': return jsonOut(withAuth(body, handleAdminSetUserPassword));
      case 'adminSetUserStatus':   return jsonOut(withAuth(body, handleAdminSetUserStatus));
      case 'adminDeleteUser':      return jsonOut(withAuth(body, handleAdminDeleteUser));
      case 'syncPull':             return jsonOut(withAuth(body, handleSyncPull));
      case 'syncPush':             return jsonOut(withAuth(body, handleSyncPush));
      case 'submitPaymentRequest': return jsonOut(withAuthNoSubCheck(body, handleSubmitPaymentRequest));
      case 'myPaymentRequests':    return jsonOut(withAuthNoSubCheck(body, handleMyPaymentRequests));
      case 'sendMemberMessage':    return jsonOut(withAuth(body, handleSendMemberMessage));
      case 'superAdminListOrgs':          return jsonOut(withAuthNoSubCheck(body, handleSuperAdminListOrgs));
      case 'superAdminSetOrgSubscription': return jsonOut(withAuthNoSubCheck(body, handleSuperAdminSetOrgSubscription));
      case 'superAdminSetOrgStatus':       return jsonOut(withAuthNoSubCheck(body, handleSuperAdminSetOrgStatus));
      case 'superAdminListPayments':       return jsonOut(withAuthNoSubCheck(body, handleSuperAdminListPayments));
      case 'superAdminSetPaymentStatus':   return jsonOut(withAuthNoSubCheck(body, handleSuperAdminSetPaymentStatus));
      case 'superAdminSendMessage':        return jsonOut(withAuthNoSubCheck(body, handleSuperAdminSendMessage));
      case 'publicSettings':               return jsonOut({ok:true, settings: publicSettings(getSettings())});
      case 'superAdminGetSettings':        return jsonOut(withAuthNoSubCheck(body, handleSuperAdminGetSettings));
      case 'superAdminUpdateSettings':     return jsonOut(withAuthNoSubCheck(body, handleSuperAdminUpdateSettings));
      case 'verifyGatewayPayment':         return jsonOut(withAuthNoSubCheck(body, handleVerifyGatewayPayment));
      case 'superAdminRunCapacityCheck':   return jsonOut(withAuthNoSubCheck(body, handleSuperAdminRunCapacityCheck));
      default:                     return jsonOut({error:'unknown_action'});
    }
  }catch(err){
    return jsonOut({error:'server_error', message:String(err)});
  }
}

function jsonOut(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* =========================================================
   Tenant resolution — the ONLY place a tenant's spreadsheet is opened
   from. Every handler goes through this (directly or via the
   usersSheetFor/dataSheetFor wrappers) instead of a hardcoded or
   "active spreadsheet" reference. Backed by a script cache so a burst of
   calls for the same org doesn't re-scan the Tenants sheet every time.
   ========================================================= */
function getOrgRegistryRow(orgId){
  return readRows(tenantsSheet(), TENANTS_HEADERS).find(r => r.orgId === orgId) || null;
}
function orgRowFor(orgId){
  if(orgId === 'PLATFORM'){
    // Super Admin's own account isn't a tenant — always active, no capacity data.
    return {orgId:'PLATFORM', orgName:'OKV Technology Consults (Platform)', status:'Active',
      subscriptionStatus:'active', subscriptionPlan:'', billingCycle:'', subscriptionExpiry:'', trialEndsAt:''};
  }
  return getOrgRegistryRow(orgId);
}
function getOrgSpreadsheet(orgId){
  if(orgId === 'PLATFORM') return masterSS();
  const cache = CacheService.getScriptCache();
  const cacheKey = 'ssid_' + orgId;
  let ssId = cache.get(cacheKey);
  if(!ssId){
    const row = getOrgRegistryRow(orgId);
    if(!row || !row.spreadsheetId) throw new Error('Unknown organization: ' + orgId);
    ssId = row.spreadsheetId;
    cache.put(cacheKey, ssId, 21600); // 6 hours — Apps Script's cache max
  }
  return SpreadsheetApp.openById(ssId);
}
function usersSheetFor(orgId){
  if(orgId === 'PLATFORM') return platformUsersSheet();
  return getOrgSpreadsheet(orgId).getSheetByName('Users');
}
function dataSheetFor(orgId){
  return getOrgSpreadsheet(orgId).getSheetByName('Data');
}

/* ---------- Generic sheet helpers ---------- */
function readRows(sheet, headers){
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for(let i=1; i<values.length; i++){
    const row = {};
    headers.forEach((h, idx) => row[h] = values[i][idx]);
    row.__row = i+1; // 1-based sheet row number, for updates
    rows.push(row);
  }
  return rows;
}

/* ---------- Users: email/id lookups now resolve through the tenant the
   user belongs to, instead of scanning one giant global sheet. ---------- */
function findUserByEmail(email){
  const lower = String(email||'').toLowerCase();
  if(!lower) return null;
  const idxRow = readRows(emailIndexSheet(), EMAIL_INDEX_HEADERS).find(r => String(r.email).toLowerCase() === lower);
  if(!idxRow) return null;
  return readRows(usersSheetFor(idxRow.orgId), USERS_HEADERS).find(u => String(u.email).toLowerCase() === lower) || null;
}
// orgId is required — the caller already knows it (from the session/body),
// so this never needs to scan more than one tenant's Users tab.
function findUserById(id, orgId){
  if(!orgId) return null;
  return readRows(usersSheetFor(orgId), USERS_HEADERS).find(u => u.id === id) || null;
}
function writeUserRow(user){
  const sheet = usersSheetFor(user.orgId);
  sheet.getRange(user.__row, 1, 1, USERS_HEADERS.length).setValues([USERS_HEADERS.map(h => user[h] !== undefined ? user[h] : '')]);
}
function appendUserRow(user){
  usersSheetFor(user.orgId).appendRow(USERS_HEADERS.map(h => user[h] !== undefined ? user[h] : ''));
  emailIndexSheet().appendRow([String(user.email).toLowerCase(), user.orgId]);
}
function removeFromEmailIndex(email){
  const sheet = emailIndexSheet();
  const row = readRows(sheet, EMAIL_INDEX_HEADERS).find(r => String(r.email).toLowerCase() === String(email||'').toLowerCase());
  if(row) sheet.deleteRow(row.__row);
}
function updateEmailIndexEmail(oldEmail, newEmail, orgId){
  const sheet = emailIndexSheet();
  const row = readRows(sheet, EMAIL_INDEX_HEADERS).find(r => String(r.email).toLowerCase() === String(oldEmail||'').toLowerCase());
  if(row) sheet.getRange(row.__row, 1, 1, 2).setValues([[String(newEmail).toLowerCase(), orgId]]);
  else emailIndexSheet().appendRow([String(newEmail).toLowerCase(), orgId]);
}
// Mutates a Tenants row in place (subscription, status, capacity fields, etc.)
function setTenantFields(orgId, fields){
  const sheet = tenantsSheet();
  const row = readRows(sheet, TENANTS_HEADERS).find(r => r.orgId === orgId);
  if(!row) return null;
  Object.assign(row, fields);
  row.updatedAt = nowIso();
  sheet.getRange(row.__row, 1, 1, TENANTS_HEADERS.length).setValues([TENANTS_HEADERS.map(h => row[h] !== undefined ? row[h] : '')]);
  return row;
}
function forceLogoutAllUsersInOrg(orgId){
  const sheet = usersSheetFor(orgId);
  const rows = readRows(sheet, USERS_HEADERS);
  if(!rows.length) return;
  rows.forEach(u => { u.sessionToken=''; u.sessionExpiry=''; });
  sheet.getRange(2, 1, rows.length, USERS_HEADERS.length).setValues(rows.map(u => USERS_HEADERS.map(h => u[h] !== undefined ? u[h] : '')));
}
// One cheap metadata read (no data read) per tenant, so the Organizations
// table's "Users" count stays live on every load. Falls back to the last
// value the capacity check stored if the tenant spreadsheet can't be
// opened (e.g. deleted/inaccessible), so one bad tenant can't blank the
// whole dashboard.
function liveUserCount(orgRow){
  if(!orgRow.spreadsheetId) return orgRow.userCount || 0;
  try{
    const usersTab = SpreadsheetApp.openById(orgRow.spreadsheetId).getSheetByName('Users');
    return usersTab ? Math.max(0, usersTab.getLastRow()-1) : (orgRow.userCount || 0);
  }catch(err){
    return orgRow.userCount || 0;
  }
}

/* ---------- Auth ---------- */
// A subscription is valid if it's actively paid, or still inside the
// 7-day trial window. Anything else (trial ran out, explicitly cancelled)
// blocks access with a distinct error so the front-end can show the right
// upgrade prompt instead of a generic "contact support" message. Runs
// against the Tenants (org-level) row now, not a per-user field, since a
// subscription belongs to the whole org.
function subscriptionState(orgRow){
  if(String(orgRow.subscriptionStatus) === 'active') return 'active';
  if(String(orgRow.subscriptionStatus) === 'trial'){
    const ends = orgRow.trialEndsAt ? new Date(orgRow.trialEndsAt).getTime() : 0;
    if(ends && ends > Date.now()) return 'trial';
    return 'trial_expired';
  }
  return 'inactive';
}
function withAuth(body, handler){
  const user = findUserById(body.userId, body.orgId);
  if(!user || user.orgId !== body.orgId) return {error:'unauthorized', message:'Invalid session.'};
  if(!user.sessionToken || user.sessionToken !== body.token) return {error:'unauthorized', message:'Invalid session.'};
  if(!user.sessionExpiry || new Date(user.sessionExpiry).getTime() < Date.now()) return {error:'session_expired', message:'Please log in again.'};
  const orgRow = orgRowFor(user.orgId);
  if(!orgRow) return {error:'unauthorized', message:'Organization not found.'};
  if(String(orgRow.status) === 'Suspended') return {error:'account_suspended', message:'This organization has been suspended. Contact support.'};
  if(String(user.status) !== 'Active') return {error:'account_suspended', message:'Your account has been suspended. Contact your administrator.'};
  const subState = subscriptionState(orgRow);
  if(subState === 'trial_expired') return {error:'trial_expired', message:'Your 7-day free trial has ended. Upgrade to keep using the system.'};
  if(subState === 'inactive') return {error:'subscription_inactive', message:'This organization\'s subscription is not active.'};
  return handler(body, user, orgRow);
}
// Same session/status checks as withAuth, but skips the subscription check —
// used for the actions someone still needs to reach even after their trial
// or subscription has lapsed: checking their own status, submitting a
// renewal payment, and everything on the Super Admin dashboard.
function withAuthNoSubCheck(body, handler){
  const user = findUserById(body.userId, body.orgId);
  if(!user || user.orgId !== body.orgId) return {error:'unauthorized', message:'Invalid session.'};
  if(!user.sessionToken || user.sessionToken !== body.token) return {error:'unauthorized', message:'Invalid session.'};
  if(!user.sessionExpiry || new Date(user.sessionExpiry).getTime() < Date.now()) return {error:'session_expired', message:'Please log in again.'};
  const orgRow = orgRowFor(user.orgId);
  if(!orgRow) return {error:'unauthorized', message:'Organization not found.'};
  if(String(user.status) !== 'Active') return {error:'account_suspended', message:'Your account has been suspended. Contact your administrator.'};
  return handler(body, user, orgRow);
}
function newToken(){ return Utilities.getUuid(); }
function isTruthy(v){ return v === true || v === 'TRUE' || v === 'true'; }
function requireSuperAdmin(user){
  if(!isTruthy(user.isSuperAdmin)) return {error:'forbidden', message:'Super Admin access required.'};
  return null;
}
function nowIso(){ return new Date().toISOString(); }

/* ---------- Handlers: auth ---------- */
function handleSignup(body){
  const {orgName, username, email, phone, passwordHash, plan, billingCycle, agreedToTerms} = body;
  if(!orgName || !username || !email || !passwordHash) return {error:'missing_fields'};
  // Server-side is the real gate — the checkbox on signup.html is a UX nicety,
  // not the enforcement point. No consent, no account, regardless of what a
  // client sends.
  if(agreedToTerms !== true) return {error:'terms_not_accepted', message:'You must agree to the Terms of Service and Privacy Policy to create an account.'};
  if(findUserByEmail(email)) return {error:'email_taken', message:'An account with this email already exists.'};

  const orgId = Utilities.getUuid();
  const id = Utilities.getUuid();
  const token = newToken();
  const trialEndsAt = new Date(Date.now()+TRIAL_TTL_MS).toISOString();
  const now = nowIso();

  // 1. Create this org's own spreadsheet — dedicated storage, isolated from
  //    every other tenant, so its own cell-capacity is independent too.
  const ss = SpreadsheetApp.create(orgName + ' — OKV CMS Data');
  initializeTenantSheets(ss);

  // 2. Register it in the Master Tenants sheet — org-level fields
  //    (subscription, plan, status) live HERE, once, not per user.
  //    termsAcceptedAt is the audit-trail timestamp for Section "Acceptance
  //    of terms" — proof of when this Admin agreed, in case it's ever needed.
  const newTenantRow = {
    orgId, orgName, adminName:username, adminEmail:email, adminPhone: phone||'',
    spreadsheetId: ss.getId(), status:'Active',
    subscriptionStatus:'trial', subscriptionPlan: plan || 'Professional', billingCycle: billingCycle || 'Monthly',
    subscriptionExpiry:'', trialEndsAt, lastReminderSentAt:'',
    userCount: 1, cellsUsed:0, cellsPercent:0, cellGrowthPerDay:0, estDaysTo90:'', capacityStatus:'Healthy', lastCapacityCheckAt:'',
    termsAcceptedAt: now,
    createdAt: now, updatedAt: now,
  };
  tenantsSheet().appendRow(TENANTS_HEADERS.map(h => newTenantRow[h] !== undefined ? newTenantRow[h] : ''));

  // 3. Create the Admin user, inside the new tenant spreadsheet.
  const user = {
    id, orgId, orgName, username, email, phone: phone||'', passwordHash,
    isAdmin: true, isSuperAdmin: false, roles: 'Church Super Admin', status: 'Active',
    sessionToken: token, sessionExpiry: new Date(Date.now()+SESSION_TTL_MS).toISOString(),
    resetToken: '', resetTokenExpiry: '', createdAt: now, updatedAt: now,
  };
  appendUserRow(user);

  MailApp.sendEmail({
    to: email,
    subject: 'Welcome to ' + APP_NAME + ' — your 7-day free trial has started',
    name: platformSenderName(), replyTo: platformReplyTo(),
    htmlBody: `<p>Hello ${escapeHtml(username)},</p>
      <p>Your account for <strong>${escapeHtml(orgName)}</strong> is ready, on the
      <strong>${escapeHtml(plan || 'Professional')}</strong> plan (${escapeHtml(billingCycle || 'Monthly')} billing).</p>
      <p>Your 7-day free trial has started — no payment was taken. Install the app and log in with the
      email and password you just created to get going.</p>`,
  });

  const orgRow = orgRowFor(orgId);
  return {ok:true, token, user: publicUser(user, orgRow)};
}

function handleLogin(body){
  const {email, passwordHash} = body;
  const user = findUserByEmail(email);
  if(!user || user.passwordHash !== passwordHash) return {error:'invalid_credentials', message:'Incorrect email or password.'};
  const orgRow = orgRowFor(user.orgId);
  if(!orgRow) return {error:'invalid_credentials', message:'This organization could not be found.'};
  if(String(orgRow.status) === 'Suspended') return {error:'account_suspended', message:'This organization has been suspended. Contact support.'};
  if(String(user.status) !== 'Active') return {error:'account_suspended', message:'Your account has been suspended. Contact your administrator.'};
  const subState = subscriptionState(orgRow);
  if(subState === 'trial_expired') return {error:'trial_expired', message:'Your 7-day free trial has ended. Upgrade to keep using the system.'};
  if(subState === 'inactive') return {error:'subscription_inactive', message:'This organization\'s subscription is not active.'};
  const token = newToken();
  user.sessionToken = token;
  user.sessionExpiry = new Date(Date.now()+SESSION_TTL_MS).toISOString();
  user.updatedAt = nowIso();
  writeUserRow(user);
  return {ok:true, token, user: publicUser(user, orgRow)};
}

// Merges the org-level subscription fields (from the Tenants registry) onto
// the per-user fields, so the front-end's JSON shape is unchanged even
// though those fields no longer live on the user row itself.
function publicUser(u, orgRow){
  orgRow = orgRow || {};
  return {
    id:u.id, orgId:u.orgId, orgName:u.orgName, username:u.username, email:u.email, phone:u.phone||'',
    isAdmin: isTruthy(u.isAdmin),
    isSuperAdmin: isTruthy(u.isSuperAdmin),
    roles: u.roles ? String(u.roles).split(',').map(r=>r.trim()).filter(Boolean) : [],
    status:u.status,
    subscriptionStatus: orgRow.subscriptionStatus||'', subscriptionPlan: orgRow.subscriptionPlan||'',
    billingCycle: orgRow.billingCycle||'', subscriptionExpiry: orgRow.subscriptionExpiry||'', trialEndsAt: orgRow.trialEndsAt||'',
  };
}


function handleForgotPassword(body){
  const {email} = body;
  const user = findUserByEmail(email);
  // Always return ok (don't reveal whether an email exists), but only
  // actually send if it matches an Admin account, per spec: self-serve
  // reset is for Admins only — Users are reset by their Admin instead.
  if(user && (isTruthy(user.isAdmin))){
    const token = Utilities.getUuid();
    const expiry = new Date(Date.now()+RESET_TOKEN_TTL_MS).toISOString();
    user.resetToken = token;
    user.resetTokenExpiry = expiry;
    user.updatedAt = nowIso();
    writeUserRow(user);
    resetIndexSheet().appendRow([token, user.orgId, expiry]); // O(1) lookup for resetPassword, no cross-tenant scan needed
    const link = RESET_PASSWORD_BASE_URL + '?token=' + encodeURIComponent(token);
    MailApp.sendEmail({
      to: user.email,
      subject: 'Reset your ' + APP_NAME + ' password',
      name: platformSenderName(), replyTo: platformReplyTo(),
      htmlBody: `<p>Hello ${escapeHtml(user.username)},</p>
        <p>We received a request to reset your password for <strong>${escapeHtml(user.orgName)}</strong>.</p>
        <p><a href="${link}">Click here to reset your password</a> (link expires in 30 minutes).</p>
        <p>If you didn't request this, you can safely ignore this email.</p>`,
    });
  }
  return {ok:true, message:'If that email is registered as an Admin, a reset link has been sent.'};
}

function handleResetPassword(body){
  const {token, newPasswordHash} = body;
  if(!token || !newPasswordHash) return {error:'missing_fields'};
  const idxSheet = resetIndexSheet();
  const idxRow = readRows(idxSheet, RESET_INDEX_HEADERS).find(r => r.token === token);
  if(!idxRow) return {error:'invalid_token', message:'This reset link is invalid.'};
  if(!idxRow.expiresAt || new Date(idxRow.expiresAt).getTime() < Date.now()){
    idxSheet.deleteRow(idxRow.__row);
    return {error:'expired_token', message:'This reset link has expired. Request a new one.'};
  }
  const user = readRows(usersSheetFor(idxRow.orgId), USERS_HEADERS).find(u => u.resetToken === token);
  if(!user){ idxSheet.deleteRow(idxRow.__row); return {error:'invalid_token', message:'This reset link is invalid.'}; }
  user.passwordHash = newPasswordHash;
  user.resetToken = '';
  user.resetTokenExpiry = '';
  user.updatedAt = nowIso();
  writeUserRow(user);
  idxSheet.deleteRow(idxRow.__row);
  return {ok:true, message:'Password reset successfully. You can now log in.'};
}

function handleChangePassword(body, user){
  const {newPasswordHash} = body;
  if(!newPasswordHash) return {error:'missing_fields'};
  user.passwordHash = newPasswordHash;
  user.updatedAt = nowIso();
  writeUserRow(user);
  return {ok:true, message:'Password updated.'};
}

/* ---------- Handlers: admin user management (all scoped to user.orgId's
   own tenant spreadsheet — never touches another org's data) ---------- */
function requireAdmin(user){
  const isAdmin = isTruthy(user.isAdmin);
  if(!isAdmin) return {error:'forbidden', message:'Admin access required.'};
  return null;
}

function handleAdminListUsers(body, user, orgRow){
  const err = requireAdmin(user); if(err) return err;
  const rows = readRows(usersSheetFor(user.orgId), USERS_HEADERS);
  return {ok:true, users: rows.map(u => publicUser(u, orgRow))};
}

function handleAdminCreateUser(body, user, orgRow){
  const err = requireAdmin(user); if(err) return err;
  const {username, email, passwordHash, roles} = body;
  if(!username || !email || !passwordHash) return {error:'missing_fields'};
  if(findUserByEmail(email)) return {error:'email_taken', message:'An account with this email already exists.'};
  const newUser = {
    id: Utilities.getUuid(), orgId: user.orgId, orgName: user.orgName,
    username, email, phone: body.phone||'', passwordHash,
    isAdmin: false, isSuperAdmin: false,
    roles: Array.isArray(roles) ? roles.join(',') : (roles||''),
    status: 'Active',
    sessionToken:'', sessionExpiry:'', resetToken:'', resetTokenExpiry:'',
    createdAt: nowIso(), updatedAt: nowIso(),
  };
  appendUserRow(newUser);
  return {ok:true, user: publicUser(newUser, orgRow)};
}

function handleAdminEditUser(body, user, orgRow){
  const err = requireAdmin(user); if(err) return err;
  const target = findUserById(body.targetUserId, user.orgId);
  if(!target) return {error:'not_found'};
  if(body.username !== undefined) target.username = body.username;
  if(body.email !== undefined && body.email !== target.email){
    if(findUserByEmail(body.email)) return {error:'email_taken', message:'An account with this email already exists.'};
    updateEmailIndexEmail(target.email, body.email, user.orgId);
    target.email = body.email;
  }
  if(body.roles !== undefined) target.roles = Array.isArray(body.roles) ? body.roles.join(',') : body.roles;
  target.updatedAt = nowIso();
  writeUserRow(target);
  return {ok:true, user: publicUser(target, orgRow)};
}

function handleAdminSetUserPassword(body, user){
  const err = requireAdmin(user); if(err) return err;
  const target = findUserById(body.targetUserId, user.orgId);
  if(!target) return {error:'not_found'};
  if(!body.newPasswordHash) return {error:'missing_fields'};
  target.passwordHash = body.newPasswordHash;
  target.updatedAt = nowIso();
  writeUserRow(target);
  return {ok:true, message:'Password updated for '+target.username+'.'};
}

function handleAdminSetUserStatus(body, user, orgRow){
  const err = requireAdmin(user); if(err) return err;
  const target = findUserById(body.targetUserId, user.orgId);
  if(!target) return {error:'not_found'};
  if(target.id === user.id) return {error:'cannot_modify_self', message:'You cannot suspend your own account.'};
  if(['Active','Suspended'].indexOf(body.status) === -1) return {error:'invalid_status'};
  target.status = body.status;
  if(body.status === 'Suspended'){ target.sessionToken=''; target.sessionExpiry=''; } // force logout
  target.updatedAt = nowIso();
  writeUserRow(target);
  return {ok:true, user: publicUser(target, orgRow)};
}

function handleAdminDeleteUser(body, user){
  const err = requireAdmin(user); if(err) return err;
  const target = findUserById(body.targetUserId, user.orgId);
  if(!target) return {error:'not_found'};
  if(target.id === user.id) return {error:'cannot_delete_self'};
  usersSheetFor(user.orgId).deleteRow(target.__row);
  removeFromEmailIndex(target.email);
  return {ok:true};
}

/* ---------- Handlers: data sync (each org's Data tab lives in its own
   tenant spreadsheet, so no orgId filter is even needed to isolate it —
   the field is kept on each row anyway, for auditability) ---------- */
function handleSyncPull(body, user){
  const isAdmin = isTruthy(user.isAdmin);
  const since = body.since ? new Date(body.since).getTime() : 0;
  const rows = readRows(dataSheetFor(user.orgId), DATA_HEADERS).filter(r => {
    if(!isAdmin && r.updatedBy !== user.id) return false;
    const t = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
    return t > since;
  });
  return {ok:true, serverTime: nowIso(), records: rows.map(r => ({
    module:r.module, recordId:r.recordId, data: r.dataJson ? JSON.parse(r.dataJson) : {},
    updatedAt:r.updatedAt, updatedBy:r.updatedBy, deleted: r.deleted === true || r.deleted === 'TRUE' || r.deleted === 'true',
  }))};
}

function handleSyncPush(body, user){
  const isAdmin = isTruthy(user.isAdmin);
  const records = body.records || [];
  const sheet = dataSheetFor(user.orgId);
  const existing = readRows(sheet, DATA_HEADERS);
  const results = [];
  records.forEach(rec => {
    let row = existing.find(r => r.module === rec.module && r.recordId === rec.recordId);
    if(row && !isAdmin && row.updatedBy !== user.id){
      results.push({recordId:rec.recordId, error:'forbidden'});
      return;
    }
    const nowT = nowIso();
    if(row){
      row.dataJson = JSON.stringify(rec.data || {});
      row.updatedAt = nowT;
      row.updatedBy = user.id;
      row.deleted = !!rec.deleted;
      sheet.getRange(row.__row, 1, 1, DATA_HEADERS.length).setValues([DATA_HEADERS.map(h=>row[h]!==undefined?row[h]:'')]);
    } else {
      const newRow = {
        id: Utilities.getUuid(), orgId:user.orgId, userId:user.id, module:rec.module, recordId:rec.recordId,
        dataJson: JSON.stringify(rec.data || {}), updatedAt: nowT, updatedBy: user.id, deleted: !!rec.deleted,
      };
      sheet.appendRow(DATA_HEADERS.map(h => newRow[h] !== undefined ? newRow[h] : ''));
      existing.push(Object.assign({__row: sheet.getLastRow()}, newRow));
    }
    results.push({recordId:rec.recordId, updatedAt: nowT});
  });
  return {ok:true, serverTime: nowIso(), results};
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* =========================================================
   Session refresh — lets the app pick up subscription changes
   (e.g. after the owner confirms a payment) without a fresh login.
   ========================================================= */
function handleWhoAmI(body, user, orgRow){
  return {ok:true, user: publicUser(user, orgRow)};
}

/* =========================================================
   Subscription payments — bank transfer + proof upload. Payment claims
   are small in volume and platform-wide, so they stay on the Master
   spreadsheet (like Settings) rather than inside each tenant.
   ========================================================= */
function readPaymentRows(){ return readRows(paymentsSheet(), PAYMENTS_HEADERS); }
function writePaymentRow(row){
  paymentsSheet().getRange(row.__row, 1, 1, PAYMENTS_HEADERS.length).setValues([PAYMENTS_HEADERS.map(h=>row[h]!==undefined?row[h]:'')]);
}

function handleSubmitPaymentRequest(body, user){
  const {fullName, email, phone, plan, billingCycle, note, screenshotBase64, screenshotMimeType, screenshotName} = body;
  if(!fullName || !email || !plan || !billingCycle) return {error:'missing_fields'};
  const settings = getSettings();
  const id = Utilities.getUuid();
  const row = {
    id, orgId:user.orgId, orgName:user.orgName, userId:user.id,
    fullName, email, phone: phone||'', plan, billingCycle, note: note||'',
    status:'Pending', processed:false, createdAt: nowIso(), processedAt:'',
  };
  paymentsSheet().appendRow(PAYMENTS_HEADERS.map(h => row[h] !== undefined ? row[h] : ''));

  const mailOptions = {
    to: settings.contact.email,
    subject: `[Payment Claim] ${orgLabel(user)} — ${plan} (${billingCycle})`,
    name: platformSenderName(settings), replyTo: platformReplyTo(settings),
    htmlBody: `<p>New payment claim submitted:</p>
      <ul>
        <li><strong>Organization:</strong> ${escapeHtml(user.orgName)}</li>
        <li><strong>Submitted by:</strong> ${escapeHtml(fullName)} (${escapeHtml(email)}, ${escapeHtml(phone||'—')})</li>
        <li><strong>Plan:</strong> ${escapeHtml(plan)} — ${escapeHtml(billingCycle)}</li>
        <li><strong>Note:</strong> ${escapeHtml(note||'—')}</li>
        <li><strong>Request ID:</strong> ${id}</li>
      </ul>
      <p>To confirm: open the Super Admin dashboard's Payments tab (or the <strong>PaymentRequests</strong> sheet on
      the Master spreadsheet), find this row, set <strong>status</strong> to <strong>Confirmed</strong> (or
      <strong>Rejected</strong>). The next scheduled run of <code>processPaymentRequests()</code> will upgrade the
      account and email the customer automatically.</p>`,
  };
  if(screenshotBase64){
    try{
      const blob = Utilities.newBlob(Utilities.base64Decode(screenshotBase64), screenshotMimeType||'image/jpeg', screenshotName||'payment-screenshot.jpg');
      mailOptions.attachments = [blob];
    }catch(err){ /* if the image fails to decode, still send the email without it */ }
  }
  MailApp.sendEmail(mailOptions);

  MailApp.sendEmail({
    to: email,
    subject: 'We\'ve received your payment details — ' + APP_NAME,
    name: platformSenderName(settings), replyTo: platformReplyTo(settings),
    htmlBody: `<p>Hello ${escapeHtml(fullName)},</p>
      <p>We've received your payment details for the <strong>${escapeHtml(plan)}</strong> plan (${escapeHtml(billingCycle)}).
      Our team reviews these by hand against the bank account, and you'll get an email confirming your status
      within the hour.</p>
      <p>Once confirmed, your plan upgrades automatically and your dashboard will show your new start and renewal dates.</p>`,
  });

  return {ok:true, message:'Payment details submitted. You\'ll receive an email confirming your status shortly.'};
}

function handleMyPaymentRequests(body, user){
  const rows = readPaymentRows().filter(r => r.orgId === user.orgId && r.userId === user.id);
  rows.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  return {ok:true, requests: rows.slice(0,10).map(r => ({id:r.id, plan:r.plan, billingCycle:r.billingCycle, status:r.status, createdAt:r.createdAt}))};
}

function orgLabel(user){ return user.orgName + ' (' + user.email + ')'; }

function cycleToMs(billingCycle){
  if(billingCycle === 'Bi-Annual') return 182 * 24*60*60*1000;
  if(billingCycle === 'Yearly') return 365 * 24*60*60*1000;
  return 30 * 24*60*60*1000; // Monthly
}

/* Applies a Confirmed/Rejected decision on one PaymentRequests row: upgrades
   (or doesn't) the org's subscription — on its Tenants row, the single
   source of truth for subscription state — and emails the customer. Shared
   by the batch trigger (processPaymentRequests) and the Super Admin
   dashboard's instant Confirm/Reject action, so both paths behave
   identically. */
function applyPaymentDecision(r){
  const settings = getSettings();
  if(r.status === 'Confirmed'){
    const expiry = new Date(Date.now() + cycleToMs(r.billingCycle)).toISOString();
    const orgRow = setTenantFields(r.orgId, {
      subscriptionStatus:'active', subscriptionPlan:r.plan, billingCycle:r.billingCycle, subscriptionExpiry:expiry,
    });
    if(orgRow){
      MailApp.sendEmail({
        to: r.email,
        subject: 'You\'re upgraded! — ' + APP_NAME,
        name: platformSenderName(settings), replyTo: platformReplyTo(settings),
        htmlBody: `<p>Hello ${escapeHtml(r.fullName)},</p>
          <p>Your payment has been confirmed and <strong>${escapeHtml(orgRow.orgName)}</strong> is now on the
          <strong>${escapeHtml(r.plan)}</strong> plan (${escapeHtml(r.billingCycle)} billing).</p>
          <p>Your access is active starting today, ${new Date().toDateString()}, and renews on
          ${new Date(expiry).toDateString()}. This will also show automatically on your dashboard.</p>`,
      });
    }
  } else {
    MailApp.sendEmail({
      to: r.email,
      subject: 'About your payment submission — ' + APP_NAME,
      name: platformSenderName(settings), replyTo: platformReplyTo(settings),
      htmlBody: `<p>Hello ${escapeHtml(r.fullName)},</p>
        <p>We couldn't confirm your recent payment submission for the ${escapeHtml(r.plan)} plan.
        Please reply to this email or reach us on WhatsApp at ${escapeHtml(settings.contact.phone)} so we can sort it out.</p>`,
    });
  }
  r.processed = true;
  r.processedAt = nowIso();
  writePaymentRow(r);
}

/* Run this manually from the Apps Script editor after reviewing a claim
   (or put it on a time-driven trigger, e.g. every 15 minutes, so customers
   hear back within the hour as promised). It looks for PaymentRequests rows
   you've marked Confirmed/Rejected in the Sheet that haven't been processed
   yet — rows confirmed/rejected from the Super Admin dashboard are applied
   instantly and skipped here since they're already processed. */
function processPaymentRequests(){
  const rows = readPaymentRows().filter(r => !r.processed && (r.status === 'Confirmed' || r.status === 'Rejected'));
  rows.forEach(applyPaymentDecision);
  Logger.log('Processed ' + rows.length + ' payment request(s).');
}

/* =========================================================
   Automated trial/subscription renewal reminders. Now reads straight off
   the Master Tenants registry — one row per org already has everything
   needed (subscriptionStatus, trialEndsAt, adminEmail, etc.), so this no
   longer has to open a single tenant spreadsheet to send a reminder.
   Trial reminders stay tight (trials are only 7 days) — but paid-
   subscription reminders are deliberately spaced out to twice a month
   (~every 13+ days) rather than nagging daily, with content built from
   their actual plan/tier pricing so it reads as useful info, not a
   generic notice. Run this daily on a time-driven trigger (see
   SETUP_GUIDE.md) — the spacing guard below is what keeps it from being
   disturbing regardless of how often the trigger itself runs.
   ========================================================= */
const REMINDER_MIN_GAP_DAYS = 13;
function sendRenewalReminders(){
  const settings = getSettings();
  const sheet = tenantsSheet();
  const orgs = readRows(sheet, TENANTS_HEADERS);
  let sent = 0;
  orgs.forEach(o => {
    const daysSinceLast = o.lastReminderSentAt ? (Date.now() - new Date(o.lastReminderSentAt).getTime()) / (24*60*60*1000) : Infinity;

    let daysLeft = null, kind = null;
    if(String(o.subscriptionStatus) === 'trial' && o.trialEndsAt){
      daysLeft = Math.ceil((new Date(o.trialEndsAt).getTime() - Date.now()) / (24*60*60*1000));
      if(daysLeft <= 2 && daysLeft >= 0 && daysSinceLast >= 1) kind = 'trial';
    } else if(String(o.subscriptionStatus) === 'active' && o.subscriptionExpiry){
      daysLeft = Math.ceil((new Date(o.subscriptionExpiry).getTime() - Date.now()) / (24*60*60*1000));
      if(daysLeft <= 30 && daysLeft >= 0 && daysSinceLast >= REMINDER_MIN_GAP_DAYS) kind = 'active';
    }
    if(!kind) return;

    const dayWord = daysLeft === 0 ? 'today' : `in ${daysLeft} day${daysLeft===1?'':'s'}`;
    const currentPlan = kind === 'trial' ? (o.subscriptionPlan || 'Professional') : o.subscriptionPlan;
    const currentCycle = kind === 'trial' ? (o.billingCycle || 'Monthly') : o.billingCycle;
    const renewalPrice = settings.plans[currentPlan] ? settings.plans[currentPlan][currentCycle] : null;
    const isStarter = currentPlan === 'Starter';
    const upsellPrice = isStarter && settings.plans.Professional ? settings.plans.Professional[currentCycle] : null;

    MailApp.sendEmail({
      to: o.adminEmail,
      subject: (kind === 'trial' ? 'Your free trial ends ' : 'Your subscription renews ') + dayWord + ' — ' + APP_NAME,
      name: platformSenderName(settings), replyTo: platformReplyTo(settings),
      htmlBody: `<p>Hello ${escapeHtml(o.adminName)},</p>
        <p>${kind === 'trial'
          ? `Your 7-day free trial for <strong>${escapeHtml(o.orgName)}</strong> ends ${dayWord}.`
          : `Your <strong>${escapeHtml(currentPlan)}</strong> plan (${escapeHtml(currentCycle)} billing) for <strong>${escapeHtml(o.orgName)}</strong> renews ${dayWord}${renewalPrice ? ` — &#8358;${renewalPrice.toLocaleString()}` : ''}.`}</p>
        <p>To keep access without interruption, log in and open the <strong>Subscription</strong> tab to submit your
        renewal payment. Transfer to:</p>
        <ul>
          <li><strong>Account Number:</strong> ${escapeHtml(settings.manualPayment.accountNumber)}</li>
          <li><strong>Bank:</strong> ${escapeHtml(settings.manualPayment.bankName)}</li>
          <li><strong>Account Name:</strong> ${escapeHtml(settings.manualPayment.accountName)}</li>
        </ul>
        ${upsellPrice ? `<p>Considering more? The <strong>Professional</strong> plan (${escapeHtml(currentCycle)}) adds reports, exports, backup/restore and multi-branch support for &#8358;${upsellPrice.toLocaleString()} — just choose it on the Subscription tab.</p>` : ''}
        <p>Questions? Reach us at ${escapeHtml(settings.contact.email)} or ${escapeHtml(settings.contact.phone)}.</p>`,
    });
    o.lastReminderSentAt = nowIso();
    sheet.getRange(o.__row, 1, 1, TENANTS_HEADERS.length).setValues([TENANTS_HEADERS.map(h=>o[h]!==undefined?o[h]:'')]);
    sent++;
  });
  Logger.log('Sent ' + sent + ' renewal reminder(s).');
}

/* =========================================================
   CELL-CAPACITY MONITORING
   Google Sheets caps every spreadsheet FILE at 10,000,000 cells, summed
   across all its tabs. Because each tenant now has its own spreadsheet,
   that limit applies per-organization — this section tracks, per tenant,
   how close it is, how fast it's growing, and when it'll need attention.

   Run checkAllTenantsCapacity() on a daily or weekly time-driven trigger
   (Apps Script editor → clock icon → Add Trigger). It is NOT called on
   every page load — the Super Admin dashboard only ever reads the numbers
   this function already wrote to the Tenants sheet.
   ========================================================= */
const CELL_LIMIT = 10000000;
const CAPACITY_MONITOR_THRESHOLD = 0.9; // "time remaining" is estimated until 90% full

function computeSpreadsheetCellUsage(ss){
  // Actual used range per tab (not the full default 1000x26 grid), summed
  // across every tab in the file — matches how Sheets enforces the limit.
  let total = 0;
  ss.getSheets().forEach(sheet => {
    const rows = sheet.getLastRow();
    const cols = sheet.getLastColumn();
    if(rows > 0 && cols > 0) total += rows * cols;
  });
  return total;
}

function capacityGuidance(status){
  if(status === 'Action Needed') return 'Archive older records into a separate archive spreadsheet, or split this tenant into an additional spreadsheet soon.';
  if(status === 'Monitor') return 'Getting full — plan an archiving strategy before it becomes urgent.';
  return 'No action needed.';
}

function checkAllTenantsCapacity(){
  const sheet = tenantsSheet();
  const rows = readRows(sheet, TENANTS_HEADERS);
  const settings = getSettings();
  const now = Date.now();
  let checked = 0, alerted = 0;

  rows.forEach(row => {
    if(!row.spreadsheetId) return;
    let ss;
    try{ ss = SpreadsheetApp.openById(row.spreadsheetId); }
    catch(err){ Logger.log('Could not open spreadsheet for ' + row.orgName + ': ' + err); return; }

    const cellsUsed = computeSpreadsheetCellUsage(ss);
    const percent = Math.round((cellsUsed / CELL_LIMIT) * 10000) / 100; // 2 decimal places

    // Growth rate: cells/day, derived from the change since the last check,
    // blended with the previous rate so one unusually busy/quiet day
    // doesn't swing the estimate wildly.
    const prevCells = Number(row.cellsUsed) || 0;
    const prevCheckAt = row.lastCapacityCheckAt ? new Date(row.lastCapacityCheckAt).getTime() : 0;
    let cellGrowthPerDay = Number(row.cellGrowthPerDay) || 0;
    if(prevCheckAt && now > prevCheckAt){
      const daysSince = (now - prevCheckAt) / (24*60*60*1000);
      if(daysSince >= 0.5){
        const observedRate = Math.max(0, (cellsUsed - prevCells) / daysSince);
        cellGrowthPerDay = cellGrowthPerDay > 0 ? Math.round(cellGrowthPerDay*0.5 + observedRate*0.5) : Math.round(observedRate);
      }
    }

    const ninetyPercentCells = CELL_LIMIT * CAPACITY_MONITOR_THRESHOLD;
    let estDaysTo90 = '';
    if(cellsUsed >= ninetyPercentCells) estDaysTo90 = 0;
    else if(cellGrowthPerDay > 0) estDaysTo90 = Math.round((ninetyPercentCells - cellsUsed) / cellGrowthPerDay);
    // else: not enough growth history yet, or usage is flat — leave blank rather than guess.

    let capacityStatus = 'Healthy';
    if(percent >= 85) capacityStatus = 'Action Needed';
    else if(percent >= 70) capacityStatus = 'Monitor';

    const usersTab = ss.getSheetByName('Users');
    const userCount = usersTab ? Math.max(0, usersTab.getLastRow()-1) : (row.userCount || 0);

    const wasActionNeeded = row.capacityStatus === 'Action Needed';

    setTenantFields(row.orgId, {
      cellsUsed, cellsPercent: percent, cellGrowthPerDay, estDaysTo90, capacityStatus,
      lastCapacityCheckAt: new Date(now).toISOString(), userCount,
    });
    checked++;

    if(capacityStatus === 'Action Needed' && !wasActionNeeded){
      sendCapacityAlertEmail(row.orgName, row.spreadsheetId, percent, estDaysTo90, settings);
      alerted++;
    }
  });

  Logger.log('Capacity check complete: ' + checked + ' tenant(s) checked, ' + alerted + ' new "Action Needed" alert(s) sent.');
}

function sendCapacityAlertEmail(orgName, spreadsheetId, percent, estDaysTo90, settings){
  const ownerEmail = (settings && settings.contact && settings.contact.email) || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({
    to: ownerEmail,
    subject: 'Action needed: "' + orgName + '" is nearing its Google Sheets cell limit',
    name: platformSenderName(settings), replyTo: platformReplyTo(settings),
    htmlBody: `<p><strong>${escapeHtml(orgName)}</strong> is now using <strong>${percent}%</strong> of the
      10,000,000-cell Google Sheets limit${(estDaysTo90 !== '' && estDaysTo90 !== null) ? `, and at its current growth rate is estimated to reach 90% in about <strong>${estDaysTo90} day(s)</strong>.` : '.'}</p>
      <p><strong>Recommended next step:</strong> ${capacityGuidance('Action Needed')}</p>
      <p>Spreadsheet: <a href="https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit">open it</a></p>
      <p>This is only visible to you on the Super Admin dashboard — organizations never see their own capacity numbers.</p>`,
  });
}

// Convenience for the Super Admin dashboard's "Refresh capacity now"
// button — same logic as the trigger, just callable on demand. For large
// tenant counts, prefer letting the scheduled trigger do this instead, to
// stay well inside Apps Script's execution time limit.
function handleSuperAdminRunCapacityCheck(body, user){
  const err = requireSuperAdmin(user); if(err) return err;
  checkAllTenantsCapacity();
  return {ok:true, message:'Capacity check complete.'};
}

/* =========================================================
   Super Admin — cross-organization platform dashboard. Reads straight off
   the Master Tenants registry now — it already has everything (org info,
   subscription, and capacity numbers), so this never has to open a single
   tenant spreadsheet just to render the Organizations list — except for
   the live user count below, which is one cheap metadata read per tenant
   (getLastRow(), not a data read), so it stays accurate on every load the
   way it always has, instead of only refreshing once a day like the
   (deliberately scheduled-only) capacity numbers.
   ========================================================= */
function handleSuperAdminListOrgs(body, user){
  const err = requireSuperAdmin(user); if(err) return err;
  const rows = readRows(tenantsSheet(), TENANTS_HEADERS);
  const orgs = rows.map(o => ({
    orgId: o.orgId, orgName: o.orgName,
    adminName: o.adminName, adminEmail: o.adminEmail, adminPhone: o.adminPhone||'',
    status: o.status, subscriptionStatus: o.subscriptionStatus,
    subscriptionPlan: o.subscriptionPlan||'', billingCycle: o.billingCycle||'',
    subscriptionExpiry: o.subscriptionExpiry||'', trialEndsAt: o.trialEndsAt||'',
    userCount: liveUserCount(o),
    createdAt: o.createdAt,
    // Cell-capacity monitoring — Super Admin oversight only (see
    // "CELL-CAPACITY MONITORING" section). Numbers come from the last
    // scheduled checkAllTenantsCapacity() run, not computed live here.
    cellsPercent: o.cellsPercent || 0,
    capacityStatus: o.capacityStatus || 'Healthy',
    estDaysTo90: (o.estDaysTo90 === '' || o.estDaysTo90 === undefined) ? null : o.estDaysTo90,
    lastCapacityCheckAt: o.lastCapacityCheckAt || '',
    capacityGuidance: capacityGuidance(o.capacityStatus || 'Healthy'),
  }));
  orgs.sort((x,y) => new Date(y.createdAt) - new Date(x.createdAt));
  return {ok:true, orgs};
}

function handleSuperAdminSetOrgSubscription(body, user){
  const err = requireSuperAdmin(user); if(err) return err;
  const fields = {};
  if(body.subscriptionStatus !== undefined) fields.subscriptionStatus = body.subscriptionStatus;
  if(body.subscriptionPlan !== undefined) fields.subscriptionPlan = body.subscriptionPlan;
  if(body.billingCycle !== undefined) fields.billingCycle = body.billingCycle;
  if(body.subscriptionExpiry !== undefined) fields.subscriptionExpiry = body.subscriptionExpiry;
  const row = setTenantFields(body.targetOrgId, fields);
  if(!row) return {error:'not_found'};
  return {ok:true};
}

function handleSuperAdminSetOrgStatus(body, user){
  const err = requireSuperAdmin(user); if(err) return err;
  if(['Active','Suspended'].indexOf(body.status) === -1) return {error:'invalid_status'};
  const row = setTenantFields(body.targetOrgId, {status: body.status});
  if(!row) return {error:'not_found'};
  if(body.status === 'Suspended') forceLogoutAllUsersInOrg(body.targetOrgId);
  return {ok:true};
}

function handleSuperAdminListPayments(body, user){
  const err = requireSuperAdmin(user); if(err) return err;
  const rows = readPaymentRows();
  rows.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  return {ok:true, payments: rows.slice(0,200).map(r => ({
    id:r.id, orgId:r.orgId, orgName:r.orgName, fullName:r.fullName, email:r.email, phone:r.phone,
    plan:r.plan, billingCycle:r.billingCycle, note:r.note, status:r.status, createdAt:r.createdAt, processedAt:r.processedAt||'',
  }))};
}

function handleSuperAdminSetPaymentStatus(body, user){
  const err = requireSuperAdmin(user); if(err) return err;
  const rows = readPaymentRows();
  const row = rows.find(r => r.id === body.paymentId);
  if(!row) return {error:'not_found'};
  if(['Confirmed','Rejected'].indexOf(body.status) === -1) return {error:'invalid_status'};
  row.status = body.status;
  applyPaymentDecision(row); // applies instantly — no need to wait for the trigger
  return {ok:true};
}

function handleSuperAdminSendMessage(body, user){
  const err = requireSuperAdmin(user); if(err) return err;
  const {channels, recipients, subject, message} = body; // recipients: [{orgName,adminName,email,phone}]
  if(!Array.isArray(recipients) || !recipients.length) return {error:'missing_fields', message:'No recipients selected.'};
  if(!Array.isArray(channels) || !channels.length) return {error:'missing_fields', message:'Select at least one channel.'};
  const settings = getSettings();
  const results = {email:{sent:0, failed:0}, sms:{queued:0}, whatsapp:{queued:0, links:[]}};

  recipients.forEach(o => {
    const personalizedMsg = fillTemplate(message, {name:o.adminName, orgName:o.orgName, email:o.email, phone:o.phone});
    if(channels.indexOf('email') !== -1 && o.email){
      try{
        MailApp.sendEmail({to:o.email, subject: fillTemplate(subject||APP_NAME, {name:o.adminName, orgName:o.orgName}), name: platformSenderName(settings), replyTo: platformReplyTo(settings), htmlBody: personalizedMsg.replace(/\n/g,'<br>')});
        results.email.sent++;
      }catch(err){ results.email.failed++; }
    }
    if(channels.indexOf('sms') !== -1 && o.phone){
      sendSms(o.phone, personalizedMsg);
      results.sms.queued++;
    }
    if(channels.indexOf('whatsapp') !== -1 && o.phone){
      const r = sendWhatsApp(o.phone, personalizedMsg);
      results.whatsapp.queued++;
      if(r.link) results.whatsapp.links.push({name:o.orgName, link:r.link});
    }
  });

  return {ok:true, results};
}

/* =========================================================
   Member communications — announcements & personalized messages
   (birthday, anniversary, custom) sent by Admins/authorized Users.
   Email sends for real via MailApp. SMS and WhatsApp are logged as
   queued — plug in a gateway (e.g. Termii, Africa's Talking, Twilio,
   WhatsApp Business API) in sendSms()/sendWhatsApp() below to make
   those channels actually deliver; until then, the WhatsApp channel
   also returns a wa.me click-to-chat link per recipient as a
   zero-setup fallback.
   ========================================================= */
function fillTemplate(template, member){
  return String(template||'').replace(/\{(\w+)\}/g, (m, key) => member[key] !== undefined ? member[key] : m);
}
// Reads the SMS gateway configured from the Super Admin dashboard. Termii
// is wired up as a working example (it's a common choice for Nigerian
// numbers) — set provider:'termii' with an apiKey and senderId to make SMS
// actually deliver. Any other provider name is queued but not sent; add
// its API call here the same way if you use a different one.
function sendSms(phone, message){
  const settings = getSettings();
  const cfg = settings.sms;
  if(!cfg || !cfg.provider || !cfg.apiKey){
    return {queued:true, note:'SMS gateway not configured yet — message queued, not delivered.'};
  }
  if(cfg.provider === 'termii'){
    try{
      UrlFetchApp.fetch('https://api.ng.termii.com/api/sms/send', {
        method:'post', contentType:'application/json', muteHttpExceptions:true,
        payload: JSON.stringify({
          to: String(phone).replace(/[^\d]/g,''), from: cfg.senderId || 'N-Alert',
          sms: message, type:'plain', channel:'generic', api_key: cfg.apiKey,
        }),
      });
      return {queued:false, sent:true};
    }catch(err){ return {queued:true, note:'SMS send failed: ' + err}; }
  }
  return {queued:true, note:'Unsupported SMS provider "' + cfg.provider + '" — message queued, not delivered.'};
}
// WhatsApp: same pattern. Until a provider is configured, every message
// also returns a wa.me click-to-chat link so sending manually still works
// with zero setup.
function sendWhatsApp(phone, message){
  const settings = getSettings();
  const cfg = settings.whatsapp;
  const digits = String(phone||'').replace(/[^\d]/g,'');
  const link = digits ? `https://wa.me/${digits}?text=${encodeURIComponent(message)}` : '';
  if(cfg && cfg.provider === 'termii' && cfg.apiKey){
    try{
      UrlFetchApp.fetch('https://api.ng.termii.com/api/sms/send', {
        method:'post', contentType:'application/json', muteHttpExceptions:true,
        payload: JSON.stringify({
          to: digits, from: cfg.senderNumber || cfg.apiKey, sms: message,
          type:'plain', channel:'whatsapp', api_key: cfg.apiKey,
        }),
      });
      return {queued:false, sent:true, link};
    }catch(err){ return {queued:true, note:'WhatsApp send failed: ' + err, link}; }
  }
  return {queued:true, note:'WhatsApp gateway not configured yet — use the click-to-chat link to send manually.', link};
}

function handleSendMemberMessage(body, user){
  const {channels, recipients, subject, message} = body; // recipients: [{name,email,phone,whatsapp,...}]
  if(!Array.isArray(recipients) || !recipients.length) return {error:'missing_fields', message:'No recipients selected.'};
  if(!Array.isArray(channels) || !channels.length) return {error:'missing_fields', message:'Select at least one channel.'};
  const results = {email:{sent:0, failed:0}, sms:{queued:0}, whatsapp:{queued:0, links:[]}};

  recipients.forEach(m => {
    const personalizedMsg = fillTemplate(message, m);
    if(channels.indexOf('email') !== -1 && m.email){
      try{
        MailApp.sendEmail({to:m.email, subject: fillTemplate(subject||APP_NAME, m), htmlBody: personalizedMsg.replace(/\n/g,'<br>')});
        results.email.sent++;
      }catch(err){ results.email.failed++; }
    }
    if(channels.indexOf('sms') !== -1 && m.phone){
      sendSms(m.phone, personalizedMsg);
      results.sms.queued++;
    }
    if(channels.indexOf('whatsapp') !== -1 && (m.whatsapp || m.phone)){
      const r = sendWhatsApp(m.whatsapp || m.phone, personalizedMsg);
      results.whatsapp.queued++;
      if(r.link) results.whatsapp.links.push({name:m.name, link:r.link});
    }
  });

  return {ok:true, results};
}

/* =========================================================
   Super Admin — system configuration (branding, contact, payment
   methods, gateways, messaging providers, pricing) — everything here is
   editable from the Super Admin dashboard, no code edits required.
   ========================================================= */
function handleSuperAdminGetSettings(body, user){
  const err = requireSuperAdmin(user); if(err) return err;
  return {ok:true, settings: getSettings()}; // full settings, including secret keys — Super Admin only
}
function handleSuperAdminUpdateSettings(body, user){
  const err = requireSuperAdmin(user); if(err) return err;
  const current = getSettings();
  const updated = deepMerge(current, body.settings || {});
  saveSettings(updated);
  return {ok:true, settings: updated};
}

/* =========================================================
   Payment gateways — Paystack and Flutterwave are wired up for real
   server-side verification (their REST "verify transaction" endpoints
   are stable and simple); just enter your keys from the Super Admin
   dashboard and enable the gateway. Remita's integration varies by
   merchant setup and isn't fully wired here — its config fields are
   ready, but hooking up the actual verify call needs your merchant
   details filled in below once you have them.
   ========================================================= */
function handleVerifyGatewayPayment(body, user, orgRow){
  const {provider, reference, plan, billingCycle} = body;
  if(!provider || !reference || !plan || !billingCycle) return {error:'missing_fields'};
  const settings = getSettings();
  const cfg = settings.gateways[provider];
  if(!cfg || !cfg.enabled) return {error:'gateway_disabled', message:'This payment method is not enabled.'};

  let verified = false, amount = null;
  try{
    if(provider === 'paystack'){
      const res = UrlFetchApp.fetch('https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference), {
        headers: {Authorization: 'Bearer ' + cfg.secretKey}, muteHttpExceptions:true,
      });
      const json = JSON.parse(res.getContentText());
      verified = json.status && json.data && json.data.status === 'success';
      amount = json.data ? json.data.amount / 100 : null;
    } else if(provider === 'flutterwave'){
      const res = UrlFetchApp.fetch('https://api.flutterwave.com/v3/transactions/' + encodeURIComponent(reference) + '/verify', {
        headers: {Authorization: 'Bearer ' + cfg.secretKey}, muteHttpExceptions:true,
      });
      const json = JSON.parse(res.getContentText());
      verified = json.status === 'success' && json.data && json.data.status === 'successful';
      amount = json.data ? json.data.amount : null;
    } else {
      return {error:'unsupported_provider', message:'Remita verification isn\'t wired up yet — confirm this payment manually from the Payments tab instead.'};
    }
  }catch(err){
    return {error:'verify_failed', message:'Could not verify this payment: ' + err};
  }

  if(!verified) return {error:'not_verified', message:'This payment could not be verified.'};

  const expiry = new Date(Date.now() + cycleToMs(billingCycle)).toISOString();
  const updatedOrgRow = setTenantFields(user.orgId, {
    subscriptionStatus:'active', subscriptionPlan:plan, billingCycle:billingCycle, subscriptionExpiry:expiry,
  });
  MailApp.sendEmail({
    to: user.email,
    subject: 'You\'re upgraded! — ' + APP_NAME,
    name: platformSenderName(settings), replyTo: platformReplyTo(settings),
    htmlBody: `<p>Hello ${escapeHtml(user.username)},</p>
      <p>Your payment was confirmed automatically and <strong>${escapeHtml(user.orgName)}</strong> is now on the
      <strong>${escapeHtml(plan)}</strong> plan (${escapeHtml(billingCycle)} billing), active immediately and
      renewing on ${new Date(expiry).toDateString()}.</p>`,
  });
  return {ok:true, user: publicUser(user, updatedOrgRow), amount};
}

/* =========================================================
   ONE-TIME MIGRATION — moves an existing single-sheet install (Users/Data/
   PaymentRequests/Settings all in one spreadsheet, isolated only by an
   orgId column) into the per-tenant architecture above.

   Run manually, once, from the Apps Script editor:
     migrateLegacySingleSheetToPerTenant('PASTE_OLD_SHEET_ID_HERE')

   What it does:
   1. Copies Settings and PaymentRequests straight across to the Master
      spreadsheet (they were already platform-wide, not per-tenant).
   2. Groups the old Users sheet by orgId. The Super Admin row (isSuperAdmin
      = true) goes to Master's PlatformUsers tab — no tenant spreadsheet.
   3. For every other org: creates a brand-new tenant spreadsheet, copies
      that org's Users rows (minus the subscription fields, which now live
      on the Tenants row) and Data rows into it, and appends one Tenants
      row summarizing the org (using its former Admin's subscription info).
   4. Populates EmailIndex for every migrated user.

   It does NOT touch or delete the old spreadsheet — verify the new Master
   and tenant spreadsheets look right, update your web app's MASTER_SHEET_ID
   deployment, then archive the old sheet yourself once you're satisfied.
   Run checkAllTenantsCapacity() afterward to populate capacity numbers for
   the newly created tenant spreadsheets.
   ========================================================= */
function migrateLegacySingleSheetToPerTenant(legacySheetId){
  const OLD_USERS_HEADERS = ['id','orgId','orgName','username','email','phone','passwordHash','isAdmin','isSuperAdmin','roles','status','subscriptionStatus','subscriptionPlan','billingCycle','subscriptionExpiry','trialEndsAt','lastReminderSentAt','sessionToken','sessionExpiry','resetToken','resetTokenExpiry','createdAt','updatedAt'];
  const oldSs = SpreadsheetApp.openById(legacySheetId);

  // 1. Settings + PaymentRequests copy straight across (already platform-wide).
  const oldSettingsSheet = oldSs.getSheetByName('Settings');
  if(oldSettingsSheet){
    const values = oldSettingsSheet.getDataRange().getValues();
    for(let i=1; i<values.length; i++){
      if(values[i][0] === 'config'){ try{ saveSettings(JSON.parse(values[i][1])); }catch(e){} }
    }
  }
  const oldPaymentsSheet = oldSs.getSheetByName('PaymentRequests');
  if(oldPaymentsSheet){
    const oldPayments = readRows(oldPaymentsSheet, PAYMENTS_HEADERS);
    const dest = paymentsSheet();
    oldPayments.forEach(p => dest.appendRow(PAYMENTS_HEADERS.map(h => p[h] !== undefined ? p[h] : '')));
    Logger.log('Copied ' + oldPayments.length + ' payment request row(s).');
  }

  // 2. Group Users by orgId.
  const oldUsersSheet = oldSs.getSheetByName('Users');
  const oldDataSheet = oldSs.getSheetByName('Data');
  if(!oldUsersSheet){ Logger.log('No Users sheet found on the legacy spreadsheet — aborting.'); return; }
  const oldUsers = readRows(oldUsersSheet, OLD_USERS_HEADERS);
  const oldData = oldDataSheet ? readRows(oldDataSheet, DATA_HEADERS) : [];

  const byOrg = {};
  oldUsers.forEach(u => {
    if(isTruthy(u.isSuperAdmin)){
      // Super Admin — goes straight to Master's PlatformUsers, no tenant spreadsheet.
      const reduced = {};
      USERS_HEADERS.forEach(h => reduced[h] = u[h] !== undefined ? u[h] : '');
      platformUsersSheet().appendRow(USERS_HEADERS.map(h => reduced[h]));
      emailIndexSheet().appendRow([String(u.email).toLowerCase(), 'PLATFORM']);
      return;
    }
    (byOrg[u.orgId] = byOrg[u.orgId] || []).push(u);
  });

  let tenantsCreated = 0;
  Object.keys(byOrg).forEach(orgId => {
    const group = byOrg[orgId];
    const admin = group.find(u => isTruthy(u.isAdmin)) || group[0];

    const ss = SpreadsheetApp.create((admin.orgName || 'Organization') + ' — OKV CMS Data');
    initializeTenantSheets(ss);
    const newUsersSheet = ss.getSheetByName('Users');
    const newDataSheet = ss.getSheetByName('Data');

    group.forEach(u => {
      const reduced = {};
      USERS_HEADERS.forEach(h => reduced[h] = u[h] !== undefined ? u[h] : '');
      newUsersSheet.appendRow(USERS_HEADERS.map(h => reduced[h]));
      emailIndexSheet().appendRow([String(u.email).toLowerCase(), orgId]);
    });

    const orgData = oldData.filter(r => r.orgId === orgId);
    orgData.forEach(r => newDataSheet.appendRow(DATA_HEADERS.map(h => r[h] !== undefined ? r[h] : '')));

    const newTenantRow = {
      orgId, orgName: admin.orgName, adminName: admin.username, adminEmail: admin.email, adminPhone: admin.phone||'',
      spreadsheetId: ss.getId(), status: admin.status || 'Active',
      subscriptionStatus: admin.subscriptionStatus||'trial', subscriptionPlan: admin.subscriptionPlan||'Professional',
      billingCycle: admin.billingCycle||'Monthly', subscriptionExpiry: admin.subscriptionExpiry||'', trialEndsAt: admin.trialEndsAt||'',
      lastReminderSentAt: admin.lastReminderSentAt||'',
      userCount: group.length, cellsUsed:0, cellsPercent:0, cellGrowthPerDay:0, estDaysTo90:'', capacityStatus:'Healthy', lastCapacityCheckAt:'',
      createdAt: admin.createdAt || nowIso(), updatedAt: nowIso(),
    };
    tenantsSheet().appendRow(TENANTS_HEADERS.map(h => newTenantRow[h] !== undefined ? newTenantRow[h] : ''));

    tenantsCreated++;
    Logger.log('Migrated org "' + admin.orgName + '" → new spreadsheet ' + ss.getId() + ' (' + group.length + ' user(s), ' + orgData.length + ' data row(s)).');
  });

  Logger.log('Migration complete: ' + tenantsCreated + ' tenant spreadsheet(s) created. Run checkAllTenantsCapacity() next to populate capacity numbers.');
}
