'use strict';
/* ====================================================================
   EPOS v2 — POS + inventory, roles (admin / cashier), shared shop database
   Security model:
   - Records are stored as plain JSON on the device and in the shop's Supabase project.
     They are NOT encrypted: protection is the shop account login + row-level security,
     plus the device's own screen lock.
   - Each user's password / PIN is stretched with PBKDF2 (310k rounds) and only gates the app screen.
     Roles (admin / cashier) are enforced inside the app, not by the server.
   - 5 wrong attempts → progressive lockout. Auto-lock when idle. Activity log.
   ==================================================================== */
const $ = s => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const te = new TextEncoder(), td = new TextDecoder();
const DEF = { loyaltyOn: true, earnPer: 10, ptValue: 0.1, minRedeem: 50, printLogo: true, store: 'My Shop', addr: '', phone: '', footer: 'Thank you! Please come again.', cur: '$', dec: 2, tax: 0, paper: 58, method: 'ble', btId: '', btName: '', cashDiscMax: 10 };
const PALETTE = ['#007aff', '#34c759', '#ff9500', '#af52de', '#ff2d55', '#5ac8fa', '#5856d6', '#ff6482', '#30b0c7', '#a2845e'];
const hue = s => { let h = 0; for (const c of String(s || '?')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
const initial = s => (String(s || '?').trim()[0] || '?').toUpperCase();
const uById = id => (meta && meta.users.find(u => u.id === id)) || null;
// avatar: user photo, otherwise a person icon (not initials)
// images arrive from the shared database: only accept real base64 image data (blocks attribute injection)
const safeImg = v => typeof v === 'string' && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(v) ? v : '';
const avatar = (u, cls = '') => `<span class="av ${cls}${safeImg(u && u.avatar) ? ' ph' : ''}">${safeImg(u && u.avatar) ? `<img src="${safeImg(u.avatar)}" alt="">` : ICONS_PERSON}</span>`;
const ICONS_PERSON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>';
// shop logo (stored unencrypted in meta so the lock screen can show it)
const brandMark = (cls = '') => `<span class="logo ${cls}">${meta && safeImg(meta.logo) ? `<img src="${safeImg(meta.logo)}" alt="">` : ICON.logo}</span>`;

/* ---------- state ---------- */
let db = null;          // decrypted working data (only while unlocked)
let meta = null;        // plaintext: user list (wrapped keys), prefs
let me = null, dek = null, dekRaw = null;
let view = 'sell', cart = [], q = '', cat = 'All', discount = 0, stockQ = '', stockF = 'all', salesF = 'today', ck = null, lastUser = null;
let L = { sel: null, pin: '', busy: false, err: '' };
const isAdmin = () => !!me && me.role === 'admin';
const prod = id => db.products.find(p => p.id === id);
const S = () => db.settings;
const money = n => S().cur + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: +S().dec, maximumFractionDigits: +S().dec });

const I = d => `<svg viewBox="0 0 24 24">${d}</svg>`;
const ICON = {
  sell: I('<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M3 10h18M7.5 15h3"/>'),
  dash: I('<rect x="3" y="3" width="8" height="9" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="11" width="8" height="10" rx="2"/><rect x="3" y="15" width="8" height="6" rx="2"/>'),
  stock: I('<path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>'),
  sales: I('<path d="M4 20V11M10 20V4M16 20v-6M22 20H2"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>'),
  account: I('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>'),
  cust: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 3-5.5 6.5-5.5s6.5 1.9 6.5 5.5"/><circle cx="17.5" cy="9" r="2.5"/><path d="M17 14.5c2.8 0 4.5 1.5 4.5 4"/>'),
  scan: I('<path d="M4 8V6a2 2 0 012-2h2M16 4h2a2 2 0 012 2v2M20 16v2a2 2 0 01-2 2h-2M8 20H6a2 2 0 01-2-2v-2M7 12h10"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  print: I('<path d="M6 9V3h12v6M6 18H4a1 1 0 01-1-1v-6a2 2 0 012-2h14a2 2 0 012 2v6a1 1 0 01-1 1h-2"/><rect x="6" y="14" width="12" height="7"/>'),
  x: I('<path d="M6 6l12 12M18 6L6 18"/>'),
  lock: I('<rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 018 0v3"/>'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>'),
  logo: I('<path d="M4 5h3l2 9h9l2-6H8"/><circle cx="10" cy="19" r="1.2"/><circle cx="17" cy="19" r="1.2"/>'),
};

/* ---------- small UI helpers ---------- */
let toastT;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => t.className = err ? 'err' : '', err ? 3600 : 1900);
}
function modal(html, cls = '') { const m = $('#modal'); m.innerHTML = `<div class="sheet ${cls}">${html}</div>`; m.classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); $('#modal').innerHTML = ''; ck = null; modalUser = null; }
const fmtDate = ts => new Date(ts).toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const stockBadge = p => p.stock === null ? '' : p.stock <= 0 ? '<span class="badge out">Out</span>' : p.stock <= p.low ? `<span class="badge low">${p.stock} left</span>` : `<span class="badge">${p.stock}</span>`;

/* ====================================================================
   STORAGE (IndexedDB) + PASSWORD LOGIN
   ==================================================================== */
const DOCS = ['products', 'sales', 'log', 'suppliers', 'pos', 'counts', 'customers', 'grn', 'moves']; // 'moves' = stock changes (+/- amounts) so several devices can add up instead of overwriting each other
const devId = () => ((typeof syncSt !== 'undefined' && syncSt && syncSt.deviceId) || 'x').slice(0, 6);
const IDB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('epos2', 4);
      r.onupgradeneeded = () => { // v2 adds suppliers/POs/counts, v3 adds customers + goods receipts, v4 adds stock moves
        const d = r.result;
        ['kv', 'vault'].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); });
        DOCS.forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); });
      };
      r.onsuccess = () => { IDB.db = r.result; res(); }; r.onerror = () => rej(r.error);
    });
  },
  tx(stores, fn) { return new Promise((res, rej) => { const t = IDB.db.transaction(stores, 'readwrite'); fn(t); t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); }); },
  get(s, k) { return new Promise((res, rej) => { const r = IDB.db.transaction(s).objectStore(s).get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  all(s) { return new Promise((res, rej) => { const r = IDB.db.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  put(s, v, k) { return IDB.tx([s], t => t.objectStore(s).put(v, k)); },
  // deleting leaves a small "deleted" marker so other devices learn about it when they sync
  del(s, k) { if (DOCS.includes(s)) markDirty(s + '/' + k); return IDB.tx([s], t => t.objectStore(s).put({ id: k, ts: 0, upd: Date.now(), del: true })); },
};
const ITER = 310000, sub = crypto.subtle;
async function deriveKey(secret, salt) {
  const base = await sub.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveKey']);
  return sub.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12)), ct = new Uint8Array(await sub.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const o = new Uint8Array(12 + ct.length); o.set(iv); o.set(ct, 12); return o;
}
async function unseal(key, buf) { buf = new Uint8Array(buf); return new Uint8Array(await sub.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12) }, key, buf.slice(12))); }
// Records are plain JSON (shared through the shop database). Rows saved by older versions are encrypted bytes: still readable, converted when saved again.
const encObj = async o => JSON.parse(JSON.stringify(o));
const decObj = async d => d instanceof Uint8Array ? JSON.parse(td.decode(await unseal(dek, d))) : d;
async function makeUser(name, role, secret, raw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { id: uid(), name, role, salt, wrap: await seal(await deriveKey(secret, salt), raw), created: Date.now(), credUpd: Date.now(), fails: 0, until: 0 };
}
async function tryUnwrap(u, secret) { try { return await unseal(await deriveKey(secret, u.salt), u.wrap); } catch (e) { return null; } }
const validSecret = (role, s) => role === 'admin' ? (s.length >= 8 ? '' : 'Password must be at least 8 characters') : (/^\d{6}$/.test(s) ? '' : 'PIN must be exactly 6 digits');

const fail = () => toast('Could not save! Export a backup now.', true);
async function persist(store, obj) { const k = dek; if (!k) return; try { await IDB.put(store, { id: obj.id, ts: obj.ts, upd: Date.now(), dev: obj.dev, d: await encObj(obj, k) }); markDirty(store + '/' + obj.id); } catch (e) { fail(); } }
const saveProduct = p => persist('products', p.stock === null ? p : { ...p, stock: 0 }); // stock itself is the sum of its moves, never stored in the product
const saveSale = s => persist('sales', s);
async function saveVault() { const k = dek; if (!k || !db) return; try { await IDB.put('vault', { d: await encObj({ settings: db.settings, seq: db.seq }, k), upd: Date.now() }, 'main'); markDirty('vault'); } catch (e) { fail(); } }
// local=true: per-device data only (login lockout counters) — not shared, does not touch the shared change time
const saveMeta = (local) => {
  if (!local) meta.upd = Date.now();
  return IDB.put('kv', meta, 'users').then(() => { if (!local) { markDirty('meta'); meta.users.forEach(u => markDirty('creds/' + u.id)); } }).catch(fail);
};
function logEv(type, text) { if (!db) return; const e = { id: uid(), ts: Date.now(), type, text, user: me ? me.name : '', dev: devId() }; db.log.unshift(e); persist('log', e); }
async function fullSave() {
  DOCS.forEach(n => { db[n] = db[n] || []; });
  const enc = async a => Promise.all(a.map(async o => ({ id: o.id, ts: o.ts, upd: Date.now(), dev: o.dev, d: await encObj(o.stock === null || o.stock === undefined || !('cat' in o) ? o : { ...o, stock: 0 }) })));
  const rows = await Promise.all(DOCS.map(n => enc(db[n])));
  const v = await encObj({ settings: db.settings, seq: db.seq });
  await IDB.tx(['vault', ...DOCS], t => {
    t.objectStore('vault').put({ d: v, upd: Date.now() }, 'main');
    DOCS.forEach((n, i) => { const o = t.objectStore(n); o.clear(); rows[i].forEach(x => o.put(x)); });
  });
  markAllDirty();
}
async function loadDb() {
  const vr = await IDB.get('vault', 'main'), vault = (vr && vr.d && await decObj(vr.d)) || {}; // no settings row yet (new device, nothing synced): use defaults
  const dec = async s => Promise.all((await IDB.all(s)).filter(r => !r.del).map(r => decObj(r.d)));
  const [products, sales, log, suppliers, pos, counts, customers, grn, moves] = await Promise.all(DOCS.map(dec));
  const byTs = (a, b) => (b.ts || 0) - (a.ts || 0);
  db = { settings: { ...DEF, ...vault.settings }, seq: vault.seq || 0, products, sales: sales.sort(byTs), log: log.sort(byTs), suppliers, pos: pos.sort(byTs), counts: counts.sort(byTs), customers, grn: grn.sort(byTs), moves };
  migrateMoves(); recomputeStock();
}
/* Stock = sum of all its moves. Data from before this existed has plain stock numbers: turn each into one starting move (same id on every device, so it is never counted twice). */
function migrateMoves() {
  const has = new Set(db.moves.map(m => m.pid));
  db.products.forEach(p => { if (p.stock > 0 && !has.has(p.id)) { const m = { id: 'init-' + p.id, ts: 0, pid: p.id, d: p.stock, dev: '0' }; db.moves.push(m); persist('moves', m); } });
}
function recomputeStock() {
  const s = {}; db.moves.forEach(m => { s[m.pid] = (s[m.pid] || 0) + m.d; });
  db.products.forEach(p => { if (p.stock !== null) p.stock = s[p.id] || 0; });
}
function setStock(p, n) { // every stock change is recorded as +/- amount
  const d = n - (p.stock || 0); p.stock = n; if (!d) return;
  const m = { id: uid(), ts: Date.now(), pid: p.id, d, dev: devId() }; (db.moves = db.moves || []).push(m); persist('moves', m);
}
// short random per-device tag so two devices selling offline can never issue the same invoice number
const devTag = () => String((syncSt && syncSt.deviceId) || 'x').slice(-3).toUpperCase().padStart(3, '0');
const nextNo = (prefix, arr) => prefix + String(arr.reduce((m, x) => Math.max(m, parseInt(String(x.no).replace(/\D/g, '')) || 0), 0) + 1).padStart(4, '0');

/* data from the previous (unencrypted) version, migrated once then deleted */
async function legacyRead() {
  try {
    if (indexedDB.databases && (await indexedDB.databases()).some(d => d.name === 'epos')) {
      const old = await new Promise((res, rej) => { const r = indexedDB.open('epos'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const get = s => new Promise(res => { if (!old.objectStoreNames.contains(s)) return res([]); const r = old.transaction(s).objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]); });
      const [products, sales, m] = await Promise.all([get('products'), get('sales'), get('meta')]); old.close();
      if (products.length || sales.length) return { products, sales, log: [], seq: (m[0] || {}).seq || 0, settings: { ...DEF, ...(m[0] || {}).settings } };
    }
    const ls = JSON.parse(localStorage.getItem('epos.v1'));
    if (ls && ls.products) return { products: ls.products, sales: ls.sales || [], log: [], seq: ls.seq || 0, settings: { ...DEF, ...ls.settings } };
  } catch (e) {}
  return null;
}
function legacyWipe() { try { indexedDB.deleteDatabase('epos'); localStorage.removeItem('epos.v1'); } catch (e) {} }
function seedData() {
  const P = (name, cat, price, cost, stock, sku, icon) => ({ id: uid(), name, cat, price, cost, stock, low: 5, sku, icon });
  return [P('Espresso', 'Drinks', 2.5, .6, 100, '1001', '☕'), P('Latte', 'Drinks', 3.5, .9, 100, '1002', '🥛'), P('Cappuccino', 'Drinks', 3.5, .9, 100, '1003', '☕'),
    P('Iced Tea', 'Drinks', 2.8, .5, 40, '1004', '🧋'), P('Orange Juice', 'Drinks', 3.2, 1.2, 24, '1005', '🍊'), P('Water 500ml', 'Drinks', 1, .3, 60, '1006', '💧'),
    P('Croissant', 'Food', 2.9, 1.1, 18, '2001', '🥐'), P('Sandwich', 'Food', 5.5, 2.4, 12, '2002', '🥪'), P('Chicken Wrap', 'Food', 6.5, 2.9, 10, '2003', '🌯'),
    P('Brownie', 'Snacks', 2.2, .8, 4, '3001', '🍫'), P('Chips', 'Snacks', 1.8, .8, 30, '3002', '🥔'), P('Cookie', 'Snacks', 1.5, .5, 0, '3003', '🍪')];
}

/* ====================================================================
   SETUP · LOGIN · LOCK
   ==================================================================== */
let legacy = null;
async function showSetup() {
  legacy = await legacyRead(); me = null;
  $('.app').classList.add('locked');
  $('#main').innerHTML = `<div class="login"><div class="logo">${ICON.logo}</div><h1>Welcome to EPOS</h1><p>Create the administrator account.<br>This password locks the app on this device. Shop data is stored in your private shop database.</p>
    <div class="loginform">
      ${legacy ? `<div class="stat" style="text-align:left"><b style="font-size:16px">Existing data found</b><span>${legacy.products.length} items, ${legacy.sales.length} sales will be kept.</span></div>` : ''}
      <label class="fld">Store name<input id="sStore" value="${esc(legacy ? legacy.settings.store : '')}" placeholder="e.g. Corner Cafe" autocomplete="off"></label>
      <label class="fld">Your name<input id="sName" placeholder="e.g. Anna" autocomplete="off"></label>
      <label class="fld">Admin password (8+ characters)<input id="sPw" type="password" autocomplete="new-password"></label>
      <label class="fld">Confirm password<input id="sPw2" type="password" autocomplete="new-password"></label>
      ${legacy ? '' : '<label class="group frow" style="border-radius:14px"><span>Add sample items</span><input id="sSample" type="checkbox" class="sw"></label>'}
      <div class="err" id="sErr"></div>
      <button class="btn pri big" data-act="createVault">Create & Start</button>
      <div class="gf" style="text-align:center">If you forget this admin password it cannot be reset from inside the app. Keep backups.</div>
      <button class="back" data-act="restore">Restore from backup file</button></div></div>`;
}
async function createVault() {
  const g = i => $('#' + i).value.trim(), pw = $('#sPw').value, err = $('#sErr');
  if (!g('sStore') || !g('sName')) return err.textContent = 'Enter the store name and your name';
  const bad = validSecret('admin', pw); if (bad) return err.textContent = bad;
  if (pw !== $('#sPw2').value) return err.textContent = 'Passwords do not match';
  err.textContent = 'Creating secure vault…';
  dek = await sub.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = new Uint8Array(await sub.exportKey('raw', dek));
  meta = { users: [], autoLock: 5, lastBackup: 0, fails: [], store: g('sStore'), upd: Date.now() };
  const u = await makeUser(g('sName'), 'admin', pw, raw); meta.users.push(u);
  db = legacy || { settings: { ...DEF }, seq: 0, products: $('#sSample') && $('#sSample').checked ? seedData() : [], sales: [], log: [] };
  DOCS.forEach(n => { db[n] = db[n] || []; }); migrateMoves();
  db.settings.store = g('sStore'); me = { id: u.id, name: u.name, role: 'admin' }; dekRaw = raw;
  await IDB.put('kv', meta, 'users'); await fullSave();
  if (legacy) legacyWipe();
  logEv('setup', 'Vault created'); lastUser = me.id; enterApp();
}
function showLogin() {
  if (syncSt && sb && syncSt.dirty.length) syncFlush(); // send what is left when locking
  closeScanner(); me = null; db = null; cnt = null; POD = null; dek = null; dekRaw = null; closeModal(); L = { sel: null, pin: '', busy: false, err: '' };
  $('.app').classList.add('locked'); renderLogin();
}
function renderLogin() {
  const u = meta.users.find(x => x.id === L.sel), m = $('#main');
  if (!u) {
    m.innerHTML = `<div class="login">${brandMark()}<h1>${esc(meta.store || 'EPOS')}</h1><p>Who’s working?</p>
      <div class="users">${meta.users.map(x => `<button class="uc" data-act="pick" data-id="${x.id}">${avatar(x, 'lg')}<b>${esc(x.name)}</b><i>${x.role === 'admin' ? 'Administrator' : 'Cashier'}</i></button>`).join('')}</div>
      <small style="margin-top:26px;color:var(--l3)">EPOS ${APP_VERSION}</small></div>`;
    return;
  }
  if (u.needsReset) { m.innerHTML = `<div class="login">${avatar(u, 'lg')}<h1 style="font-size:24px">${esc(u.name)}</h1><p>This PIN was not part of the cloud backup.<br>Ask an administrator to set a new PIN.</p><button class="back" data-act="pick" data-id="">‹ Switch account</button></div>`; return; }
  if (!u.wrap) { m.innerHTML = `<div class="login">${avatar(u, 'lg')}<h1 style="font-size:24px">${esc(u.name)}</h1><p>This sign-in is not available on this device.<br>${u.role === 'admin' ? 'Administrators sign in on a device connected with the admin shop account.' : 'Wait for sync to finish, then try again.'}</p><button class="back" data-act="pick" data-id="">‹ Switch account</button></div>`; return; }
  const wait = Math.ceil((u.until - Date.now()) / 1000), head = `${avatar(u, 'lg')}<h1 style="font-size:24px">${esc(u.name)}</h1>`;
  const msg = wait > 0 ? `Too many attempts. Try again in ${wait}s` : L.busy ? 'Unlocking…' : esc(L.err);
  if (u.role === 'admin') {
    m.innerHTML = `<div class="login">${head}<div class="loginform"><label class="fld" style="text-align:left">Password<input id="lpw" type="password" autocomplete="off" autofocus></label>
      <div class="err">${msg}</div><button class="btn pri big" data-act="unlockPw" ${L.busy ? 'disabled' : ''}>Unlock</button></div><button class="back" data-act="pick" data-id="">‹ Switch account</button></div>`;
    setTimeout(() => { const i = $('#lpw'); i && i.focus(); }, 60);
  } else {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    m.innerHTML = `<div class="login">${head}<p style="margin-bottom:6px">Enter your 6-digit PIN</p>
      <div class="dots" id="dots">${[0, 1, 2, 3, 4, 5].map(i => `<span class="${i < L.pin.length ? 'f' : ''}"></span>`).join('')}</div>
      <div class="err" style="margin-bottom:10px">${msg}</div>
      <div class="keys">${keys.map(k => k === '' ? '<span></span>' : `<button data-act="${k === '⌫' ? 'kdel' : 'key'}" data-k="${k}">${k}</button>`).join('')}</div>
      <button class="back" data-act="pick" data-id="">‹ Switch account</button></div>`;
  }
}
async function tryLogin(u, secret) {
  if (L.busy || u.until > Date.now()) return;
  L.busy = true; L.err = ''; renderLogin();
  const raw = await tryUnwrap(u, secret);
  if (!raw) {
    u.fails = (u.fails || 0) + 1;
    if (u.fails >= 5) u.until = Date.now() + Math.min(30000 * 2 ** (u.fails - 5), 900000);
    meta.fails = [{ ts: Date.now(), user: u.name }, ...(meta.fails || [])].slice(0, 30);
    await saveMeta(true); L.busy = false; L.pin = ''; L.err = u.role === 'admin' ? 'Incorrect password' : 'Incorrect PIN';
    renderLogin(); const d = $('#dots'); if (d) d.classList.add('shake');
    if (u.until > Date.now()) { const t = setInterval(() => { if (!L.sel || u.until <= Date.now()) { clearInterval(t); } if (!me) renderLogin(); }, 1000); }
    return;
  }
  try {
    dek = await sub.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    dekRaw = u.role === 'admin' ? raw : null;
    u.fails = 0; u.until = 0; await saveMeta(true);
    me = { id: u.id, name: u.name, role: u.role };
    await loadDb();
    if (lastUser !== me.id) { cart = []; custId = null; }
    lastUser = me.id; logEv('login', 'Signed in'); enterApp();
  } catch (e) { console.error('open data failed', e); dek = null; me = null; L.busy = false; L.err = 'Could not open data (' + ((e && (e.message || e.name)) || 'unknown') + ')'; renderLogin(); }
}
function lock() { cart = cart.slice(); showLogin(); }
function enterApp() {
  $('.app').classList.remove('locked'); L = { sel: null, pin: '', busy: false, err: '' };
  view = isAdmin() ? 'dash' : 'sell'; q = ''; cat = 'All'; bump(); render();
  sbStart(); // live sync with the shop database
  if (navigator.onLine && Date.now() - (+localStorage.getItem('epos.vcheck') || 0) > 6 * 3600e3) setTimeout(() => checkUpdate(true), 4000); // quiet check every 6 h
}
let idleT;
function bump() { clearTimeout(idleT); if (me && meta && meta.autoLock > 0) idleT = setTimeout(() => { if (me) lock(); }, meta.autoLock * 60000); }
['pointerdown', 'keydown', 'scroll'].forEach(ev => addEventListener(ev, bump, { passive: true, capture: true }));

/* ====================================================================
   SHELL
   ==================================================================== */
const tabsFor = () => isAdmin() ? [['dash', 'Dashboard'], ['sell', 'Sell'], ['stock', 'Inventory'], ['sales', 'Sales'], ['cust', 'Customers'], ['settings', 'Settings']] : [['sell', 'Sell'], ['cust', 'Customers'], ['sales', 'My Sales'], ['account', 'Account']];
function renderNav() {
  $('#nav').innerHTML = `<div class="brand">${brandMark()}<b>${esc(S().store)}</b></div>` +
    tabsFor().map(([k, l]) => `<button class="t ${view === k ? 'on' : ''}" data-act="nav" data-v="${k}">${ICON[k === 'sales' ? 'sales' : k]}<span>${l}</span></button>`).join('') +
    `<div class="sp"></div><div class="who">${avatar(uById(me.id))}<span class="wi"><b>${esc(me.name)}</b><span>${isAdmin() ? 'Administrator' : 'Cashier'}</span></span><button data-act="lock" aria-label="Lock">${ICON.lock}</button></div>`;
}
function render() {
  if (!me || !db) return;
  if (!tabsFor().some(t => t[0] === view)) view = 'sell';
  renderNav(); const m = $('#main');
  if (view === 'dash') m.innerHTML = dashView();
  else if (view === 'sell') { m.innerHTML = sellView(); updateGrid(); updateCart(); }
  else if (view === 'stock') { m.innerHTML = stockView(); if (invTab === 'items') updateStock(); if (invTab === 'count' && cnt) updateCount(); }
  else if (view === 'sales') m.innerHTML = salesView();
  else if (view === 'cust') { m.innerHTML = custView(); updateCust(); }
  else if (view === 'settings') m.innerHTML = settingsView();
  else m.innerHTML = accountView();
}

/* ---------- app version + update check ---------- */
const APP_VERSION = '2026.11.18-20';
const aboutGroup = () => G('About', `<div class="frow"><span>Version</span><span style="margin-left:auto;color:var(--l2)" id="verTxt">${APP_VERSION}</span></div>` + BTN('checkUpdate', 'Check for updates'));
async function latestVersion() {
  const t = await (await fetch('app.js?v=' + Date.now(), { cache: 'no-store' })).text(), v = (t.match(/APP_VERSION = '([^']+)'/) || [])[1];
  if (!v) throw new Error('no version'); return v;
}
async function checkUpdate(silent) {
  if (!silent) toast('Checking…');
  try {
    const v = await latestVersion(); localStorage.setItem('epos.vcheck', String(Date.now()));
    if (v === APP_VERSION) { if (!silent) toast('You have the latest version ✓'); return; }
    if (silent) return toast(`New version ${v} available — Settings → Check for updates`);
    modal(`<h2>Update available</h2><div class="sub">You have ${APP_VERSION}. The latest is ${esc(v)}.</div><div class="gf" style="text-align:center">Your data is not affected. The app restarts and you sign in again.</div>
      <button class="btn pri big" data-act="applyUpdate">Update now</button><button class="btn" data-act="close">Later</button>`);
  } catch (e) { if (!silent) toast('Could not check for updates (offline?)', true); }
}
async function applyUpdate() { // refresh the cached app files (data lives in IndexedDB and is untouched)
  if (syncSt && sb && syncSt.dirty.length) { try { await syncFlush(); } catch (e) {} }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); } catch (e) {}
  location.reload();
}

/* ====================================================================
   CAMERA BARCODE SCANNER (uses the browser's built-in BarcodeDetector, no external code)
   ==================================================================== */
const scanBtn = a => `<button class="scanbtn" data-act="${a}" aria-label="Scan with camera">${ICON.scan}</button>`;
const skuEq = (a, b) => { a = String(a || '').trim().toLowerCase(); b = String(b || '').trim().toLowerCase(); return !!a && !!b && (a === b || (/^\d+$/.test(a) && /^\d+$/.test(b) && a.replace(/^0+/, '') === b.replace(/^0+/, ''))); };
const bySku = code => db.products.find(p => skuEq(p.sku, code));
let scan = null, audio = null;
function beep(ok = true) {
  try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume && audio.resume(); const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = ok ? 880 : 220; g.gain.value = 0.08; o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + (ok ? 0.09 : 0.25)); } catch (e) {}
  try { navigator.vibrate && navigator.vibrate(ok ? 25 : [40, 40, 40]); } catch (e) {}
}
function closeScanner() {
  if (!scan) return; clearInterval(scan.timer); try { scan.stream.getTracks().forEach(t => t.stop()); } catch (e) {} scan.el.remove(); scan = null;
}
async function openScanner({ title = 'Scan barcode', continuous = false, onCode }) {
  closeScanner();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Camera not available. Open the app over HTTPS.', true);
  if (!('BarcodeDetector' in window)) return toast('This browser cannot scan with the camera. Use a Bluetooth scanner or type the code.', true);
  const el = document.createElement('div'); el.id = 'scanner';
  el.innerHTML = `<video playsinline muted autoplay></video><div class="sc-top"><b>${esc(title)}</b><span id="scCount"></span><button data-act="scClose" aria-label="Close">${ICON.x}</button></div>
    <div class="sc-frame"><i></i></div><div class="sc-msg" id="scMsg">Point the camera at a barcode</div>
    <div class="sc-bar"><button class="btn" id="scTorch" data-act="scTorch" hidden>Light</button><button class="btn" data-act="scType">Type code</button><button class="btn pri" data-act="scClose">${continuous ? 'Done' : 'Cancel'}</button></div>`;
  document.body.appendChild(el);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false }); }
  catch (e) { el.remove(); return toast(e.name === 'NotAllowedError' ? 'Camera permission denied. Allow it in Chrome site settings.' : 'Could not open the camera', true); }
  const video = el.querySelector('video'); video.srcObject = stream; try { await video.play(); } catch (e) {}
  let formats; try { formats = await BarcodeDetector.getSupportedFormats(); } catch (e) {}
  const det = new BarcodeDetector(formats && formats.length ? { formats } : undefined);
  scan = { el, stream, video, det, onCode, continuous, last: '', lastT: 0, busy: false, n: 0, torch: false, timer: null };
  const caps = stream.getVideoTracks()[0].getCapabilities ? stream.getVideoTracks()[0].getCapabilities() : {}; if (caps.torch) $('#scTorch').hidden = false;
  const me_ = scan; scan.timer = setInterval(() => scanTick(me_), 150);
}
async function scanTick(s) {
  if (scan !== s || s.busy || !s.video.videoWidth) return; s.busy = true;
  try {
    const r = await s.det.detect(s.video); if (scan !== s) return;
    if (r.length && r[0].rawValue) { const code = r[0].rawValue, now = Date.now(); const fresh = code !== s.last || now - s.lastT > 1200; s.last = code; s.lastT = now; if (fresh) scanHit(code); }
  } catch (e) {} finally { s.busy = false; }
}
function scanHit(code) {
  const s = scan; if (!s) return; let res; try { res = s.onCode(code) || { ok: true }; } catch (e) { res = { ok: false, msg: 'Error: ' + e.message }; }
  beep(res.ok); const m = $('#scMsg'); if (m) { m.textContent = res.msg || code; m.className = 'sc-msg ' + (res.ok ? 'ok' : 'bad'); }
  if (res.ok) { s.n++; const c = $('#scCount'); if (c && s.continuous) c.textContent = s.n + ' scanned'; if (!s.continuous) setTimeout(closeScanner, 350); }
}
/* what each screen does with a scanned code */
const scanHandlers = {
  sell: code => {
    const p = bySku(code);
    if (p) return addToCart(p.id) ? { ok: true, msg: `✓ ${p.name} · ${cart.find(c => c.id === p.id).qty} in order` } : { ok: false, msg: `${p.name}: not enough stock` };
    const c = db.customers.find(x => (x.no || '').toLowerCase() === code.toLowerCase() || (digits(code).length >= 6 && digits(x.phone) === digits(code)));
    if (c) { custId = c.id; updateCart(); return { ok: true, msg: `✓ Customer: ${c.name}` }; }
    return { ok: false, msg: `No item or customer for ${code}` };
  },
  sku: code => { const i = $('#fSku'); if (i) i.value = code; const other = bySku(code); return { ok: true, msg: other && other.id !== (($('[data-act=saveProd]') || {}).dataset || {}).id ? `✓ ${code} (already used by ${other.name})` : `✓ ${code}` }; },
  inv: code => { stockQ = code; const i = $('#sq'); if (i) i.value = code; updateStock(); const p = bySku(code); return p ? { ok: true, msg: `✓ ${p.name}` } : { ok: true, msg: `No item with code ${code}` }; },
  count: code => {
    const i = cnt.lines.findIndex(l => skuEq(l.sku, code)); if (i < 0) return { ok: false, msg: `Not in this count: ${code}` };
    const l = cnt.lines[i], v = (l.counted || 0) + 1; cntSetCounted(i, v); const inp = document.querySelector(`.cin[data-ci="${i}"]`); if (inp) inp.value = v;
    return { ok: true, msg: `✓ ${l.name} · counted ${v}` };
  },
  po: code => { const p = bySku(code); if (!p) return { ok: false, msg: `No item for ${code}` }; syncPo(); const ex = POD.items.find(i => i.id === p.id); ex ? ex.qty++ : POD.items.push({ id: p.id, name: p.name, qty: suggestQty(p), cost: p.cost || 0 }); poSheet(); return { ok: true, msg: `✓ ${p.name} · qty ${(POD.items.find(i => i.id === p.id)).qty}` }; },
  rcv: code => { const p = bySku(code); if (!p) return { ok: false, msg: `No item for ${code}` }; syncRcv(); const ex = RCV.items.find(i => i.id === p.id); ex ? ex.qty++ : RCV.items.push({ id: p.id, name: p.name, qty: 1, cost: p.cost || 0 }); rcvSheet(); return { ok: true, msg: `✓ ${p.name} · qty ${(RCV.items.find(i => i.id === p.id)).qty}` }; },
};

/* ---------- SELL ---------- */
function sellView() {
  return `<section class="sell"><div class="catalog">
      <div class="search hasscan">${ICON.search}<input id="q" type="search" placeholder="Search or scan barcode" autocomplete="off" value="${esc(q)}">${scanBtn('scanSell')}</div>
      <div class="chips" id="chips"></div><div class="grid" id="grid"></div></div>
    <aside class="cart" id="cart"></aside><button class="cartbar" id="cartbar" data-act="cartOpen"></button></section>`;
}
const picHtml = p => safeImg(p.img) ? `<img src="${safeImg(p.img)}" alt="" loading="lazy">` : esc(p.icon || initial(p.name));
function resizeImg(file, size = 400) { // square-crop + shrink so photos stay small (~30 KB)
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size; const s = Math.min(im.width, im.height);
      c.getContext('2d').drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.82));
    };
    im.onerror = () => rej(new Error('bad image')); im.src = url;
  });
}
function resizeFit(file, maxW = 384, maxH = 220) { // logo: keep aspect ratio, white background (receipt friendly)
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const k = Math.min(maxW / im.width, maxH / im.height, 1), c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL('image/jpeg', 0.9));
    };
    im.onerror = () => rej(new Error('bad image')); im.src = url;
  });
}
const loadImg = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
let bitsCache = { k: '', v: null };
async function logoBits() { // 1-bit raster of the logo for the thermal printer (GS v 0)
  if (!meta.logo || S().printLogo === false) return null;
  const dots = +S().paper === 80 ? 576 : 384, k = meta.logo.length + ':' + dots; if (bitsCache.k === k) return bitsCache.v;
  const im = await loadImg(meta.logo), sc = Math.min(dots * 0.6 / im.width, 150 / im.height), w = Math.max(8, Math.round(im.width * sc / 8) * 8), h = Math.max(1, Math.round(im.height * sc));
  const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(im, 0, 0, w, h);
  const px = x.getImageData(0, 0, w, h).data, bpr = w / 8, data = new Uint8Array(bpr * h);
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) { const i = (yy * w + xx) * 4; if (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 < 150) data[yy * bpr + (xx >> 3)] |= 0x80 >> (xx & 7); }
  bitsCache = { k, v: { w, h, bpr, data } }; return bitsCache.v;
}
let imgDraft = null, avTarget = null, modalUser = null;
function updateGrid() {
  const cats = ['All', ...new Set(db.products.map(p => p.cat).filter(Boolean))];
  if (!cats.includes(cat)) cat = 'All';
  $('#chips').innerHTML = cats.map(c => `<button class="chip ${c === cat ? 'on' : ''}" data-act="cat" data-c="${esc(c)}">${esc(c)}</button>`).join('');
  const k = q.trim().toLowerCase();
  const list = db.products.filter(p => (cat === 'All' || p.cat === cat) && (!k || p.name.toLowerCase().includes(k) || (p.sku || '').toLowerCase().includes(k)));
  $('#grid').innerHTML = list.map(p => {
    const n = (cart.find(c => c.id === p.id) || {}).qty, out = p.stock !== null && p.stock <= 0, low = p.stock !== null && p.stock <= p.low;
    return `<button class="tile ${out ? 'out' : low ? 'low' : ''}" data-act="add" data-id="${p.id}">
      <span class="tim" style="background:${hue(p.cat || p.name)}">${picHtml(p)}</span>
      <span class="tn">${esc(p.name)}</span><span class="tr"><span class="tp">${money(p.price)}</span>${p.stock !== null ? `<span class="ts">${out ? 'Out' : p.stock}</span>` : ''}</span>
      ${n ? `<b class="qb">${n}</b>` : ''}</button>`;
  }).join('') || `<div class="empty" style="grid-column:1/-1">${db.products.length ? 'No items found' : isAdmin() ? 'No items yet.<br>Add them in Inventory.' : 'No items yet.<br>Ask an administrator to add items.'}</div>`;
}
/* ---------- loyalty ---------- */
const lyOn = () => S().loyaltyOn !== false;
const cust = id => db.customers.find(c => c.id === id) || null;
const earnPts = base => lyOn() && +S().earnPer > 0 ? Math.floor(Math.max(base, 0) / +S().earnPer) : 0;
const ptsValue = n => r2(n * (+S().ptValue || 0));
function totals(disc, rv = 0) { // rv = value of redeemed loyalty points
  const sub = r2(cart.reduce((a, c) => a + prod(c.id).price * c.qty, 0));
  const d = r2(Math.min(Math.max(+disc || 0, 0), sub)), r = r2(Math.min(Math.max(+rv || 0, 0), sub - d)), tax = r2((sub - d - r) * (+S().tax || 0) / 100);
  return { sub, disc: d, redeem: r, tax, total: r2(sub - d - r + tax) };
}
const ckRv = () => ck && ck.pts ? ptsValue(ck.pts) : 0;
function custRow() {
  if (!lyOn() && !custId) return '';
  const c = cust(custId);
  return `<div class="custrow">${c ? `<button class="m" data-act="custPick" style="text-align:left">${avatar(null, '')}<span class="m"><b>${esc(c.name)}</b><small>${lyOn() ? c.points + ' points' : esc(c.phone || '')}</small></span></button><button class="x2" data-act="custClear" aria-label="Remove customer">${ICON.x}</button>`
    : `<button class="btn sm" data-act="custPick" style="width:100%">${ICON.account} Add customer${lyOn() ? ' · earn points' : ''}</button>`}</div>`;
}
function updateCart() {
  cart = cart.filter(c => prod(c.id));
  const t = totals(discount), count = cart.reduce((a, c) => a + c.qty, 0);
  $('#cart').innerHTML = `
    <div class="ch"><h2>Order</h2>${cart.length ? '<button class="btn sm dng" data-act="clear">Clear</button>' : ''}<button class="btn sm x" data-act="cartClose">Done</button></div>
    <div class="lines">${cart.length ? cart.map(c => { const p = prod(c.id); return `
      <div class="line"><div><div class="ln">${esc(p.name)}</div><div class="lu">${money(p.price)}</div></div><div class="lt">${money(p.price * c.qty)}</div>
        <button class="rm" data-act="rm" data-id="${c.id}">Remove</button>
        <div class="step" style="justify-self:end"><button data-act="dec" data-id="${c.id}">−</button><span>${c.qty}</span><button data-act="inc" data-id="${c.id}">+</button></div></div>`; }).join('')
      : '<div class="empty">Tap items to start an order</div>'}</div>
    <div class="totals">${cart.length ? custRow() : ''}${cart.length ? `<div class="t"><span>Subtotal</span><span>${money(t.sub)}</span></div>
      ${discount ? `<div class="t"><span>Discount</span><span>−${money(t.disc)}</span></div>` : ''}
      ${+S().tax ? `<div class="t"><span>Tax ${S().tax}%</span><span>${money(t.tax)}</span></div>` : ''}` : ''}
      <div class="t g"><span>Total</span><span>${money(t.total)}</span></div>
      <button class="btn pri big" data-act="checkout" ${cart.length ? '' : 'disabled'}>Charge ${money(t.total)}</button></div>`;
  const bar = $('#cartbar');
  bar.innerHTML = `<span>${count} item${count === 1 ? '' : 's'}</span><span>View order · ${money(t.total)}</span>`; bar.classList.toggle('hidden', !count);
}
function addToCart(id) {
  const p = prod(id); if (!p) return false;
  const c = cart.find(x => x.id === id), have = c ? c.qty : 0;
  if (p.stock !== null && have + 1 > p.stock) { toast(p.stock <= 0 ? `${p.name} is out of stock` : `Only ${p.stock} in stock`, true); return false; }
  c ? c.qty++ : cart.push({ id, qty: 1 }); updateGrid(); updateCart(); return true;
}

/* ---------- CHECKOUT ---------- */
const maxDisc = () => r2(totals(0).sub * (+S().cashDiscMax || 0) / 100);
function openCheckout() { if (!cart.length) return; ck = { method: 'cash', recv: '', disc: discount || '', pts: 0 }; renderCheckout(); }
const maxPts = () => { const c = cust(custId); if (!c || !lyOn() || !(+S().ptValue > 0)) return 0; const t = totals(ck.disc); return Math.min(c.points, Math.floor((t.sub - t.disc) / +S().ptValue)); };
const canRedeem = () => { const c = cust(custId); return !!c && lyOn() && c.points >= (+S().minRedeem || 0) && maxPts() > 0; };
function renderCheckout() {
  const m = ck.method, c = cust(custId);
  modal(`<h2>Payment</h2><div class="bigtotal" id="ckTotal"></div>
    ${c && lyOn() ? `<div class="gf" style="text-align:center;margin:-8px 0 0">${esc(c.name)} · ${c.points} points</div>` : ''}
    <div class="group"><label class="frow"><span>Discount (${esc(S().cur)})</span><input id="ckDisc" type="number" inputmode="decimal" min="0" step="any" value="${esc(ck.disc)}" placeholder="0"></label>
    ${canRedeem() ? `<label class="frow"><span>Redeem points <small id="ckPv" style="color:var(--l2)"></small></span><input id="ckPts" type="number" inputmode="numeric" min="0" step="1" value="${ck.pts || ''}" placeholder="0 – ${maxPts()}"></label><button class="frow btnrow" data-act="ckPtsMax"><span>Use maximum (${maxPts()} pts)</span><i>›</i></button>` : ''}</div>
    ${isAdmin() ? '' : `<div class="gf" style="margin-top:-8px">Cashier discount limit: ${money(maxDisc())} (${S().cashDiscMax}%)</div>`}
    <div class="seg">${[['cash', 'Cash'], ['card', 'Card'], ['other', 'E-wallet']].map(([k, l]) => `<button class="${m === k ? 'on' : ''}" data-act="ckm" data-m="${k}">${l}</button>`).join('')}</div>
    ${m === 'cash' ? `<div class="group"><label class="frow"><span>Cash received</span><input id="ckRecv" type="number" inputmode="decimal" min="0" step="any" value="${esc(ck.recv)}" placeholder="Exact"></label></div>
      <div class="quick" id="ckQuick"></div><div class="change" id="ckChange"></div>` : ''}
    <div class="actions"><button class="btn big" data-act="ckdone" data-print="0">Done</button><button class="btn pri big" data-act="ckdone" data-print="1">${ICON.print} Done & Print</button></div>
    <button class="btn" data-act="close">Cancel</button>`);
  ckUpdate();
}
function ckUpdate() {
  if (ck.pts) ck.pts = Math.min(ck.pts, maxPts());
  const t = totals(ck.disc, ckRv()); $('#ckTotal').textContent = money(t.total);
  const pv = $('#ckPv'); if (pv) pv.textContent = ck.pts ? `= −${money(t.redeem)}` : '';
  if (ck.method !== 'cash') return;
  const opts = new Set([t.total]);
  [5, 10, 20, 50, 100, 500, 1000].forEach(s => { const v = Math.ceil(t.total / s) * s; if (v >= t.total && opts.size < 5) opts.add(v); });
  $('#ckQuick').innerHTML = [...opts].map((v, i) => `<button class="chip" data-act="ckq" data-v="${v}">${i ? money(v) : 'Exact'}</button>`).join('');
  const recv = ck.recv === '' ? t.total : +ck.recv, diff = r2(recv - t.total), el = $('#ckChange');
  el.className = 'change' + (diff < 0 ? ' bad' : '');
  el.innerHTML = diff < 0 ? `<span>Short by</span><span>${money(-diff)}</span>` : `<span>Change</span><span>${money(diff)}</span>`;
}
function finishSale(print) {
  if (ck.pts) ck.pts = Math.min(ck.pts, maxPts());
  const t = totals(ck.disc, ckRv()), method = ck.method, c = cust(custId), used = t.redeem > 0 ? ck.pts : 0, earned = c ? earnPts(t.sub - t.disc - t.redeem) : 0;
  if (!isAdmin() && t.disc > maxDisc() + 0.001) return toast(`Discount over the cashier limit (${money(maxDisc())})`, true);
  const paid = method === 'cash' ? (ck.recv === '' ? t.total : +ck.recv) : t.total;
  if (paid < t.total) return toast('Cash received is less than total', true);
  for (const ci of cart) { // stock may have changed on another device since the item was added
    const p = prod(ci.id);
    if (!p) return toast('An item in this order no longer exists. Remove it and try again.', true);
    if (p.stock !== null && ci.qty > p.stock) return toast(`${p.name}: only ${Math.max(0, p.stock)} left in stock`, true);
  }
  const sale = {
    id: uid(), no: 'INV-' + String(++db.seq).padStart(5, '0') + '-' + devTag(), ts: Date.now(), cashier: { id: me.id, name: me.name },
    items: cart.map(c => { const p = prod(c.id); return { id: p.id, name: p.name, price: p.price, cost: p.cost || 0, qty: c.qty }; }),
    ...t, method, paid: r2(paid), change: r2(paid - t.total),
  };
  if (c) { // loyalty: update the customer record
    c.points = Math.max(0, c.points - used + earned); c.spent = r2((c.spent || 0) + t.total); c.visits = (c.visits || 0) + 1; c.lastVisit = sale.ts; persist('customers', c);
    sale.customerId = c.id; sale.customerName = c.name; sale.pts = { earned, used, balance: c.points };
  }
  sale.items.forEach(i => { const p = prod(i.id); if (p && p.stock !== null) setStock(p, Math.max(0, p.stock - i.qty)); });
  db.sales.unshift(sale); cart = []; discount = 0; custId = null; saveSale(sale); saveVault();
  if (t.disc) logEv('discount', `${sale.no}: discount ${money(t.disc)}`);
  closeModal(); render(); showReceipt(sale); if (print) doPrint(sale);
}

/* ---------- RECEIPT ---------- */
const width = () => (+S().paper === 80 ? 48 : 32);
function wrap(s, w) {
  const out = []; let cur = '';
  for (const word of String(s).split(/\s+/)) {
    let wd = word;
    while (wd.length > w) { if (cur) { out.push(cur); cur = ''; } out.push(wd.slice(0, w)); wd = wd.slice(w); }
    if ((cur + ' ' + wd).trim().length > w) { out.push(cur); cur = wd; } else cur = (cur + ' ' + wd).trim();
  }
  if (cur) out.push(cur); return out.length ? out : [''];
}
const lr = (l, r, w) => { l = String(l); r = String(r); const room = w - r.length - 1; if (l.length > room) l = l.slice(0, Math.max(room, 0)); return l + ' '.repeat(Math.max(w - l.length - r.length, 1)) + r; };
const asc = t => String(t).replace(/[€£¥₹₫฿]/g, c => ({ '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'Rs', '₫': 'VND', '฿': 'THB' }[c])).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?');
const pm = n => asc(money(n));
function receiptLines(s) {
  const W = width(), L = [], st = S(), dash = '-'.repeat(W);
  const add = (t, o = {}) => L.push({ t: asc(t), ...o });
  if (meta.logo && st.printLogo !== false) L.push({ img: meta.logo, a: 'c', t: '' });
  wrap(asc(st.store), W / 2 | 0).forEach(t => add(t, { a: 'c', b: 1, s: 2 }));
  if (st.addr) wrap(asc(st.addr), W).forEach(t => add(t, { a: 'c' }));
  if (st.phone) add('Tel: ' + st.phone, { a: 'c' });
  add(dash); add('No: ' + s.no);
  add(new Date(s.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
  if (s.cashier) add('Cashier: ' + s.cashier.name);
  if (s.customerName) wrap('Customer: ' + asc(s.customerName), W).forEach(t => add(t));
  add(dash);
  s.items.forEach(i => { wrap(asc(i.name), W).forEach(t => add(t)); add(lr(`  ${i.qty} x ${pm(i.price)}`, pm(i.price * i.qty), W)); });
  add(dash);
  if (s.disc || s.tax || s.redeem) add(lr('Subtotal', pm(s.sub), W));
  if (s.disc) add(lr('Discount', '-' + pm(s.disc), W));
  if (s.redeem) add(lr(`Points used (${s.pts ? s.pts.used : ''})`, '-' + pm(s.redeem), W));
  if (s.tax) add(lr(`Tax ${st.tax}%`, pm(s.tax), W));
  add(lr('TOTAL', pm(s.total), W), { b: 1 });
  if (s.method === 'cash') { add(lr('Cash', pm(s.paid), W)); add(lr('Change', pm(s.change), W)); }
  else add(lr('Paid by', { card: 'Card', other: 'E-wallet' }[s.method] || s.method, W));
  add('='.repeat(W));
  if (s.pts) { add(lr('Points earned', '+' + s.pts.earned, W)); add(lr('Points balance', s.pts.balance, W), { b: 1 }); add(dash); }
  if (st.footer) wrap(asc(st.footer), W).forEach(t => add(t, { a: 'c' }));
  if (s.void) add('*** VOIDED ***', { a: 'c', b: 1 });
  return L;
}
function receiptHtml(lines) {
  return `<div class="rcpt" style="width:${width() * 0.62 + 2}em">` + lines.map(l => l.img ? `<div class="c"><img src="${safeImg(l.img)}" alt="" style="max-width:55%;max-height:90px;filter:grayscale(1) contrast(1.4)"></div>` : `<div class="${l.a === 'c' ? 'c' : ''} ${l.b ? 'b' : ''} ${l.s === 2 ? 'd' : ''}">${esc(l.t) || ' '}</div>`).join('') + '</div>';
}
function showReceipt(s) {
  modal(`<h2>${s.void ? 'Voided sale' : 'Sale complete'}</h2>${receiptHtml(receiptLines(s))}
    <div class="actions"><button class="btn" data-act="close">${view === 'sell' ? 'New sale' : 'Close'}</button><button class="btn pri" data-act="print" data-id="${s.id}">${ICON.print} Print</button></div>
    ${isAdmin() && !s.void ? `<button class="btn dng" data-act="void" data-id="${s.id}">Void sale & restock</button>` : ''}`);
}

/* ---------- PRINTING ---------- */
function escpos(lines, bits) {
  const o = [0x1b, 0x40];
  lines.forEach(l => {
    if (l.img) { if (bits) { o.push(0x1b, 0x61, 1, 0x1d, 0x76, 0x30, 0, bits.bpr & 255, bits.bpr >> 8, bits.h & 255, bits.h >> 8); bits.data.forEach(b => o.push(b)); o.push(0x0a); } return; }
    o.push(0x1b, 0x61, { l: 0, c: 1, r: 2 }[l.a || 'l'], 0x1b, 0x45, l.b ? 1 : 0, 0x1d, 0x21, l.s === 2 ? 0x11 : 0);
    te.encode(asc(l.t)).forEach(b => o.push(b)); o.push(0x0a);
  });
  o.push(0x1b, 0x61, 0, 0x1b, 0x45, 0, 0x1d, 0x21, 0, 0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0x00);
  return new Uint8Array(o);
}
const b64 = u8 => { let s = ''; u8.forEach(b => s += String.fromCharCode(b)); return btoa(s); };
const BT_SERVICES = [0xff00, 0xffe0, 0xfee7, 0x18f0, 0xae30, '000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', '0000ff00-0000-1000-8000-00805f9b34fb'];
let btDev = null, btChar = null;
async function btConnect(pick) {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth not available. Use Chrome on Android over HTTPS.');
  if (!pick && btChar && btDev && btDev.gatt.connected) return btChar;
  let dev = pick ? null : btDev;
  if (!dev && !pick && navigator.bluetooth.getDevices) { try { dev = (await navigator.bluetooth.getDevices()).find(d => d.id === S().btId) || null; } catch (e) {} }
  if (!dev) dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BT_SERVICES });
  const server = await dev.gatt.connect(); let found = null;
  for (const sv of await server.getPrimaryServices()) { for (const ch of await sv.getCharacteristics()) { if (ch.properties.write || ch.properties.writeWithoutResponse) { found = ch; break; } } if (found) break; }
  if (!found) { try { dev.gatt.disconnect(); } catch (e) {} throw new Error('No writable printer service found. Is this a BLE printer?'); }
  btDev = dev; btChar = found; S().btId = dev.id; S().btName = dev.name || 'Printer'; saveVault();
  dev.addEventListener('gattserverdisconnected', () => { btChar = null; });
  return found;
}
async function btWrite(bytes) {
  const go = async () => {
    const ch = await btConnect(false), size = 100;
    for (let i = 0; i < bytes.length; i += size) {
      const part = bytes.slice(i, i + size);
      ch.properties.writeWithoutResponse ? await ch.writeValueWithoutResponse(part) : await ch.writeValue(part);
      await new Promise(r => setTimeout(r, 25));
    }
  };
  try { await go(); } catch (e) { if (e.name === 'NotFoundError' || e.name === 'SecurityError') throw e; btChar = null; await go(); }
}
function sysPrint(lines) {
  $('#printArea').innerHTML = receiptHtml(lines);
  const r = $('#printArea .rcpt'); r.style.width = +S().paper === 80 ? '80mm' : '58mm'; r.style.fontSize = '12px'; window.print();
}
async function printLines(lines) {
  const m = S().method;
  try {
    if (m === 'sys') return sysPrint(lines);
    const bytes = escpos(lines, lines.some(l => l.img) ? await logoBits() : null);
    if (m === 'rawbt') { location.href = 'rawbt:base64,' + b64(bytes); return; }
    toast('Printing…'); await btWrite(bytes); toast('Printed ✓');
  } catch (e) { toast(e.name === 'NotFoundError' ? 'No printer selected' : 'Print failed: ' + (e.message || e), true); }
}
const doPrint = s => printLines(receiptLines(s));
const testSale = () => ({ no: 'TEST-0001', ts: Date.now(), cashier: { name: me.name }, items: [{ name: 'Sample item A', price: 2.5, qty: 2 }, { name: 'Sample item with a very long name B', price: 10, qty: 1 }], sub: 15, disc: 0, tax: 0, total: 15, method: 'cash', paid: 20, change: 5 });

/* ---------- INVENTORY (admin) ---------- */
let invTab = 'items', cnt = null, poF = 'all', cntQ = '', cntF = 'all', POD = null, supRet = null, cntT, RCV = null;
let custId = null, cuQ = '', cuF = 'all', cpQ = '', cuRet = null;
const digits = s => String(s || '').replace(/\D/g, '');
function stockView() {
  if (invTab === 'count' && cnt) return `<div class="page">${countScreen()}</div>`;
  const tabs = [['items', 'Items'], ['po', 'Orders'], ['recv', 'Receiving'], ['count', 'Count']];
  const act = invTab === 'items' ? `<button class="btn pri sm" data-act="newProd">${ICON.plus} Add item</button>`
    : invTab === 'po' ? `<button class="btn sm" data-act="supList">Suppliers</button><button class="btn pri sm" data-act="newPo">${ICON.plus} New PO</button>`
    : invTab === 'recv' ? `<button class="btn pri sm" data-act="rcvHome">${ICON.plus} Receive</button>`
    : `<button class="btn pri sm" data-act="newCount">${ICON.plus} New count</button>`;
  const body = invTab === 'items' ? itemsBody() : invTab === 'po' ? poBody() : invTab === 'recv' ? grnBody() : countBody();
  return `<div class="page"><div class="head"><h1>Inventory</h1>${act}</div>
    <div class="seg top">${tabs.map(([k, l]) => `<button class="${invTab === k ? 'on' : ''}" data-act="itab" data-t="${k}">${l}</button>`).join('')}</div>${body}</div>`;
}
const itemsBody = () => `<div class="stats" id="stockStats"></div>
    <div class="stack"><div class="search hasscan">${ICON.search}<input id="sq" type="search" placeholder="Search name, SKU or category" autocomplete="off" value="${esc(stockQ)}">${scanBtn('scanInv')}</div>
    <div class="chips">${[['all', 'All'], ['low', 'Low stock'], ['out', 'Out of stock']].map(([k, l]) => `<button class="chip ${stockF === k ? 'on' : ''}" data-act="sf" data-f="${k}">${l}</button>`).join('')}</div></div>
    <div class="gt" style="margin-top:16px"></div><div class="group" id="stockList"></div>`;

/* ---------- PURCHASE ORDERS + SUPPLIERS ---------- */
const POB = { draft: ['Draft', 'void'], ordered: ['Ordered', 'low'], partial: ['Partial', 'low'], received: ['Received', ''], cancelled: ['Cancelled', 'out'] };
const poBadge = s => `<span class="badge ${POB[s][1]}">${POB[s][0]}</span>`;
const poTotal = p => r2(p.items.reduce((a, i) => a + (+i.qty || 0) * (+i.cost || 0), 0));
const poOpenVal = p => r2(p.items.reduce((a, i) => a + Math.max((i.qty || 0) - (i.recv || 0), 0) * (i.cost || 0), 0));
function poBody() {
  const open = db.pos.filter(p => p.status === 'ordered' || p.status === 'partial'), month = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const list = db.pos.filter(p => poF === 'all' || (poF === 'ordered' ? p.status === 'ordered' || p.status === 'partial' : p.status === poF));
  return `<div class="stats"><div class="stat"><b>${open.length}</b><span>Waiting for delivery</span></div><div class="stat"><b>${money(open.reduce((a, p) => a + poOpenVal(p), 0))}</b><span>Open order value</span></div>
    <div class="stat"><b>${db.pos.filter(p => p.status === 'draft').length}</b><span>Drafts</span></div>
    <div class="stat"><b>${money(db.pos.filter(p => p.status === 'received' && (p.receivedTs || 0) >= month).reduce((a, p) => a + p.total, 0))}</b><span>Received this month</span></div></div>
    <div class="chips" style="margin-bottom:14px">${[['all', 'All'], ['draft', 'Drafts'], ['ordered', 'Ordered'], ['received', 'Received'], ['cancelled', 'Cancelled']].map(([k, l]) => `<button class="chip ${poF === k ? 'on' : ''}" data-act="poFilter" data-f="${k}">${l}</button>`).join('')}</div>
    <div class="group">${list.map(p => `<button class="row rowb" style="width:100%;padding:10px 16px" data-act="openPo" data-id="${p.id}"><span class="m"><b>${esc(p.no)} ${poBadge(p.status)}</b><small>${esc(p.supplierName || '—')} · ${fmtDate(p.ts)} · ${p.items.length} item${p.items.length === 1 ? '' : 's'}</small></span><span class="pr">${money(p.total ?? poTotal(p))}</span></button>`).join('')
    || '<div class="empty">No purchase orders yet.<br>Tap “New PO” to order stock from a supplier.</div>'}</div>`;
}
const suggestQty = p => Math.max((p.low || 0) * 2 - (p.stock || 0), 1);
function syncPo() { const s = $('#poSup'); if (s && POD) POD.supplierId = s.value; const n = $('#poNote'); if (n && POD) POD.note = n.value; }
function poSheet() {
  const p = POD, ed = p.status === 'draft', sup = db.suppliers.find(s => s.id === p.supplierId), live = p.status === 'ordered' || p.status === 'partial';
  const lines = ed ? p.items.map((i, n) => `<div class="pol"><span class="pn">${esc(i.name)}</span>
      <label>Qty<input class="mini" type="number" inputmode="numeric" min="0" data-poi="${n}" data-f="qty" value="${i.qty}"></label>
      <label>Cost<input class="mini" type="number" inputmode="decimal" step="any" min="0" data-poi="${n}" data-f="cost" value="${i.cost}"></label>
      <b id="plt${n}">${money(i.qty * i.cost)}</b><button class="x2" data-act="poRm" data-i="${n}" aria-label="Remove">${ICON.x}</button></div>`).join('')
    : p.items.map(i => `<div class="pol ro"><span class="pn">${esc(i.name)}<small>${i.qty} × ${money(i.cost)}${p.status !== 'cancelled' ? ` · received ${i.recv || 0}/${i.qty}` : ''}</small></span><b>${money(i.qty * i.cost)}</b></div>`).join('');
  modal(`<h2>${p.no} ${poBadge(p.status)}</h2>
    ${ed ? `<div class="group"><label class="frow"><span>Supplier</span><select id="poSup"><option value="">Choose…</option>${db.suppliers.map(s => `<option value="${s.id}" ${s.id === p.supplierId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>${BTN('supNewPo', 'New supplier')}</div>`
      : `<div class="group"><div class="frow"><span>Supplier</span><span style="margin-left:auto;text-align:right">${esc(p.supplierName || '')}${sup && sup.phone ? '<br><small style="color:var(--l2)">' + esc(sup.phone) + '</small>' : ''}</span></div><div class="frow"><span>Date</span><span style="margin-left:auto">${fmtDate(p.ts)}</span></div></div>`}
    <div class="group"><div class="polines">${lines || '<div class="empty" style="padding:18px">No items yet</div>'}</div>
      ${ed ? `<div class="frow"><span>Add item</span><input id="poAdd" list="poItems" placeholder="Type item name" autocomplete="off"><datalist id="poItems">${db.products.map(x => `<option value="${esc(x.name)}${x.sku ? ` (${esc(x.sku)})` : ''}">`).join('')}</datalist><button class="x2" style="color:var(--tint)" data-act="scanPo" aria-label="Scan">${ICON.scan}</button></div>${BTN('poLow', 'Add all low-stock items')}` : ''}</div>
    ${ed ? `<div class="group"><label class="frow"><span>Note</span><input id="poNote" value="${esc(p.note)}" placeholder="Optional"></label></div>` : p.note ? `<div class="gf">Note: ${esc(p.note)}</div>` : ''}
    <div class="change" style="background:var(--fill);color:var(--l1)"><span>Total</span><span id="poTot">${money(poTotal(p))}</span></div>
    ${ed ? `<div class="actions"><button class="btn big" data-act="poSave" data-s="draft">Save draft</button><button class="btn pri big" data-act="poSave" data-s="ordered">Mark as ordered</button></div>${p.isNew ? '' : '<button class="btn dng" data-act="poDel">Delete draft</button>'}`
      : `${live ? '<button class="btn pri big" data-act="poReceive">Receive goods</button>' : ''}<div class="actions"><button class="btn" data-act="poPrint">${ICON.print} Print</button><button class="btn" data-act="poShare">Share</button></div>${live && !p.items.some(i => i.recv) ? '<button class="btn dng" data-act="poCancel">Cancel order</button>' : ''}`}
    <button class="btn" data-act="close">Close</button>`, 'wide');
}
function newPo() { POD = { id: uid(), no: nextNo('PO-', db.pos), ts: Date.now(), supplierId: '', status: 'draft', items: [], note: '', isNew: true }; poSheet(); }
function savePo(status) {
  syncPo(); const p = POD, sup = db.suppliers.find(s => s.id === p.supplierId);
  if (!sup) return toast('Choose a supplier', true);
  p.items = p.items.filter(i => +i.qty > 0); if (!p.items.length) return toast('Add at least one item with a quantity', true);
  p.supplierName = sup.name; p.total = poTotal(p); p.status = status; p.by = me.name; if (status === 'ordered') p.orderedTs = Date.now();
  const isNew = p.isNew; delete p.isNew; const i = db.pos.findIndex(x => x.id === p.id); i >= 0 ? db.pos[i] = p : db.pos.unshift(p);
  persist('pos', p); logEv('po', `${p.no} ${status === 'ordered' ? 'ordered from' : 'saved for'} ${sup.name} (${money(p.total)})`);
  closeModal(); render(); toast(status === 'ordered' ? 'Marked as ordered' : 'Draft saved');
}
/* ---------- RECEIVING (goods received notes, with or without a PO) ---------- */
function receiveHome() {
  const open = db.pos.filter(p => p.status === 'ordered' || p.status === 'partial');
  modal(`<h2>Receive goods</h2><div class="sub">Record a delivery from a supplier</div>
    <div class="gt" style="margin:0 8px">Against a purchase order</div>
    <div class="group">${open.map(p => `<button class="row rowb" style="width:100%;padding:10px 16px" data-act="rcvPo" data-id="${p.id}"><span class="m"><b>${esc(p.no)} ${poBadge(p.status)}</b><small>${esc(p.supplierName)} · ${fmtDate(p.ts)}</small></span><span class="pr">${money(poOpenVal(p))}</span></button>`).join('')
    || '<div class="empty" style="padding:18px">No open purchase orders</div>'}</div>
    <button class="btn big" data-act="rcvDirect">Receive without a PO</button><button class="btn" data-act="close">Cancel</button>`);
}
function openReceive(po) {
  RCV = po ? { poId: po.id, poNo: po.no, supplierId: po.supplierId, supplierName: po.supplierName, invoice: '', note: '', upd: true,
      items: po.items.map(i => ({ id: i.id, name: i.name, qty: Math.max(i.qty - (i.recv || 0), 0), cost: i.cost, ord: i.qty, got: i.recv || 0 })) }
    : { poId: null, supplierId: '', invoice: '', note: '', upd: true, items: [] };
  rcvSheet();
}
function syncRcv() {
  if (!RCV) return; const g = id => $('#' + id);
  if (g('rcSup')) RCV.supplierId = g('rcSup').value; if (g('rcInv')) RCV.invoice = g('rcInv').value; if (g('rcNote')) RCV.note = g('rcNote').value; if (g('rcCost')) RCV.upd = g('rcCost').checked;
}
const rcvTotal = r => r2(r.items.reduce((a, i) => a + (+i.qty || 0) * (+i.cost || 0), 0));
function rcvSheet() {
  const r = RCV, po = !!r.poId;
  const lines = r.items.map((i, n) => `<div class="pol"><span class="pn">${esc(i.name)}${po ? `<small>Ordered ${i.ord} · received so far ${i.got}</small>` : ''}</span>
      <label>Qty<input class="mini" type="number" inputmode="numeric" min="0" data-rci="${n}" data-f="qty" value="${i.qty}"></label>
      <label>Unit cost<input class="mini" type="number" inputmode="decimal" step="any" min="0" data-rci="${n}" data-f="cost" value="${i.cost}"></label>
      <b id="rlt${n}">${money(i.qty * i.cost)}</b>${po ? '' : `<button class="x2" data-act="rcvRm" data-i="${n}" aria-label="Remove">${ICON.x}</button>`}</div>`).join('');
  modal(`<h2>${po ? 'Receive · ' + r.poNo : 'Receive goods'}</h2>${po ? `<div class="sub">${esc(r.supplierName)}</div>` : ''}
    <div class="group">${po ? '' : `<label class="frow"><span>Supplier</span><select id="rcSup"><option value="">Choose…</option>${db.suppliers.map(s => `<option value="${s.id}" ${s.id === r.supplierId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>${BTN('rcvNewSup', 'New supplier')}`}
      <label class="frow"><span>Invoice / delivery note no.</span><input id="rcInv" value="${esc(r.invoice)}" placeholder="Optional"></label></div>
    <div class="group"><div class="polines">${lines || '<div class="empty" style="padding:18px">Add the items that arrived</div>'}</div>
      ${po ? '' : `<div class="frow"><span>Add item</span><input id="rcAdd" list="rcItems" placeholder="Type item name" autocomplete="off"><datalist id="rcItems">${db.products.map(x => `<option value="${esc(x.name)}${x.sku ? ` (${esc(x.sku)})` : ''}">`).join('')}</datalist><button class="x2" style="color:var(--tint)" data-act="scanRcv" aria-label="Scan">${ICON.scan}</button></div>`}</div>
    <div class="group"><label class="frow"><span>Note</span><input id="rcNote" value="${esc(r.note)}" placeholder="Optional"></label>
      <label class="frow"><span>Update item cost prices</span><input type="checkbox" class="sw" id="rcCost" ${r.upd ? 'checked' : ''}></label></div>
    <div class="change" style="background:var(--fill);color:var(--l1)"><span>Total</span><span id="rcTot">${money(rcvTotal(r))}</span></div>
    <button class="btn pri big" data-act="rcOk">Confirm & add to stock</button><button class="btn" data-act="rcvBack">${po ? 'Back' : 'Cancel'}</button>`, 'wide');
}
function applyReceive() {
  syncRcv(); const r = RCV, sup = db.suppliers.find(s => s.id === r.supplierId);
  if (!sup && !r.poId) return toast('Choose a supplier', true);
  const items = r.items.map(i => ({ ...i, qty: Math.max(parseInt(i.qty) || 0, 0) })).filter(i => i.qty > 0); if (!items.length) return toast('Enter a quantity to receive', true);
  const po = r.poId ? db.pos.find(p => p.id === r.poId) : null, units = items.reduce((a, i) => a + i.qty, 0);
  const g = { id: uid(), no: nextNo('GRN-', db.grn), ts: Date.now(), by: me.name, poId: r.poId || '', poNo: r.poNo || '', supplierId: r.supplierId, supplierName: po ? po.supplierName : sup.name, invoice: r.invoice.trim(), note: r.note.trim(),
    items: items.map(i => ({ id: i.id, name: i.name, qty: i.qty, cost: +i.cost || 0 })), units, total: 0 };
  g.total = r2(g.items.reduce((a, i) => a + i.qty * i.cost, 0));
  g.items.forEach(i => { const p = prod(i.id); if (p) { if (p.stock !== null) setStock(p, p.stock + i.qty); if (r.upd && i.cost) { p.cost = i.cost; saveProduct(p); } } });
  if (po) {
    po.items.forEach(l => { const x = g.items.find(i => i.id === l.id); if (x) l.recv = (l.recv || 0) + x.qty; });
    po.status = po.items.every(i => (i.recv || 0) >= i.qty) ? 'received' : 'partial'; if (po.status === 'received') po.receivedTs = Date.now();
    (po.receipts = po.receipts || []).push({ ts: g.ts, by: me.name, units, grn: g.no }); persist('pos', po);
  }
  db.grn.unshift(g); persist('grn', g); logEv('grn', `${g.no}: received ${units} units from ${g.supplierName}${po ? ' (' + po.no + ')' : ''} · ${money(g.total)}`);
  RCV = null; closeModal(); render(); toast('Stock updated'); grnSheet(g);
}
function grnBody() {
  const month = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime(), m = db.grn.filter(g => g.ts >= month);
  return `<div class="stats"><div class="stat"><b>${m.length}</b><span>Deliveries this month</span></div><div class="stat"><b>${m.reduce((a, g) => a + g.units, 0)}</b><span>Units received</span></div><div class="stat"><b>${money(m.reduce((a, g) => a + g.total, 0))}</b><span>Value received</span></div>
    <div class="stat"><b>${db.pos.filter(p => p.status === 'ordered' || p.status === 'partial').length}</b><span>POs awaiting delivery</span></div></div>
    <div class="group">${db.grn.map(g => `<button class="row rowb" style="width:100%;padding:10px 16px" data-act="grnOpen" data-id="${g.id}"><span class="m"><b>${g.no}${g.poNo ? ` <span class="badge void">${g.poNo}</span>` : ''}</b><small>${esc(g.supplierName)} · ${fmtDate(g.ts)}${g.invoice ? ' · inv ' + esc(g.invoice) : ''}</small></span><span class="pr">${money(g.total)}<small style="font-weight:400;color:var(--l2)">${g.units} units</small></span></button>`).join('')
    || '<div class="empty">No deliveries recorded yet.<br>Tap “Receive” when goods arrive from a supplier.</div>'}</div>`;
}
const grnLines = g => {
  const W = width(), L = [], dash = '-'.repeat(W), add = (t, o = {}) => L.push({ t: asc(t), ...o });
  wrap(asc(S().store), W / 2 | 0).forEach(t => add(t, { a: 'c', b: 1, s: 2 })); add('GOODS RECEIVED', { a: 'c', b: 1 }); add(g.no, { a: 'c' }); add(dash);
  add(new Date(g.ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })); wrap('From: ' + asc(g.supplierName), W).forEach(t => add(t));
  if (g.poNo) add('PO: ' + g.poNo); if (g.invoice) add('Invoice: ' + asc(g.invoice)); add(dash);
  g.items.forEach(i => { wrap(asc(i.name), W).forEach(t => add(t)); add(lr(`  ${i.qty} x ${pm(i.cost)}`, pm(i.qty * i.cost), W)); });
  add(dash); add(lr('Units', g.units, W)); add(lr('TOTAL', pm(g.total), W), { b: 1 }); if (g.note) { add(dash); wrap(asc(g.note), W).forEach(t => add(t)); }
  add('='.repeat(W)); add('Received by ' + g.by, { a: 'c' }); return L;
};
function grnSheet(g) {
  modal(`<h2>${g.no}</h2><div class="sub">${esc(g.supplierName)} · ${fmtDate(g.ts)}${g.poNo ? ' · ' + g.poNo : ''}</div>
    ${g.invoice ? `<div class="gf" style="text-align:center;margin:-6px 0 0">Invoice / delivery note: ${esc(g.invoice)}</div>` : ''}
    <div class="group">${g.items.map(i => `<div class="pol ro"><span class="pn">${esc(i.name)}<small>${i.qty} × ${money(i.cost)}</small></span><b>${money(i.qty * i.cost)}</b></div>`).join('')}</div>
    <div class="change" style="background:var(--fill);color:var(--l1)"><span>${g.units} units</span><span>${money(g.total)}</span></div>
    ${g.note ? `<div class="gf">Note: ${esc(g.note)}</div>` : ''}<div class="gf" style="margin-top:-4px">Received by ${esc(g.by)}</div>
    <div class="actions"><button class="btn" data-act="grnPrint" data-id="${g.id}">${ICON.print} Print</button><button class="btn" data-act="close">Close</button></div>`, 'wide');
}
function poLines(p) {
  const W = width(), L = [], dash = '-'.repeat(W), add = (t, o = {}) => L.push({ t: asc(t), ...o });
  wrap(asc(S().store), W / 2 | 0).forEach(t => add(t, { a: 'c', b: 1, s: 2 })); add('PURCHASE ORDER', { a: 'c', b: 1 }); add(p.no, { a: 'c' }); add(dash);
  add('Date: ' + new Date(p.ts).toLocaleDateString()); wrap('To: ' + asc(p.supplierName || ''), W).forEach(t => add(t)); add(dash);
  p.items.forEach(i => { wrap(asc(i.name), W).forEach(t => add(t)); add(lr(`  ${i.qty} x ${pm(i.cost)}`, pm(i.qty * i.cost), W)); });
  add(dash); add(lr('TOTAL', pm(poTotal(p)), W), { b: 1 }); if (p.note) { add(dash); wrap(asc(p.note), W).forEach(t => add(t)); }
  add('='.repeat(W)); add('Ordered by ' + (p.by || me.name), { a: 'c' }); return L;
}
const poText = p => `Purchase Order ${p.no}\n${S().store}\nDate: ${new Date(p.ts).toLocaleDateString()}\nTo: ${p.supplierName}\n\n` + p.items.map(i => `• ${i.name}: ${i.qty} × ${money(i.cost)} = ${money(i.qty * i.cost)}`).join('\n') + `\n\nTotal: ${money(poTotal(p))}` + (p.note ? `\nNote: ${p.note}` : '');
function supList() {
  modal(`<h2>Suppliers</h2><div class="group">${db.suppliers.map(s => `<button class="row rowb" style="width:100%;padding:10px 16px" data-act="supEdit" data-id="${s.id}"><span class="m"><b>${esc(s.name)}</b><small>${esc([s.phone, s.email].filter(Boolean).join(' · ')) || '—'}</small></span><i class="chev">›</i></button>`).join('')
    || '<div class="empty" style="padding:18px">No suppliers yet</div>'}${BTN('supAdd', 'Add supplier')}</div><button class="btn" data-act="close">Close</button>`);
}
function supplierForm(id, ret) {
  const s = id ? db.suppliers.find(x => x.id === id) : { name: '', phone: '', email: '', note: '' }; supRet = ret || null;
  const f = (l, k, ex = '') => `<label class="frow"><span>${l}</span><input id="sp_${k}" value="${esc(s[k] || '')}" ${ex}></label>`;
  modal(`<h2>${id ? 'Edit supplier' : 'New supplier'}</h2><div class="group">${f('Name', 'name', 'autocomplete="off"')}${f('Phone', 'phone', 'type="tel"')}${f('Email', 'email', 'type="email"')}${f('Notes', 'note')}</div>
    <button class="btn pri big" data-act="supSave" data-id="${id || ''}">Save</button>${id ? `<button class="btn dng" data-act="supDel" data-id="${id}">Delete supplier</button>` : ''}<button class="btn" data-act="supBack">Cancel</button>`);
}
function saveSupplier(id) {
  const g = k => $('#sp_' + k).value.trim(); if (!g('name')) return toast('Enter the supplier name', true);
  if (db.suppliers.some(x => x.id !== id && x.name.toLowerCase() === g('name').toLowerCase())) return toast('Supplier already exists', true);
  let s = id ? db.suppliers.find(x => x.id === id) : null; if (!s) { s = { id: uid() }; db.suppliers.push(s); }
  Object.assign(s, { name: g('name'), phone: g('phone'), email: g('email'), note: g('note') }); persist('suppliers', s); logEv('supplier', `${id ? 'Updated' : 'Added'} supplier ${s.name}`);
  if (supRet === 'po' && POD) { POD.supplierId = s.id; poSheet(); } else if (supRet === 'rcv' && RCV) { RCV.supplierId = s.id; rcvSheet(); } else supList();
}

/* ---------- CUSTOMERS + LOYALTY ---------- */
function custView() {
  return `<div class="page"><div class="head"><h1>Customers</h1>${isAdmin() ? '<button class="btn sm" data-act="custCsv">Export</button>' : ''}<button class="btn pri sm" data-act="custNew">${ICON.plus} Add</button></div>
    <div class="stats" id="custStats"></div>
    <div class="stack"><div class="search">${ICON.search}<input id="cuq" type="search" placeholder="Search name, phone or member no." autocomplete="off" value="${esc(cuQ)}"></div>
    <div class="chips">${[['all', 'A–Z'], ['top', 'Top spenders'], ['recent', 'Recent'], ['pts', 'Most points']].map(([k, l]) => `<button class="chip ${cuF === k ? 'on' : ''}" data-act="cuf" data-f="${k}">${l}</button>`).join('')}</div></div>
    <div class="gt" style="margin-top:16px"></div><div class="group" id="custList"></div></div>`;
}
function updateCust() {
  const now = Date.now(), pts = db.customers.reduce((a, c) => a + (c.points || 0), 0);
  $('#custStats').innerHTML = `<div class="stat"><b>${db.customers.length}</b><span>Customers</span></div><div class="stat"><b>${db.customers.filter(c => c.lastVisit && now - c.lastVisit < 30 * DAY).length}</b><span>Active (30 days)</span></div>
    ${lyOn() ? `<div class="stat"><b>${pts.toLocaleString()}</b><span>Points outstanding</span></div><div class="stat"><b>${money(ptsValue(pts))}</b><span>Points value</span></div>` : ''}`;
  const k = cuQ.trim().toLowerCase(), kd = digits(k);
  let list = db.customers.filter(c => !k || c.name.toLowerCase().includes(k) || (c.no || '').toLowerCase().includes(k) || (kd.length >= 3 && digits(c.phone).includes(kd)));
  list = list.slice().sort(cuF === 'top' ? (a, b) => (b.spent || 0) - (a.spent || 0) : cuF === 'recent' ? (a, b) => (b.lastVisit || 0) - (a.lastVisit || 0) : cuF === 'pts' ? (a, b) => b.points - a.points : (a, b) => a.name.localeCompare(b.name));
  $('#custList').innerHTML = list.map(c => custRowHtml(c, 'custOpen')).join('') || '<div class="empty">No customers yet.<br>Add customers to track purchases and loyalty points.</div>';
}
const custRowHtml = (c, act) => `<button class="row rowb" style="width:100%;padding:10px 16px" data-act="${act}" data-id="${c.id}">${avatar(null)}<span class="m"><b>${esc(c.name)}</b><small>${esc([c.phone, (c.visits || 0) + ' visit' + (c.visits === 1 ? '' : 's')].filter(Boolean).join(' · '))}</small></span>
  <span class="pr">${lyOn() ? c.points + ' pts' : money(c.spent || 0)}${lyOn() ? `<small style="font-weight:400;color:var(--l2)">${money(c.spent || 0)}</small>` : ''}</span></button>`;
function custSheet(id) {
  const c = cust(id); if (!c) return closeModal();
  const sales = db.sales.filter(s => s.customerId === id).slice(0, 8).map(s => ({ ts: s.ts, t: `${s.no}${s.void ? ' (void)' : ''}`, r: `${s.pts ? (s.pts.earned ? '+' + s.pts.earned : '') + (s.pts.used ? ' −' + s.pts.used : '') + ' pts · ' : ''}${money(s.total)}` }));
  const adj = (c.adj || []).map(a => ({ ts: a.ts, t: `Adjustment${a.reason ? ': ' + esc(a.reason) : ''} · ${esc(a.by)}`, r: (a.delta > 0 ? '+' : '') + a.delta + ' pts' }));
  const hist = [...sales, ...adj].sort((a, b) => b.ts - a.ts).slice(0, 10);
  const row = (l, v) => v ? `<div class="frow"><span>${l}</span><span style="margin-left:auto;text-align:right;color:var(--l2)">${esc(v)}</span></div>` : '';
  modal(`<h2>${esc(c.name)}</h2><div class="sub">${esc(c.no)} · member since ${new Date(c.created).toLocaleDateString()}</div>
    <div class="stats" style="margin:0">${lyOn() ? `<div class="stat"><b>${c.points}</b><span>Points (${money(ptsValue(c.points))})</span></div>` : ''}<div class="stat"><b>${c.visits || 0}</b><span>Visits</span></div><div class="stat"><b>${money(c.spent || 0)}</b><span>Total spent</span></div>
      <div class="stat"><b>${money(c.visits ? c.spent / c.visits : 0)}</b><span>Avg visit</span></div></div>
    ${row('Phone', c.phone)}${row('Email', c.email)}${row('Birthday', c.birthday)}${row('Note', c.note)}
    ${hist.length ? `<div class="gt" style="margin:0 8px">Recent activity</div><div class="group">${hist.map(h => `<div class="leg" style="padding:9px 16px"><span>${h.t}<br><small>${fmtDate(h.ts)}</small></span><b style="font-size:14px">${h.r}</b></div>`).join('')}</div>` : ''}
    <button class="btn pri big" data-act="custSelect" data-id="${id}">Use for current sale</button>
    ${isAdmin() ? `<div class="actions"><button class="btn" data-act="custEdit" data-id="${id}">Edit</button>${lyOn() ? `<button class="btn" data-act="custAdj" data-id="${id}">Adjust points</button>` : '<span></span>'}</div><button class="btn dng" data-act="custDel" data-id="${id}">Delete customer</button>` : ''}
    <button class="btn" data-act="close">Close</button>`);
}
function customerForm(id, ret) {
  const c = id ? cust(id) : { name: '', phone: '', email: '', birthday: '', note: '' }; cuRet = ret || null;
  const pre = !id && ret === 'pick' && cpQ.trim() ? (digits(cpQ).length >= 6 ? { phone: cpQ.trim() } : { name: cpQ.trim() }) : {};
  const f = (l, k, ex = '') => `<label class="frow"><span>${l}</span><input id="cu_${k}" value="${esc(pre[k] ?? c[k] ?? '')}" ${ex}></label>`;
  modal(`<h2>${id ? 'Edit customer' : 'New customer'}</h2><div class="group">${f('Name', 'name', 'autocomplete="off"')}${f('Phone', 'phone', 'type="tel" inputmode="tel"')}${f('Email', 'email', 'type="email"')}${f('Birthday', 'birthday', 'type="date"')}${f('Note', 'note')}</div>
    <button class="btn pri big" data-act="custSave" data-id="${id || ''}">Save</button><button class="btn" data-act="custFormBack" data-id="${id || ''}">Cancel</button>`);
}
function saveCustomer(id) {
  if (id && !isAdmin()) return toast('Administrator only', true);
  const g = k => $('#cu_' + k).value.trim(); if (!g('name')) return toast('Enter the customer name', true);
  const ph = digits(g('phone')), dup = ph.length >= 6 && db.customers.find(x => x.id !== id && digits(x.phone) === ph); if (dup) return toast(`Phone already registered to ${dup.name}`, true);
  let c = id ? cust(id) : null;
  if (!c) { c = { id: uid(), no: nextNo('C-', db.customers), points: 0, spent: 0, visits: 0, created: Date.now(), adj: [] }; c.ts = c.created; db.customers.push(c); logEv('customer', `Added customer ${g('name')}`); }
  Object.assign(c, { name: g('name'), phone: g('phone'), email: g('email'), birthday: g('birthday'), note: g('note') }); persist('customers', c);
  if (cuRet === 'pick') { custId = c.id; closeModal(); updateCart(); toast(`Customer: ${c.name}`); } else { closeModal(); render(); custSheet(c.id); }
}
function adjSheet(id) {
  const c = cust(id);
  modal(`<h2>Adjust points</h2><div class="sub">${esc(c.name)} · ${c.points} points</div><div class="group"><label class="frow"><span>Change (+ / −)</span><input id="adjN" type="number" inputmode="numeric" placeholder="e.g. 50 or -20"></label>
    <label class="frow"><span>Reason</span><input id="adjR" placeholder="e.g. birthday bonus"></label></div><button class="btn pri big" data-act="custAdjOk" data-id="${id}">Apply</button><button class="btn" data-act="custBack" data-id="${id}">Cancel</button>`);
}
function custPicker() {
  cpQ = '';
  modal(`<h2>Customer</h2><div class="search">${ICON.search}<input id="cpq" type="search" placeholder="Search name, phone or member no." autocomplete="off"></div>
    <div class="group" id="cpList" style="max-height:42dvh;overflow:auto"></div><button class="btn pri" data-act="cpNew">${ICON.plus} New customer</button>
    ${custId ? '<button class="btn dng" data-act="custClear">Remove from order</button>' : ''}<button class="btn" data-act="close">Cancel</button>`);
  updateCp(); setTimeout(() => { const i = $('#cpq'); i && i.focus(); }, 80);
}
function updateCp() {
  const k = cpQ.trim().toLowerCase(), kd = digits(k);
  const list = db.customers.filter(c => !k || c.name.toLowerCase().includes(k) || (c.no || '').toLowerCase().includes(k) || (kd.length >= 3 && digits(c.phone).includes(kd))).sort((a, b) => (b.lastVisit || b.created) - (a.lastVisit || a.created)).slice(0, 30);
  $('#cpList').innerHTML = list.map(c => custRowHtml(c, 'cpSelect')).join('') || `<div class="empty" style="padding:18px">${db.customers.length ? 'No match' : 'No customers yet'}</div>`;
}
function customersCsv() {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`, rows = [['No', 'Name', 'Phone', 'Email', 'Birthday', 'Points', 'Visits', 'Total spent', 'Last visit', 'Member since', 'Note']];
  db.customers.forEach(c => rows.push([c.no, c.name, c.phone, c.email, c.birthday, c.points, c.visits || 0, c.spent || 0, c.lastVisit ? new Date(c.lastVisit).toISOString() : '', new Date(c.created).toISOString(), c.note]));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }));
  a.download = `epos-customers-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); logEv('export', 'Exported customer list CSV');
}

/* ---------- STOCK OPNAME (stock count) ---------- */
const cntSummary = c => { let diffItems = 0, net = 0, val = 0, counted = 0; c.lines.forEach(l => { if (l.counted === null) return; counted++; const d = l.counted - l.sys; if (d) { diffItems++; net += d; val += d * l.cost; } }); return { counted, total: c.lines.length, unc: c.lines.length - counted, diffItems, net, val: r2(val) }; };
function countBody() {
  const done = db.counts.filter(c => c.status === 'applied'), last = done[0];
  return `<div class="stats"><div class="stat"><b>${db.counts.filter(c => c.status === 'draft').length}</b><span>In progress</span></div><div class="stat"><b>${last ? new Date(last.appliedTs).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '—'}</b><span>Last count</span></div>
    <div class="stat"><b>${last ? (last.summary.val >= 0 ? '+' : '−') + money(Math.abs(last.summary.val)) : '—'}</b><span>Last variance (cost)</span></div></div>
    <div class="group">${db.counts.map(c => { const s = c.status === 'applied' ? c.summary : cntSummary(c); return `<button class="row rowb" style="width:100%;padding:10px 16px" data-act="cntOpen" data-id="${c.id}"><span class="m"><b>${c.no} <span class="badge ${c.status === 'applied' ? '' : 'low'}">${c.status === 'applied' ? 'Applied' : 'In progress'}</span></b>
      <small>${esc(c.scope)} · ${fmtDate(c.ts)} · ${esc(c.by)} · ${s.counted}/${s.total} counted</small></span>
      <span class="pr">${c.status === 'applied' ? `${s.net > 0 ? '+' : ''}${s.net} units<small style="font-weight:400;color:var(--l2)">${s.diffItems} differences</small>` : 'Continue'}</span></button>`; }).join('')
    || '<div class="empty">No stock counts yet.<br>A stock count (opname) compares what is on the shelf with the system and corrects the difference.</div>'}</div>`;
}
function newCountSheet() {
  const cats = [...new Set(db.products.filter(p => p.stock !== null).map(p => p.cat).filter(Boolean))];
  modal(`<h2>New stock count</h2><div class="sub">Count what is physically on the shelves.</div>
    <div class="group"><label class="frow"><span>Scope</span><select id="ncScope"><option value="*">All tracked items</option>${cats.map(c => `<option value="${esc(c)}">${esc(c)} only</option>`).join('')}</select></label>
    <label class="frow"><span>Blind count (hide system qty)</span><input type="checkbox" class="sw" id="ncBlind" checked></label></div>
    <div class="gf">Blind counting avoids bias: staff count first, differences are shown when you finish. Sales made during the count are respected.</div>
    <button class="btn pri big" data-act="startCount">Start counting</button><button class="btn" data-act="close">Cancel</button>`);
}
function startCount() {
  const scope = $('#ncScope').value, items = db.products.filter(p => p.stock !== null && (scope === '*' || p.cat === scope));
  if (!items.length) return toast('No tracked items to count', true);
  cnt = { id: uid(), no: nextNo('CNT-', db.counts), ts: Date.now(), by: me.name, status: 'draft', blind: $('#ncBlind').checked, scope: scope === '*' ? 'All items' : scope,
    lines: items.map(p => ({ id: p.id, name: p.name, sku: p.sku || '', sys: p.stock, counted: null, cost: p.cost || 0 })).sort((a, b) => a.name.localeCompare(b.name)) };
  db.counts.unshift(cnt); persist('counts', cnt); logEv('count', `Started ${cnt.no} (${cnt.scope})`); closeModal(); cntQ = ''; cntF = 'all'; render();
}
function countScreen() {
  return `<div class="head"><button class="btn sm" data-act="cntExit">‹ Counts</button><h1 style="font-size:24px">${cnt.no} <small style="font-size:14px;color:var(--l2);font-weight:400">${esc(cnt.scope)}${cnt.blind ? ' · blind' : ''}</small></h1><button class="btn sm" data-act="scanCount">${ICON.scan} Scan</button><button class="btn pri sm" data-act="cntFinish">Finish & apply</button></div>
    <div class="card" style="padding:12px 16px;margin-bottom:12px"><div class="hbt"><span id="cntProg"></span><span id="cntPct"></span></div><div class="trk"><i id="cntBar" style="background:var(--tint)"></i></div></div>
    <div class="stack"><div class="search">${ICON.search}<input id="cq" type="search" placeholder="Search item or scan barcode" autocomplete="off" value="${esc(cntQ)}"></div>
    <div class="chips">${[['all', 'All'], ['unc', 'Uncounted'], ...(cnt.blind ? [] : [['diff', 'Differences']])].map(([k, l]) => `<button class="chip ${cntF === k ? 'on' : ''}" data-act="cntFilter" data-f="${k}">${l}</button>`).join('')}</div></div>
    <div class="gt" style="margin-top:14px"></div><div class="group" id="cntList"></div>
    <div class="actions" style="margin-top:16px"><button class="btn" data-act="cntMatch">Mark remaining as matching</button><button class="btn dng" data-act="cntDiscard">Discard count</button></div>`;
}
const vchip = l => l.counted === null ? '' : (d => d === 0 ? '<span class="badge">✓</span>' : `<span class="badge ${d < 0 ? 'out' : 'low'}">${d > 0 ? '+' : ''}${d}</span>`)(l.counted - l.sys);
function updateCount() {
  const k = cntQ.trim().toLowerCase(), rows = [];
  cnt.lines.forEach((l, i) => { if ((!k || l.name.toLowerCase().includes(k) || (l.sku || '').toLowerCase().includes(k)) && (cntF === 'all' || (cntF === 'unc' && l.counted === null) || (cntF === 'diff' && l.counted !== null && l.counted !== l.sys))) rows.push([l, i]); });
  $('#cntList').innerHTML = rows.map(([l, i]) => `<div class="row"><span class="m"><b>${esc(l.name)}</b><small>${esc(l.sku || '')}${!cnt.blind ? `${l.sku ? ' · ' : ''}System ${l.sys}` : ''}</small></span>
    ${!cnt.blind ? `<span id="cv${i}">${vchip(l)}</span>` : ''}<input class="mini cin" type="number" inputmode="numeric" min="0" data-ci="${i}" value="${l.counted ?? ''}" placeholder="—"><button class="btn sm" data-act="cntSame" data-i="${i}" aria-label="Matches system">✓</button></div>`).join('') || '<div class="empty">Nothing to show</div>';
  cntProgress();
}
function cntProgress() { const s = cntSummary(cnt); $('#cntProg').textContent = `${s.counted} of ${s.total} counted`; $('#cntPct').textContent = Math.round(s.counted / s.total * 100) + '%'; $('#cntBar').style.width = (s.counted / s.total * 100) + '%'; }
function cntSave() { clearTimeout(cntT); cntT = setTimeout(() => cnt && persist('counts', cnt), 700); }
function cntSetCounted(i, v) { const l = cnt.lines[i]; l.counted = v; const el = $('#cv' + i); if (el) el.innerHTML = vchip(l); cntProgress(); cntSave(); }
function finishSheet() {
  const s = cntSummary(cnt), diffs = cnt.lines.filter(l => l.counted !== null && l.counted !== l.sys);
  modal(`<h2>Finish ${cnt.no}</h2><div class="stats" style="margin:0"><div class="stat"><b>${s.counted}/${s.total}</b><span>Counted</span></div><div class="stat"><b>${s.diffItems}</b><span>Differences</span></div>
    <div class="stat"><b>${s.net > 0 ? '+' : ''}${s.net}</b><span>Net units</span></div><div class="stat"><b>${s.val >= 0 ? '+' : '−'}${money(Math.abs(s.val))}</b><span>Value (cost)</span></div></div>
    ${s.unc ? `<div class="gf" style="color:var(--orange)">${s.unc} item${s.unc > 1 ? 's were' : ' was'} not counted and will stay unchanged.</div>` : ''}
    ${diffs.length ? `<div class="group" style="max-height:34dvh;overflow:auto">${diffs.map(l => `<div class="leg" style="padding:9px 16px"><span>${esc(l.name)}<br><small>${l.sys} → ${l.counted}</small></span><span class="badge ${l.counted < l.sys ? 'out' : 'low'}">${l.counted > l.sys ? '+' : ''}${l.counted - l.sys}</span></div>`).join('')}</div>` : '<div class="gf">No differences — stock matches the system.</div>'}
    <button class="btn pri big" data-act="cntApply">Apply adjustments</button><button class="btn" data-act="close">Keep counting</button>`, 'wide');
}
function applyCount() {
  const c = cnt, sm = cntSummary(c);
  c.lines.forEach(l => {
    if (l.counted === null) return; const d = l.counted - l.sys; if (!d) return; const p = prod(l.id); if (!p || p.stock === null) return;
    const before = p.stock; setStock(p, Math.max(0, p.stock + d)); logEv('count', `${c.no} ${p.name}: ${before} → ${p.stock} (${d > 0 ? '+' : ''}${d})`);
  });
  c.status = 'applied'; c.appliedTs = Date.now(); c.summary = sm; clearTimeout(cntT);
  persist('counts', c); logEv('count', `Applied ${c.no}: ${sm.diffItems} differences, ${sm.net > 0 ? '+' : ''}${sm.net} units, ${money(sm.val)}`);
  cnt = null; closeModal(); render(); toast('Stock updated');
}
function countReport(c) {
  const s = c.summary, diffs = c.lines.filter(l => l.counted !== null && l.counted !== l.sys);
  modal(`<h2>${c.no}</h2><div class="sub">${esc(c.scope)} · ${fmtDate(c.appliedTs)} · ${esc(c.by)}</div>
    <div class="stats" style="margin:0"><div class="stat"><b>${s.counted}/${s.total}</b><span>Counted</span></div><div class="stat"><b>${s.diffItems}</b><span>Differences</span></div><div class="stat"><b>${s.net > 0 ? '+' : ''}${s.net}</b><span>Net units</span></div><div class="stat"><b>${s.val >= 0 ? '+' : '−'}${money(Math.abs(s.val))}</b><span>Value (cost)</span></div></div>
    ${diffs.length ? `<div class="group">${diffs.map(l => `<div class="leg" style="padding:9px 16px"><span>${esc(l.name)}<br><small>system ${l.sys} → counted ${l.counted}</small></span><span class="badge ${l.counted < l.sys ? 'out' : 'low'}">${l.counted > l.sys ? '+' : ''}${l.counted - l.sys}</span></div>`).join('')}</div>` : '<div class="gf">No differences were found.</div>'}
    <button class="btn" data-act="close">Close</button>`, 'wide');
}
function updateStock() {
  const tr = db.products.filter(p => p.stock !== null);
  $('#stockStats').innerHTML = `<div class="stat"><b>${db.products.length}</b><span>Items</span></div><div class="stat"><b>${tr.filter(p => p.stock <= p.low && p.stock > 0).length}</b><span>Low stock</span></div>
    <div class="stat"><b>${tr.filter(p => p.stock <= 0).length}</b><span>Out of stock</span></div><div class="stat"><b>${money(tr.reduce((a, p) => a + p.stock * (p.cost || 0), 0))}</b><span>Stock value (cost)</span></div>`;
  const k = stockQ.trim().toLowerCase();
  const list = db.products.filter(p => (!k || [p.name, p.sku, p.cat].some(x => (x || '').toLowerCase().includes(k))) && (stockF === 'all' || (p.stock !== null && (stockF === 'out' ? p.stock <= 0 : p.stock <= p.low))));
  $('#stockList').innerHTML = list.map(p => `<div class="row"><button class="rowb" data-act="edit" data-id="${p.id}"><span class="pi" style="background:${hue(p.cat || p.name)}">${picHtml(p)}</span>
      <span class="m"><b>${esc(p.name)}</b><small>${esc([p.sku, p.cat].filter(Boolean).join(' · ')) || '—'}</small></span></button>
      <span class="pr">${money(p.price)}${stockBadge(p) || '<small style="font-weight:400;color:var(--l2)">not tracked</small>'}</span>
      ${p.stock !== null ? `<div class="step"><button data-act="sadj" data-id="${p.id}" data-d="-1">−</button><button data-act="sadj" data-id="${p.id}" data-d="1">+</button></div>` : ''}</div>`).join('')
    || '<div class="empty">No items</div>';
}
function productForm(p) {
  const n = !p; p = p || { name: '', sku: '', cat: '', price: '', cost: '', stock: 0, low: 5, icon: '' };
  const R = (l, h) => `<label class="frow"><span>${l}</span>${h}</label>`, inp = (id, v, ex = '') => `<input id="${id}" value="${esc(v)}" ${ex}>`;
  imgDraft = p.img || null;
  modal(`<h2>${n ? 'New item' : 'Edit item'}</h2>
    <div class="photo"><span class="pim" id="pPrev" style="background:${hue(p.cat || p.name || 'x')}">${picHtml(p)}</span>
      <div class="stack"><button class="btn sm" data-act="pickImg">${ICON.plus} Take / choose photo</button><button class="btn sm dng" data-act="rmImg">Remove photo</button></div></div>
    <div class="group">${R('Name', inp('fName', p.name, 'autocomplete="off"'))}${R('Icon (emoji)', inp('fIcon', p.icon || '', 'maxlength="4" placeholder="optional"'))}
    ${R('Category', inp('fCat', p.cat, 'list="cats" autocomplete="off"') + `<datalist id="cats">${[...new Set(db.products.map(x => x.cat).filter(Boolean))].map(c => `<option value="${esc(c)}">`).join('')}</datalist>`)}
    ${R('SKU / barcode', inp('fSku', p.sku, 'autocomplete="off"') + `<button class="x2" style="color:var(--tint)" data-act="scanSku" aria-label="Scan">${ICON.scan}</button>`)}</div>
    <div class="group">${R('Price', inp('fPrice', p.price, 'type="number" inputmode="decimal" step="any"'))}${R('Cost', inp('fCost', p.cost, 'type="number" inputmode="decimal" step="any" placeholder="optional"'))}</div>
    <div class="group">${R('Stock', inp('fStock', p.stock === null ? '' : p.stock, 'type="number" inputmode="numeric" placeholder="not tracked"'))}${R('Low-stock alert at', inp('fLow', p.low, 'type="number" inputmode="numeric"'))}</div>
    <button class="btn pri big" data-act="saveProd" data-id="${n ? '' : p.id}">Save</button>
    ${n ? '' : `<button class="btn dng" data-act="delProd" data-id="${p.id}">Delete item</button>`}<button class="btn" data-act="close">Cancel</button>`);
}
function saveProd(id) {
  const g = i => $('#' + i).value.trim();
  if (!g('fName')) return toast('Name is required', true);
  if (g('fPrice') === '' || +g('fPrice') < 0) return toast('Enter a valid price', true);
  const sku = g('fSku'); if (sku && db.products.some(x => x.sku === sku && x.id !== id)) return toast('SKU already used by another item', true);
  const d = { name: g('fName'), icon: g('fIcon'), img: imgDraft, sku, cat: g('fCat'), price: +g('fPrice'), cost: +g('fCost') || 0, stock: g('fStock') === '' ? null : Math.max(0, parseInt(g('fStock'))), low: parseInt(g('fLow')) || 0 };
  let p;
  if (id) { p = prod(id); if (p.price !== d.price) logEv('price', `${p.name}: price ${money(p.price)} → ${money(d.price)}`); if (p.stock !== d.stock) logEv('stock', `${p.name}: stock ${p.stock ?? '–'} → ${d.stock ?? '–'}`); const ns = d.stock; delete d.stock; Object.assign(p, d); if (ns === null) p.stock = null; else { if (p.stock === null) p.stock = db.moves.filter(m => m.pid === p.id).reduce((a, m) => a + m.d, 0); setStock(p, ns); } }
  else { const ns = d.stock; d.stock = ns === null ? null : 0; p = { id: uid(), ...d }; db.products.push(p); if (ns) setStock(p, ns); logEv('item', `Added item ${p.name}`); }
  saveProduct(p); closeModal(); render(); toast('Saved');
}

/* ---------- ANALYTICS (dashboard + reports) ---------- */
const DAY = 864e5, PER = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['month', 'This month'], ['all', 'All time']];
let dashP = '7d';
function rangeFor(p) {
  const now = Date.now(), sod = startOfDay(), d = new Date(); let from, label = (PER.find(x => x[0] === p) || [])[1];
  if (p === 'today') from = sod; else if (p === '7d') from = sod - 6 * DAY; else if (p === '30d') from = sod - 29 * DAY;
  else if (p === 'month') from = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); else from = 0;
  const len = now - from, pf = p === 'all' ? null : p === 'today' ? sod - DAY : from - len;
  return { p, from, to: now, pf, pt: p === 'all' ? null : p === 'today' ? sod - DAY + len : from, label: p === 'today' ? 'Today' : p === '7d' ? 'Last 7 days' : p === '30d' ? 'Last 30 days' : label };
}
const inRange = (a, b) => db.sales.filter(s => s.ts >= a && s.ts <= b);
function agg(list) {
  const a = { cust: {}, memberSales: 0, pts: 0, rev: 0, orders: 0, items: 0, disc: 0, tax: 0, profit: 0, voids: 0, voidAmt: 0, pay: {}, prod: {}, cat: {}, cashier: {}, hour: Array(24).fill(0) };
  list.forEach(s => {
    if (s.void) { a.voids++; a.voidAmt += s.total; return; }
    const dd = (s.disc || 0) + (s.redeem || 0);
    a.rev += s.total; a.orders++; a.disc += dd; a.tax += s.tax || 0; a.profit -= dd;
    if (s.customerName) { a.cust[s.customerName] = a.cust[s.customerName] || { n: 0, v: 0 }; a.cust[s.customerName].n++; a.cust[s.customerName].v += s.total; a.memberSales += s.total; a.pts += (s.pts ? s.pts.earned : 0); }
    a.pay[s.method] = (a.pay[s.method] || 0) + s.total; a.hour[new Date(s.ts).getHours()]++;
    const c = s.cashier ? s.cashier.name : 'Unknown'; a.cashier[c] = a.cashier[c] || { n: 0, v: 0 }; a.cashier[c].n++; a.cashier[c].v += s.total;
    s.items.forEach(i => {
      const p = prod(i.id), cost = i.cost ?? (p ? p.cost : 0) ?? 0, line = i.price * i.qty;
      a.items += i.qty; a.profit += (i.price - cost) * i.qty;
      const k = i.id || i.name; a.prod[k] = a.prod[k] || { name: i.name, qty: 0, rev: 0 }; a.prod[k].qty += i.qty; a.prod[k].rev += line;
      const ct = (p && p.cat) || 'Other'; a.cat[ct] = (a.cat[ct] || 0) + line;
    });
  });
  return a;
}
const delta = (c, p) => p == null ? '' : !p ? (c ? '<span class="delta up">new</span>' : '') : (d => `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%</span>`)((c - p) / p * 100);
const compact = v => S().cur + (v >= 10000 ? (v / 1000).toFixed(0) + 'k' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(v % 1 ? (+S().dec ? 1 : 0) : 0));
const hLabel = h => h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p';
function trend(list, R) {
  const ok = list.filter(s => !s.void), hourly = R.p === 'today';
  const from = R.p === 'all' ? (ok.length ? Math.min(...ok.map(s => s.ts)) : R.to) : R.from, monthly = !hourly && (R.to - from) / DAY > 62, B = [], idx = {};
  const dk = ts => new Date(ts).toLocaleDateString('en-CA');
  if (hourly) for (let h = 0; h < 24; h++) { idx[h] = B.push({ v: 0, label: h % 3 === 0 ? hLabel(h) : '', tip: hLabel(h) }) - 1; }
  else if (monthly) { const d = new Date(from); d.setDate(1); for (; d.getTime() <= R.to; d.setMonth(d.getMonth() + 1)) idx[dk(d).slice(0, 7)] = B.push({ v: 0, label: d.toLocaleDateString([], { month: 'short' }), tip: d.toLocaleDateString([], { month: 'long', year: 'numeric' }) }) - 1; }
  else { const n = Math.round((startOfDay(new Date(R.to)) - startOfDay(new Date(from))) / DAY) + 1; for (let i = 0; i < n; i++) { const d = new Date(startOfDay(new Date(from))); d.setDate(d.getDate() + i); idx[dk(d)] = B.push({ v: 0, label: n <= 7 ? d.toLocaleDateString([], { weekday: 'short' }) : (d.getDate() === 1 || i % 5 === 0 ? d.getDate() : ''), tip: d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) }) - 1; } }
  ok.forEach(s => { const k = hourly ? new Date(s.ts).getHours() : monthly ? dk(s.ts).slice(0, 7) : dk(s.ts); if (idx[k] !== undefined) B[idx[k]].v += s.total; });
  return B;
}
function barChart(B, fmt) {
  const W = 640, H = 190, pl = 6, pr = 6, pt = 18, pb = 22, n = B.length, max = Math.max(...B.map(x => x.v), 0) || 1, bw = (W - pl - pr) / n, w = Math.max(Math.min(bw * 0.62, 34), 2);
  const y = v => pt + (H - pt - pb) * (1 - v / max), mi = B.findIndex(x => x.v === max && max > 0);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">` + [0, .5, 1].map(f => `<line x1="0" x2="${W}" y1="${y(max * f)}" y2="${y(max * f)}"/>`).join('');
  B.forEach((b, i) => {
    const x = pl + i * bw + (bw - w) / 2, yy = y(b.v), h = Math.max(H - pb - yy, b.v > 0 ? 2 : 0);
    s += `<rect class="bar ${i === mi ? 'top' : ''}" x="${x}" y="${H - pb - h}" width="${w}" height="${h}" rx="${Math.min(w / 2, 5)}"><title>${esc(b.tip)}: ${fmt(b.v)}</title></rect>`;
    if (b.label !== '') s += `<text x="${pl + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  if (mi >= 0) s += `<text class="mx" x="${Math.min(Math.max(pl + mi * bw + bw / 2, 24), W - 24)}" y="${y(max) - 5}" text-anchor="middle">${fmt(max)}</text>`;
  return s + '</svg>';
}
const hbars = (rows, color = 'var(--tint)') => { const mx = Math.max(...rows.map(r => r.val), 0) || 1; return rows.length ? rows.map(r => `<div class="hb"><div class="hbt"><span>${esc(r.label)}</span><b>${r.text}</b></div><div class="trk"><i style="width:${Math.max(r.val / mx * 100, 2)}%;background:${r.color || color}"></i></div>${r.sub ? `<small>${r.sub}</small>` : ''}</div>`).join('') : '<div class="empty" style="padding:18px">No data yet</div>'; };
const PAYC = { cash: '#34c759', card: '#007aff', other: '#ff9500' }, PAYN = { cash: 'Cash', card: 'Card', other: 'E-wallet' };

function dashView() {
  const R = rangeFor(dashP), list = inRange(R.from, R.to), a = agg(list), pa = R.pf == null ? null : agg(inRange(R.pf, R.pt)), B = trend(list, R);
  const pv = k => pa ? pa[k] : null, avg = a.orders ? a.rev / a.orders : 0, pavg = pa && pa.orders ? pa.rev / pa.orders : pa ? 0 : null;
  const kpi = (label, val, d, sub) => `<div class="card kpi"><span>${label}</span><b>${val}</b><div>${d || ''}${sub ? `<small>${sub}</small>` : ''}</div></div>`;
  const tops = Object.values(a.prod).sort((x, y) => y.rev - x.rev).slice(0, 8);
  const cats = Object.entries(a.cat).sort((x, y) => y[1] - x[1]);
  const pay = Object.entries(a.pay).sort((x, y) => y[1] - x[1]), payTot = pay.reduce((s, x) => s + x[1], 0) || 1;
  const cash = Object.entries(a.cashier).sort((x, y) => y[1].v - x[1].v);
  const low = db.products.filter(p => p.stock !== null && p.stock <= p.low).sort((x, y) => x.stock - y.stock).slice(0, 7);
  const hb = a.hour.map((v, h) => ({ v, label: h % 3 === 0 ? hLabel(h) : '', tip: hLabel(h) + '–' + hLabel((h + 1) % 24) })), busiest = a.hour.indexOf(Math.max(...a.hour));
  const margin = a.rev - a.tax > 0 ? Math.round(a.profit / (a.rev - a.tax) * 100) : 0;
  return `<div class="page wide">${cloudBanner()}<div class="head"><h1>Dashboard</h1><button class="btn sm" data-act="repPrint">${ICON.print} Print report</button><button class="btn sm" data-act="repCsv">Export CSV</button></div>
    <div class="chips" style="margin-bottom:14px">${PER.map(([k, l]) => `<button class="chip ${dashP === k ? 'on' : ''}" data-act="dp" data-p="${k}">${l}</button>`).join('')}</div>
    <div class="kpis">
      ${kpi('Revenue', money(a.rev), delta(a.rev, pv('rev')), pa ? 'vs previous' : '')}
      ${kpi('Orders', a.orders, delta(a.orders, pv('orders')))}
      ${kpi('Average order', money(avg), delta(avg, pavg))}
      ${kpi('Items sold', a.items, delta(a.items, pv('items')))}
      ${kpi('Est. profit', money(a.profit), delta(a.profit, pv('profit')), a.rev ? margin + '% margin' : '')}
      ${kpi('Discounts given', money(a.disc), '', a.voids ? `${a.voids} void${a.voids > 1 ? 's' : ''} (${money(a.voidAmt)})` : '')}
    </div>
    <div class="card" style="margin-top:12px"><h3>${R.p === 'today' ? 'Revenue by hour' : 'Revenue trend'}</h3>${a.orders ? barChart(B, money) : '<div class="empty" style="padding:30px">No sales in this period</div>'}</div>
    <div class="dgrid">
      <div class="card"><h3>Top products</h3>${hbars(tops.map(t => ({ label: t.name, val: t.rev, text: money(t.rev), sub: t.qty + ' sold' })))}</div>
      <div class="card"><h3>Sales by category</h3>${hbars(cats.map(([c, v], i) => ({ label: c, val: v, text: money(v), color: PALETTE[i % PALETTE.length] })))}</div>
      <div class="card"><h3>Payment methods</h3>${pay.length ? `<div class="split">${pay.map(([m, v]) => `<i style="width:${v / payTot * 100}%;background:${PAYC[m] || '#8e8e93'}"></i>`).join('')}</div>
        ${pay.map(([m, v]) => `<div class="leg"><span><u style="background:${PAYC[m] || '#8e8e93'}"></u>${PAYN[m] || esc(m)}</span><b>${money(v)} <small>${Math.round(v / payTot * 100)}%</small></b></div>`).join('')}` : '<div class="empty" style="padding:18px">No data yet</div>'}</div>
      <div class="card"><h3>Top customers</h3>${hbars(Object.entries(a.cust).sort((x, y) => y[1].v - x[1].v).slice(0, 6).map(([n, o]) => ({ label: n, val: o.v, text: money(o.v), sub: o.n + ' visit' + (o.n > 1 ? 's' : '') })), '#ff9500')}
        ${a.orders ? `<div class="gf" style="margin:10px 0 0">Members: ${Math.round(a.memberSales / (a.rev || 1) * 100)}% of sales${lyOn() ? ` · ${a.pts} points issued` : ''}</div>` : ''}</div>
      <div class="card"><h3>Staff performance</h3>${hbars(cash.map(([n, o]) => ({ label: n, val: o.v, text: money(o.v), sub: o.n + ' orders · avg ' + money(o.v / o.n) })), '#5856d6')}</div>
      <div class="card"><h3>Busiest hours</h3>${a.orders ? barChart(hb, v => v + ' orders') : '<div class="empty" style="padding:18px">No data yet</div>'}${a.orders ? `<div class="gf" style="margin:6px 0 0">Peak time: ${hLabel(busiest)}–${hLabel((busiest + 1) % 24)}</div>` : ''}</div>
      <div class="card"><h3>Stock alerts</h3>${low.length ? low.map(p => `<div class="leg"><span>${esc(p.name)}</span>${stockBadge(p)}</div>`).join('') + '<button class="btn sm" style="margin-top:12px" data-act="nav" data-v="stock">Open inventory</button>' : '<div class="empty" style="padding:18px">All items are well stocked ✓</div>'}</div>
    </div></div>`;
}
function reportLines(R) {
  const a = agg(inRange(R.from, R.to)), W = width(), L = [], dash = '-'.repeat(W), add = (t, o = {}) => L.push({ t: asc(t), ...o });
  wrap(asc(S().store), W / 2 | 0).forEach(t => add(t, { a: 'c', b: 1, s: 2 }));
  add('SALES REPORT', { a: 'c', b: 1 }); add(R.label, { a: 'c' });
  add(new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), { a: 'c' }); add(dash);
  add(lr('Orders', a.orders, W)); add(lr('Items sold', a.items, W)); add(dash);
  add(lr('Sales', pm(a.rev - a.tax + a.disc), W)); if (a.disc) add(lr('Discounts', '-' + pm(a.disc), W)); if (a.tax) add(lr('Tax', pm(a.tax), W));
  add(lr('REVENUE', pm(a.rev), W), { b: 1 }); add(dash);
  Object.entries(a.pay).forEach(([m, v]) => add(lr(PAYN[m] || m, pm(v), W)));
  if (a.voids) { add(dash); add(lr(`Voided (${a.voids})`, pm(a.voidAmt), W)); }
  const tops = Object.values(a.prod).sort((x, y) => y.rev - x.rev).slice(0, 5);
  if (tops.length) { add(dash); add('Top items', { b: 1 }); tops.forEach(t => add(lr(`${t.qty} x ${t.name}`, pm(t.rev), W))); }
  add('='.repeat(W)); add('Printed by ' + me.name, { a: 'c' }); return L;
}

/* ---------- SALES ---------- */
function salesView() {
  const admin = isAdmin(), R = rangeFor(admin ? salesF : 'today');
  const list = db.sales.filter(s => s.ts >= R.from && (admin || (s.cashier && s.cashier.id === me.id))), a = agg(list);
  const rev = a.rev, items = a.items, profit = a.profit, ok = list.filter(s => !s.void);
  return `<div class="page"><div class="head"><h1>${admin ? 'Sales' : 'My sales today'}</h1>${admin ? `<button class="btn sm" data-act="repCsv2">Export CSV</button>` : ''}</div>
    ${admin ? `<div class="chips" style="margin-bottom:14px">${[['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All time']].map(([k, l]) => `<button class="chip ${salesF === k ? 'on' : ''}" data-act="salf" data-f="${k}">${l}</button>`).join('')}</div>` : ''}
    <div class="stats"><div class="stat"><b>${money(rev)}</b><span>Revenue</span></div><div class="stat"><b>${ok.length}</b><span>Orders</span></div><div class="stat"><b>${items}</b><span>Items sold</span></div>
      ${admin ? `<div class="stat"><b>${money(profit)}</b><span>Est. profit</span></div>` : ''}</div>
    <div class="group">${list.map(s => `<button class="row rowb" style="width:100%;padding:10px 14px" data-act="receipt" data-id="${s.id}"><span class="m"><b>${s.no} ${s.void ? '<span class="badge void">Void</span>' : ''}</b>
      <small>${fmtDate(s.ts)} · ${s.items.reduce((a, i) => a + i.qty, 0)} items · ${s.method}${s.cashier ? ' · ' + esc(s.cashier.name) : ''}</small></span>
      <span class="pr" style="${s.void ? 'text-decoration:line-through;color:var(--l2)' : ''}">${money(s.total)}</span></button>`).join('') || '<div class="empty">No sales yet</div>'}</div></div>`;
}

/* ---------- SETTINGS / ACCOUNT ---------- */
const R = (label, html) => `<label class="frow"><span>${label}</span>${html}</label>`;
const BTN = (act, label, cls = '', data = '') => `<button class="frow btnrow ${cls}" data-act="${act}" ${data}><span>${label}</span><i>›</i></button>`;
const G = (title, rows, foot) => (title ? `<div class="gt">${title}</div>` : '') + `<div class="group">${rows}</div>` + (foot ? `<div class="gf">${foot}</div>` : '');
const setIn = (k, label, type = 'text', ex = '') => R(label, `<input data-set="${k}" type="${type}" ${ex} value="${esc(db.settings[k])}">`);
const printerRows = () => {
  const on = btDev && btDev.gatt.connected, s = S();
  return (s.method === 'ble' ? `<div class="frow"><span><span class="dot ${on ? 'on' : ''}"></span>${on ? 'Connected' : s.btName ? 'Saved' : 'No printer'}</span><span style="margin-left:auto;color:var(--l2)">${esc(s.btName)}</span></div>${BTN('pair', 'Pair Bluetooth printer')}` : '') + BTN('testPrint', 'Print test receipt');
};
function profileCard() {
  const u = uById(me.id);
  return `<div class="group"><div class="row" style="min-height:92px">${avatar(u, 'xl')}<span class="m"><b style="font-size:20px">${esc(me.name)}</b><small>${isAdmin() ? 'Administrator' : 'Cashier'}</small></span>
    <span class="stack" style="align-items:flex-end"><button class="btn sm" data-act="pickAv" data-id="${u.id}">${u.avatar ? 'Change photo' : 'Add photo'}</button>${u.avatar ? `<button class="btn sm dng" data-act="rmAv" data-id="${u.id}">Remove</button>` : ''}</span></div></div>`;
}
function accountView() {
  return `<div class="page"><div class="head"><h1>Account</h1></div>
    ${profileCard()}
    ${G('Security', BTN('changeOwn', 'Change my PIN') + BTN('lock', 'Lock / switch user'))}
    ${G('Printer', printerRows(), S().method === 'rawbt' ? 'Printing through the RawBT app.' : '')}${aboutGroup()}</div>`;
}
function settingsView() {
  const s = S(), last = meta.lastBackup ? `Last backup: ${fmtDate(meta.lastBackup)}` : 'No backup made yet — export one now.';
  return `<div class="page"><div class="head"><h1>Settings</h1></div>
    ${profileCard()}
    ${G('Store (on receipts)', `<div class="frow" style="min-height:76px"><span>Shop logo</span><span style="margin-left:auto;display:flex;align-items:center;gap:12px">${brandMark('md')}<span class="stack"><button class="btn sm" data-act="pickLogo">${meta.logo ? 'Change' : 'Add logo'}</button>${meta.logo ? '<button class="btn sm dng" data-act="rmLogo">Remove</button>' : ''}</span></span></div>`
      + (meta.logo ? R('Print logo on receipts', `<input type="checkbox" class="sw" data-set="printLogo" ${s.printLogo !== false ? 'checked' : ''}>`) : '')
      + setIn('store', 'Store name') + setIn('addr', 'Address') + setIn('phone', 'Phone') + setIn('footer', 'Footer'))}
    ${G('Sales', setIn('cur', 'Currency symbol') + R('Decimals', `<select data-set="dec"><option value="0" ${+s.dec === 0 ? 'selected' : ''}>0 (1,000)</option><option value="2" ${+s.dec === 2 ? 'selected' : ''}>2 (1,000.00)</option></select>`)
      + setIn('tax', 'Tax % (on top)', 'number', 'inputmode="decimal" step="any" min="0"') + setIn('cashDiscMax', 'Cashier max discount %', 'number', 'inputmode="decimal" step="any" min="0" max="100"'), 'Use letters for currencies that thermal printers cannot print (e.g. Rp).')}
    ${G('Loyalty program', R('Enabled', `<input type="checkbox" class="sw" data-set="loyaltyOn" ${s.loyaltyOn !== false ? 'checked' : ''}>`)
      + setIn('earnPer', 'Spend this much to earn 1 point', 'number', 'inputmode="decimal" step="any" min="0"') + setIn('ptValue', 'Value of 1 point', 'number', 'inputmode="decimal" step="any" min="0"') + setIn('minRedeem', 'Minimum points to redeem', 'number', 'inputmode="numeric" min="0"'),
      `Example: a ${money(100)} purchase earns ${earnPts(100)} point(s); 100 points are worth ${money(ptsValue(100))}. Points are earned on the amount paid before tax.`)}
    ${G('Printer', R('Paper', `<select data-set="paper"><option value="58" ${+s.paper === 58 ? 'selected' : ''}>58 mm</option><option value="80" ${+s.paper === 80 ? 'selected' : ''}>80 mm</option></select>`)
      + R('Method', `<select data-set="method"><option value="ble" ${s.method === 'ble' ? 'selected' : ''}>Bluetooth LE</option><option value="rawbt" ${s.method === 'rawbt' ? 'selected' : ''}>RawBT app</option><option value="sys" ${s.method === 'sys' ? 'selected' : ''}>System print</option></select>`) + printerRows())}
    ${G('Team', meta.users.map(u => `<button class="row rowb" style="width:100%;padding:10px 16px" data-act="userEdit" data-id="${u.id}">${avatar(u)}<span class="m"><b>${esc(u.name)}${u.id === me.id ? ' (you)' : ''}</b><small>${u.role === 'admin' ? 'Administrator · password' : 'Cashier · 6-digit PIN'}</small></span><i style="color:var(--l3);font-style:normal;font-size:22px">›</i></button>`).join('') + BTN('userNew', 'Add user'),
      'Cashiers can sell, reprint receipts and see their own sales today. Only administrators manage items, stock, users, voids and settings.')}
    ${G('Security', R('Auto-lock', `<select data-meta="autoLock">${[[0, 'Off'], [1, '1 minute'], [2, '2 minutes'], [5, '5 minutes'], [10, '10 minutes'], [30, '30 minutes']].map(([v, l]) => `<option value="${v}" ${meta.autoLock === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)
      + BTN('changeOwn', 'Change my password') + BTN('log', 'Activity log') + BTN('lock', 'Lock now'), '5 wrong attempts trigger a timed lockout. Anyone with the shop account can read the shop data, so keep it private.')}
    ${G('Shop sync', `<div class="frow" id="cloudStat" style="min-height:64px">${cloudStatHtml()}</div>` + BTN('syncNow', 'Sync now') + BTN('shopOut', 'Disconnect this device', 'dng'),
      'Every device signed in to the same shop account shares this data live. Changes made offline are sent as soon as the connection returns. To add a device: open the app on it and sign in with the shop account.')}
    ${G('Data', BTN('export', 'Export backup') + BTN('import', 'Restore from backup') + BTN('csv', 'Export sales to Excel (CSV)') + BTN('reset', 'Erase all data', 'dng'), `${last} Backup and CSV files are NOT encrypted — keep them private.`)}${aboutGroup()}</div>`;
}

/* ---------- team + security sheets (admin) ---------- */
let UF = { role: 'cashier' };
function userSheet(u) {
  const role = u ? u.role : UF.role, pin = role !== 'admin'; modalUser = u ? u.id : null;
  modal(`<h2>${u ? esc(u.name) : 'New user'}</h2>${u ? `<div class="sub">${role === 'admin' ? 'Administrator' : 'Cashier'}</div>
    <div class="photo" style="justify-content:center">${avatar(u, 'xl')}<div class="stack"><button class="btn sm" data-act="pickAv" data-id="${u.id}">${u.avatar ? 'Change photo' : 'Add photo'}</button>${u.avatar ? `<button class="btn sm dng" data-act="rmAv" data-id="${u.id}">Remove photo</button>` : ''}</div></div>` : ''}
    ${u ? '' : `<div class="group"><label class="frow"><span>Name</span><input id="uName" autocomplete="off" value="${esc(UF.name || '')}"></label></div>
    <div class="seg"><button class="${role === 'cashier' ? 'on' : ''}" data-act="urole" data-r="cashier">Cashier</button><button class="${role === 'admin' ? 'on' : ''}" data-act="urole" data-r="admin">Administrator</button></div>`}
    <div class="group"><label class="frow"><span>${u ? 'New ' : ''}${pin ? 'PIN' : 'Password'}</span><input id="uSec" type="password" autocomplete="new-password" ${pin ? 'inputmode="numeric" maxlength="6" placeholder="6 digits"' : 'placeholder="8+ characters"'}></label>
    <label class="frow"><span>Confirm</span><input id="uSec2" type="password" autocomplete="new-password" ${pin ? 'inputmode="numeric" maxlength="6"' : ''}></label></div>
    <button class="btn pri big" data-act="saveUser" data-id="${u ? u.id : ''}">${u ? 'Reset ' + (pin ? 'PIN' : 'password') : 'Add user'}</button>
    ${u && u.id !== me.id ? `<button class="btn dng" data-act="removeUser" data-id="${u.id}">Remove user</button>` : ''}<button class="btn" data-act="close">Cancel</button>`);
}
async function saveUser(id) {
  const sec = $('#uSec').value, sec2 = $('#uSec2').value;
  const u = id ? meta.users.find(x => x.id === id) : null, role = u ? u.role : UF.role;
  const name = u ? u.name : $('#uName').value.trim();
  if (!name) return toast('Enter a name', true);
  const bad = validSecret(role, sec); if (bad) return toast(bad, true);
  if (sec !== sec2) return toast('Entries do not match', true);
  if (!u && meta.users.some(x => x.name.toLowerCase() === name.toLowerCase())) return toast('That name already exists', true);
  toast('Saving…');
  const nu = await makeUser(name, role, sec, dekRaw);
  if (u) { Object.assign(u, { salt: nu.salt, wrap: nu.wrap, credUpd: Date.now(), fails: 0, until: 0 }); delete u.needsReset; logEv('user', `Reset credentials for ${u.name}`); }
  else { meta.users.push(nu); logEv('user', `Added ${role} ${name}`); }
  await saveMeta(); UF = { role: 'cashier' }; closeModal(); render(); toast('Saved');
}
function removeUser(id) {
  const u = meta.users.find(x => x.id === id);
  if (!u || u.id === me.id) return;
  if (u.role === 'admin' && meta.users.filter(x => x.role === 'admin').length < 2) return toast('Keep at least one administrator', true);
  if (!confirm(`Remove ${u.name}? Their past sales stay in the history.`)) return;
  meta.users = meta.users.filter(x => x.id !== id); markDirty('creds/' + id); saveMeta(); logEv('user', `Removed ${u.name}`); closeModal(); render();
}
function ownSecretSheet() {
  const pin = !isAdmin();
  modal(`<h2>Change my ${pin ? 'PIN' : 'password'}</h2><div class="group">
    <label class="frow"><span>Current</span><input id="oCur" type="password" autocomplete="off" ${pin ? 'inputmode="numeric" maxlength="6"' : ''}></label>
    <label class="frow"><span>New</span><input id="oNew" type="password" autocomplete="new-password" ${pin ? 'inputmode="numeric" maxlength="6" placeholder="6 digits"' : 'placeholder="8+ characters"'}></label>
    <label class="frow"><span>Confirm</span><input id="oNew2" type="password" autocomplete="new-password" ${pin ? 'inputmode="numeric" maxlength="6"' : ''}></label></div>
    <button class="btn pri big" data-act="saveOwn">Save</button><button class="btn" data-act="close">Cancel</button>`);
}
async function saveOwn() {
  const u = meta.users.find(x => x.id === me.id), cur = $('#oCur').value, nw = $('#oNew').value;
  const bad = validSecret(me.role, nw); if (bad) return toast(bad, true);
  if (nw !== $('#oNew2').value) return toast('Entries do not match', true);
  toast('Checking…'); const raw = await tryUnwrap(u, cur); if (!raw) return toast('Current ' + (pin() ? 'PIN' : 'password') + ' is wrong', true);
  const nu = await makeUser(u.name, u.role, nw, raw); u.salt = nu.salt; u.wrap = nu.wrap; u.credUpd = Date.now(); await saveMeta();
  logEv('user', 'Changed own credentials'); closeModal(); toast('Updated');
  function pin() { return me.role !== 'admin'; }
}
function logSheet() {
  const fl = (meta.fails || []).slice(0, 8);
  modal(`<h2>Activity log</h2><div class="group" style="max-height:48dvh;overflow:auto">${db.log.slice(0, 150).map(e => `<div class="logrow"><time>${fmtDate(e.ts)}</time><span><b>${esc(e.user)}</b> · ${esc(e.text)}</span></div>`).join('') || '<div class="empty">Nothing yet</div>'}</div>
    ${fl.length ? `<div class="gt" style="margin:4px 8px 0">Failed sign-ins</div><div class="group">${fl.map(f => `<div class="logrow"><time>${fmtDate(f.ts)}</time><span>Wrong credentials for <b>${esc(f.user)}</b></span></div>`).join('')}</div>` : ''}
    <button class="btn" data-act="close">Close</button>`);
}
function askSecret(title, text, cb) {
  modal(`<h2>${title}</h2><div class="sub">${text}</div><div class="group"><label class="frow"><span>Password</span><input id="aPw" type="password" autocomplete="off"></label></div>
    <button class="btn pri big" data-act="askOk">Confirm</button><button class="btn" data-act="close">Cancel</button>`);
  askSecret.cb = cb; setTimeout(() => { const i = $('#aPw'); i && i.focus(); }, 60);
}

/* ---------- backup / restore ---------- */
const toB = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
const fromB = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
async function exportBackup() {
  const dump = { app: 'epos', v: 3, meta, vault: await IDB.get('vault', 'main') };
  for (const n of DOCS) dump[n] = await IDB.all(n);
  const json = JSON.stringify(dump, (k, v) => v instanceof Uint8Array ? { $b: toB(v) } : v);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `epos-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  meta.lastBackup = Date.now(); saveMeta(); logEv('backup', 'Exported backup'); render();
}
let restoreMode = false;
async function importBackup(file) {
  try {
    const d = JSON.parse(await file.text(), (k, v) => v && v.$b !== undefined ? fromB(v.$b) : v);
    if (d.app !== 'epos' || !d.meta || !d.vault) throw 0;
    if (!confirm(`Replace ALL current data with this backup (${d.products.length} items, ${d.sales.length} sales)? You will sign in again with the backup's accounts.`)) return;
    await IDB.tx(['kv', 'vault', ...DOCS], t => {
      t.objectStore('kv').put(d.meta, 'users'); t.objectStore('vault').put(d.vault, 'main');
      DOCS.forEach(n => { const o = t.objectStore(n); o.clear(); (d[n] || []).forEach(x => o.put(x)); });
    });
    meta = d.meta; meta.upd = Date.now(); meta.users.forEach(u => { u.credUpd = Date.now(); }); await IDB.put('kv', meta, 'users'); cart = []; lastUser = null; markAllDirty(); toast('Backup restored — please sign in'); showLogin();
  } catch (e) { toast('Not a valid EPOS backup file', true); }
}

/* ====================================================================
   EVENTS
   ==================================================================== */
/* ====================================================================
   SHOP SYNC — one shared Supabase database; every signed-in device sees changes live.
   - Each record is a row (store, id, data, upd). The newest change (upd) wins; stock is a sum of +/- moves.
   - Works offline: changes wait in a queue (syncSt.dirty) and are sent when the connection returns.
   - To move to another host later, only this section (push / pull / subscribe) has to be re-implemented.
   ==================================================================== */
const SB_URL = 'https://esalhunqautagwexipio.supabase.co', SB_KEY = 'sb_publishable_1t6oKD7iIZTEh3TVJQf0gg_ghntkSf_'; // public by design (protected by the shop login + row-level security)
let syncSt = null, sb = null, sbChan = null, sbLive = false, syncBusy = false, pullBusy = false, syncT = null, syncSaveT = null, rtT = null, rrT = null, pendingRT = [];
const rep = (k, v) => v instanceof Uint8Array ? { $b: toB(v) } : v;
const rev = (k, v) => v && v.$b !== undefined ? fromB(v.$b) : v;
const jclean = o => JSON.parse(JSON.stringify(o, rep));
const jrestore = o => JSON.parse(JSON.stringify(o), rev);
const timeAgo = ts => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
function saveSync() { clearTimeout(syncSaveT); syncSaveT = setTimeout(() => { if (syncSt) IDB.put('kv', syncSt, 'sync').catch(() => {}); }, 800); }
function markDirty(key) { if (!syncSt) return; if (!syncSt.dirty.includes(key)) syncSt.dirty.push(key); saveSync(); scheduleSync(); }
async function markAllDirty() {
  if (!syncSt) return; const have = new Set(syncSt.dirty); have.add('meta'); have.add('vault'); ((meta && meta.users) || []).forEach(u => have.add('creds/' + u.id));
  for (const s of DOCS) (await IDB.all(s)).forEach(r => have.add(s + '/' + r.id));
  syncSt.dirty = [...have]; saveSync(); scheduleSync();
}
function scheduleSync() { clearTimeout(syncT); syncT = setTimeout(() => syncFlush(), 1200); }
// Opened from a password-reset email? The link carries #access_token=…&type=recovery (or #error=… when expired). Read it before the client strips it.
const AUTH_URL = (() => { const h = location.hash + '&' + location.search.slice(1); const g = k => { const m = h.match(new RegExp('[#&?]' + k + '=([^&]*)')); return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : ''; }; return { recovery: g('type') === 'recovery', err: g('error_description') || g('error') }; })();
function sbClient() {
  if (sb) return sb; if (!window.supabase) return null;
  sb = supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'epos.auth' } });
  sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') setTimeout(showNewPassword, 0); });
  return sb;
}
async function shopSession() { try { const c = sbClient(); if (!c) return null; const { data } = await c.auth.getSession(); return data && data.session; } catch (e) { return null; } }

/* ---------- local row <-> shared row ---------- */
async function toRemote(key) {
  if (key === 'meta') { // shared copy never contains password/PIN verifiers
    if (!meta) return null;
    const users = meta.users.map(u => ({ id: u.id, name: u.name, role: u.role, avatar: u.avatar, created: u.created }));
    return { store: 'meta', id: 'main', data: jclean({ ...meta, users, fails: [] }), upd: meta.upd || 1, del: false };
  }
  if (key.startsWith('creds/')) { // one row per user, so the server can hide administrator rows from cashier accounts
    if (!meta) return null; const id = key.slice(6), u = meta.users.find(x => x.id === id);
    if (!u) return { store: 'creds', id, data: null, upd: Date.now(), del: true };
    if (!u.wrap) return null;
    return { store: 'creds', id, data: jclean({ role: u.role, salt: u.salt, wrap: u.wrap }), upd: u.credUpd || 1, del: false };
  }
  if (key === 'vault') { const v = await IDB.get('vault', 'main'); return v ? { store: 'vault', id: 'main', data: await decObj(v.d), upd: v.upd || 1, del: false } : null; }
  const i = key.indexOf('/'), store = key.slice(0, i), r = await IDB.get(store, key.slice(i + 1));
  return r ? { store, id: r.id, data: r.del ? null : await decObj(r.d), upd: r.upd || 0, del: !!r.del } : null;
}
const fromRemote = r => { const d = r.data == null ? null : jrestore(r.data); return { id: r.id, ts: (d && d.ts) || 0, upd: r.upd, dev: d && d.dev, d, del: !!r.del }; };

/* ---------- merge (newest change wins) ---------- */
const NEWER = (a, b) => (a.upd || 0) > (b.upd || 0);
async function mergeRows(store, rows) {
  let n = 0;
  for (const r of rows) {
    const mine = await IDB.get(store, r.id);
    if (mine && !NEWER(r, mine)) continue;
    await IDB.put(store, r); n++;
    if (!db) continue;
    const arr = db[store] = db[store] || [], i = arr.findIndex(x => x.id === r.id);
    if (r.del) { if (i >= 0) arr.splice(i, 1); continue; }
    const o = await decObj(r.d); if (i >= 0) arr[i] = o; else arr.push(o);
  }
  if (n && db && ['sales', 'log', 'pos', 'counts', 'grn'].includes(store)) db[store].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return n;
}
async function mergeVault(data, upd) { // settings: newest wins, except this device's printer; invoice counter: highest wins
  if (!data) return 0;
  const mine = await IDB.get('vault', 'main'), newer = !mine || upd > (mine.upd || 0);
  if (!db) { if (!newer) return 0; await IDB.put('vault', { d: data, upd }, 'main'); return 1; }
  const seq = Math.max(db.seq || 0, data.seq || 0);
  if (!newer && seq === db.seq) return 0;
  if (newer) { const s = { ...DEF, ...data.settings }; ['method', 'btId', 'btName', 'paper'].forEach(k => { if (db.settings[k] !== undefined) s[k] = db.settings[k]; }); db.settings = s; }
  db.seq = seq; await IDB.put('vault', { d: { settings: db.settings, seq }, upd: newer ? upd : (mine.upd || 0) }, 'main'); return 1;
}
/* Password / PIN verifiers (salt + wrap) travel as separate 'creds' rows. credStore keeps what arrived, even before the user list does. */
let credStore = {};
async function attachCreds() {
  let ch = 0; if (!meta) return 0;
  for (const u of meta.users) { const c = credStore[u.id]; if (c && c.wrap && (!u.wrap || c.upd > (u.credUpd || 0))) { u.salt = c.salt; u.wrap = c.wrap; u.credUpd = c.upd; delete u.needsReset; ch++; } }
  try { await IDB.put('kv', credStore, 'creds'); if (ch) await IDB.put('kv', meta, 'users'); } catch (e) {}
  return ch;
}
async function mergeMeta(data, upd) { // people, logo, store name: newest wins; auto-lock and login counters stay per device
  if (!data || (meta && (meta.upd || 0) >= upd)) return 0;
  const keep = meta ? { autoLock: meta.autoLock, lastBackup: meta.lastBackup, fails: meta.fails } : {};
  const old = new Map(((meta && meta.users) || []).map(u => [u.id, u]));
  const users = (data.users || []).map(ru => { const o = old.get(ru.id) || {}; return { ...ru, salt: o.salt || ru.salt, wrap: o.wrap || ru.wrap, credUpd: o.credUpd || 0, fails: o.fails || 0, until: o.until || 0 }; });
  meta = { ...data, ...keep, users, upd }; await attachCreds(); await IDB.put('kv', meta, 'users'); return 1;
}
async function applyRemote(list) {
  let n = 0, credGot = false; const by = {};
  for (const r of list) {
    if (r.store === 'creds') { credGot = true; if (r.del || !r.data) delete credStore[r.id]; else { const d = jrestore(r.data); if (!credStore[r.id] || r.upd >= credStore[r.id].upd) credStore[r.id] = { salt: d.salt, wrap: d.wrap, role: d.role, upd: r.upd }; } }
    else if (r.store === 'meta') n += await mergeMeta(r.data && jrestore(r.data), r.upd);
    else if (r.store === 'vault') n += await mergeVault(r.data && jrestore(r.data), r.upd);
    else if (DOCS.includes(r.store)) (by[r.store] = by[r.store] || []).push(fromRemote(r));
  }
  for (const s in by) n += await mergeRows(s, by[s]);
  if (credGot) { n += await attachCreds(); }
  if (n && db) { recomputeStock(); queueRender(); }
  return n;
}
function queueRender() { // never redraw while someone is typing
  clearTimeout(rrT); rrT = setTimeout(function go() {
    if (!me || !db) return; const a = document.activeElement;
    if (!$('#modal').classList.contains('hidden') || (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) { rrT = setTimeout(go, 1500); return; }
    render();
  }, 250);
}

/* ---------- send / fetch / live ---------- */
async function syncPush() {
  while (syncSt.dirty.length) {
    const keys = syncSt.dirty.splice(0, 40);
    try {
      const rows = []; for (const k of keys) { const r = await toRemote(k); if (r) rows.push(r); }
      if (rows.length) { const { error } = await sb.from('docs').upsert(rows, { onConflict: 'store,id' }); if (error) throw new Error(error.message); }
    } catch (e) { keys.forEach(k => { if (!syncSt.dirty.includes(k)) syncSt.dirty.push(k); }); throw e; }
    saveSync();
  }
}
async function syncPull() {
  if (pullBusy || !sb) return 0; pullBusy = true; let n = 0;
  try {
    for (;;) {
      let q = sb.from('docs').select('store,id,data,upd,del,srv').order('srv', { ascending: true }).limit(500);
      if (syncSt.srv) q = q.gt('srv', syncSt.srv);
      const { data, error } = await q; if (error) throw new Error(error.message);
      if (!data.length) break;
      n += await applyRemote(data); syncSt.srv = data[data.length - 1].srv; saveSync();
      if (data.length < 500) break;
    }
    syncSt.lastPull = Date.now();
  } finally { pullBusy = false; }
  return n;
}
async function syncFlush(o = {}) {
  if (syncBusy || !sb || !syncSt) return false;
  if (!navigator.onLine) { uiSync(); return false; }
  if (!(await shopSession())) { syncSt.err = 'Shop sign-in expired — reconnect this device'; uiSync(); return false; }
  syncBusy = true; syncSt.err = ''; uiSync();
  try { await syncPush(); if (o.pull || !sbLive) await syncPull(); syncSt.last = Date.now(); }
  catch (e) { syncSt.err = e.message || 'Sync failed'; if (o.manual) toast('Sync failed: ' + syncSt.err, true); }
  finally { syncBusy = false; saveSync(); uiSync(); if (!syncSt.err && syncSt.dirty.length) scheduleSync(); }
  return !syncSt.err;
}
function sbSubscribe() {
  if (sbChan || !sb) return;
  sbChan = sb.channel('epos-docs').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => {
    const r = p.new; if (!r || !r.store) return;
    if (r.data === undefined && !r.del) { syncPull().catch(() => {}); return; } // very large record: fetch it normally
    pendingRT.push(r); clearTimeout(rtT); rtT = setTimeout(() => applyRemote(pendingRT.splice(0)).catch(() => {}), 150);
  }).subscribe(st => { sbLive = st === 'SUBSCRIBED'; if (sbLive) syncPull().catch(() => {}); uiSync(); });
}
async function sbStart() { // called after someone signs in to the app
  if (!sbClient() || !syncSt || !(await shopSession())) return;
  if (isAdmin() && !syncSt.credsSplit) { // one time: move verifiers out of the shared 'meta' row into 'creds' rows and overwrite the old shared copy
    syncSt.credsSplit = true; meta.users.forEach(u => { u.credUpd = u.credUpd || 1; }); await saveMeta();
  }
  if (!syncSt.seeded) { syncSt.seeded = true; if (!syncSt.srv) await markAllDirty(); } // first device on an empty shop database uploads what it has; a device that just downloaded the shop data does not
  sbSubscribe(); syncFlush({ pull: true });
}

/* ---------- connecting a device to the shop ---------- */
function showShopLogin(msg) {
  $('.app').classList.add('locked'); me = null; db = null; dek = null;
  $('#main').innerHTML = `<div class="login"><div class="logo">${ICON.logo}</div><h1>Connect to your shop</h1><p>Sign in with the shop account once on this device.<br>After that every device stays in sync, live.</p>
    <div class="loginform"><label class="fld">Shop email<input id="shEmail" type="email" autocomplete="username" value="${esc(localStorage.getItem('epos.shopEmail') || '')}"></label>
      <label class="fld">Shop password<input id="shPw" type="password" autocomplete="current-password"></label>
      <div class="err" id="shErr">${esc(msg || '')}</div><button class="btn pri big" data-act="shopIn">Connect</button>
      <button class="back" data-act="shopForgot" style="margin-top:12px">Forgot shop password?</button></div></div>`;
}
async function shopForgot() {
  const email = ($('#shEmail').value || '').trim(), err = $('#shErr');
  if (!email) { err.textContent = 'Enter the shop email first, then tap “Forgot shop password?”'; return; }
  if (!navigator.onLine) { err.textContent = 'No internet connection'; return; }
  if (!sbClient()) { err.textContent = 'Sync library missing — reload the app'; return; }
  err.textContent = 'Sending…';
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  err.textContent = error ? error.message : 'Reset link sent. Open the email on this device and tap the link.';
}
async function shopIn() {
  const email = ($('#shEmail').value || '').trim(), password = $('#shPw').value, err = $('#shErr'); if (!email || !password) { err.textContent = 'Enter the shop email and password'; return; }
  if (!sbClient()) { err.textContent = 'Sync library missing — reload the app'; return; }
  err.textContent = 'Connecting…';
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { err.textContent = /invalid/i.test(error.message) ? 'Wrong email or password' : error.message; return; }
  try { localStorage.setItem('epos.shopEmail', email); localStorage.setItem('epos.shop', '1'); } catch (e) {}
  err.textContent = 'Loading shop data…';
  try { const n = await syncPull(); if (n > 0) syncSt.seeded = true; } catch (e) { err.textContent = 'Could not load data: ' + e.message; return; }
  sbSubscribe(); meta && meta.users && meta.users.length ? showLogin() : showSetup();
}
/* ---------- set a new shop password (arrives from the reset email) ---------- */
function showNewPassword(msg) {
  $('.app').classList.add('locked'); me = null; db = null; dek = null;
  $('#main').innerHTML = `<div class="login"><div class="logo">${ICON.logo}</div><h1>Set a new shop password</h1><p>Choose the password for the shop account.<br>Use it to connect each device.</p>
    <div class="loginform"><label class="fld">New password (8+ characters)<input id="npPw" type="password" autocomplete="new-password"></label>
      <label class="fld">Confirm password<input id="npPw2" type="password" autocomplete="new-password"></label>
      <div class="err" id="npErr">${esc(msg || '')}</div><button class="btn pri big" data-act="setShopPw">Save password</button></div></div>`;
}
async function setShopPw() {
  const pw = $('#npPw').value, err = $('#npErr');
  if (pw.length < 8) { err.textContent = 'Password must be at least 8 characters'; return; }
  if (pw !== $('#npPw2').value) { err.textContent = 'Passwords do not match'; return; }
  if (!(await shopSession())) { showShopLogin('This reset link has expired. Request a new one.'); return; }
  err.textContent = 'Saving…';
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) { err.textContent = error.message; return; }
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  location.replace(location.pathname); // reload: the device is already signed in, continue normally
}
async function shopOut() {
  if (!confirm('Disconnect this device from the shop? Unsent changes are sent first. You must sign in to the shop again to use the app.')) return;
  try { await syncFlush({ manual: true }); } catch (e) {}
  try { await sb.auth.signOut(); localStorage.removeItem('epos.shop'); } catch (e) {}
  location.reload();
}

/* ---------- status shown in Settings and on the dashboard ---------- */
const syncState = () => syncSt.err ? ['bad', 'Sync problem'] : !navigator.onLine ? ['', 'Offline — changes will be sent later'] : syncBusy ? ['on', 'Syncing…'] : syncSt.dirty.length ? ['on', 'Sending changes…'] : sbLive ? ['on', 'Live'] : ['', 'Connecting…'];
function uiSync() { const el = $('#cloudStat'); if (el) el.innerHTML = cloudStatHtml(); }
function cloudStatHtml() {
  const s = syncSt, [c, t] = syncState();
  return `<span><span class="dot ${c === 'on' ? 'on' : ''}" style="${c === 'bad' ? 'background:var(--red)' : ''}"></span>${t}</span>
    <span style="margin-left:auto;text-align:right;color:var(--l2);font-size:14px">${esc(localStorage.getItem('epos.shopEmail') || '')} · ${s.last ? timeAgo(s.last) : 'not yet'}${s.dirty.length ? ` · ${s.dirty.length} pending` : ''}${s.err ? `<br><b style="color:var(--red)">${esc(s.err)}</b>` : ''}</span>`;
}
function cloudBanner() {
  if (!isAdmin() || !syncSt || !syncSt.err) return '<span id="cloudBanner"></span>';
  return `<button id="cloudBanner" class="card" data-act="nav" data-v="settings" style="width:100%;text-align:left;margin-bottom:12px;display:flex;gap:10px;align-items:center;border:1px solid var(--red)">${ICON.lock}<span style="flex:1"><b>Shop sync</b><br><small style="color:var(--l2)">${esc(syncSt.err)}</small></span><span style="color:var(--tint);font-weight:600">Fix ›</span></button>`;
}
document.addEventListener('visibilitychange', () => { if (syncSt && sb && me && !document.hidden) syncFlush({ pull: true }); });
addEventListener('online', () => { if (syncSt && sb && me) syncFlush({ pull: true }); uiSync(); });
addEventListener('offline', uiSync);
setInterval(() => { if (syncSt && sb && me && !sbLive) syncFlush({ pull: true }); }, 30000); // safety net if the live connection drops

const ADMIN_ONLY = new Set(['dp', 'repPrint', 'repCsv', 'repCsv2', 'pickImg', 'rmImg', 'sf', 'sadj', 'edit', 'newProd', 'saveProd', 'delProd', 'void', 'export', 'csv', 'import', 'reset', 'userNew', 'userEdit', 'saveUser', 'removeUser', 'urole', 'log', 'shopOut', 'syncNow']);
const ADMIN_RE = /^(scan(Sku|Inv|Count|Po|Rcv)|po[A-Z]|sup|cnt|rc|grn|newPo|newCount|startCount|itab|openPo|pickLogo|rmLogo|custEdit|custAdj|custDel|custCsv)/;
const A = {
  nav: d => { view = d.v; render(); },
  cat: d => { cat = d.c; updateGrid(); },
  add: d => addToCart(d.id), inc: d => addToCart(d.id),
  dec: d => { const c = cart.find(x => x.id === d.id); if (c && --c.qty <= 0) cart = cart.filter(x => x !== c); updateGrid(); updateCart(); },
  rm: d => { cart = cart.filter(x => x.id !== d.id); updateGrid(); updateCart(); },
  clear: () => { if (confirm('Clear the current order?')) { cart = []; discount = 0; custId = null; updateGrid(); updateCart(); } },
  cartOpen: () => $('#cart').classList.add('open'), cartClose: () => $('#cart').classList.remove('open'),
  checkout: () => { $('#cart').classList.remove('open'); openCheckout(); },
  ckm: d => { ck.method = d.m; renderCheckout(); },
  ckq: d => { ck.recv = d.v; $('#ckRecv').value = d.v; ckUpdate(); },
  ckdone: d => finishSale(d.print === '1'),
  close: () => closeModal(),
  print: d => doPrint(db.sales.find(s => s.id === d.id)),
  receipt: d => showReceipt(db.sales.find(s => s.id === d.id)),
  void: d => {
    const s = db.sales.find(x => x.id === d.id);
    if (!confirm(`Void ${s.no} and return items to stock? This cannot be undone.`)) return;
    s.void = true; saveSale(s); s.items.forEach(i => { const p = prod(i.id); if (p && p.stock !== null) setStock(p, p.stock + i.qty); });
    const vc = s.customerId && cust(s.customerId); // reverse loyalty effects
    if (vc && s.pts) { vc.points = Math.max(0, vc.points - s.pts.earned + s.pts.used); vc.spent = r2(Math.max(0, (vc.spent || 0) - s.total)); vc.visits = Math.max(0, (vc.visits || 0) - 1); persist('customers', vc); }
    logEv('void', `Voided ${s.no} (${money(s.total)})`); closeModal(); render(); toast('Sale voided');
  },
  sf: d => { stockF = d.f; render(); }, salf: d => { salesF = d.f; render(); },
  sadj: d => { const p = prod(d.id), n = p.stock + +d.d; if (n < 0) return; logEv('stock', `${p.name}: stock ${p.stock} → ${n}`); setStock(p, n); updateStock(); },
  pickImg: () => $('#imgFile').click(),
  rmImg: () => { imgDraft = null; const n = ($('#fName') || {}).value || 'x'; $('#pPrev').innerHTML = esc(($('#fIcon').value || n)[0].toUpperCase()); },
  edit: d => productForm(prod(d.id)), newProd: () => productForm(null), saveProd: d => saveProd(d.id),
  delProd: d => { const p = prod(d.id); if (confirm('Delete this item? Past sales keep their records.')) { db.products = db.products.filter(x => x.id !== d.id); cart = cart.filter(c => c.id !== d.id); IDB.del('products', d.id); logEv('item', `Deleted item ${p.name}`); closeModal(); render(); } },
  pair: async () => { try { await btConnect(true); toast('Paired: ' + S().btName); render(); } catch (e) { if (e.name !== 'NotFoundError') toast(e.message, true); } },
  testPrint: () => printLines(receiptLines(testSale())),
  userNew: () => { UF = { role: 'cashier' }; userSheet(null); },
  userEdit: d => userSheet(meta.users.find(u => u.id === d.id)),
  urole: d => { UF = { role: d.r, name: ($('#uName') || {}).value }; userSheet(null); },
  saveUser: d => saveUser(d.id), removeUser: d => removeUser(d.id),
  changeOwn: () => ownSecretSheet(), saveOwn: () => saveOwn(), log: () => logSheet(),
  lock: () => lock(),
  checkUpdate: () => checkUpdate(false), applyUpdate: () => applyUpdate(),
  /* shop sync */
  shopIn: () => shopIn(), shopForgot: () => shopForgot(), setShopPw: () => setShopPw(),
  syncNow: () => { toast('Syncing…'); syncFlush({ manual: true, pull: true }).then(ok => { if (ok) toast('Everything is up to date ✓'); }); },
  shopOut: () => shopOut(),
  /* camera scanner */
  scanSell: () => openScanner({ title: 'Scan items', continuous: true, onCode: scanHandlers.sell }),
  scanSku: () => openScanner({ title: 'Scan item barcode', onCode: scanHandlers.sku }),
  scanInv: () => openScanner({ title: 'Find item', onCode: scanHandlers.inv }),
  scanCount: () => openScanner({ title: 'Count by scanning', continuous: true, onCode: scanHandlers.count }),
  scanPo: () => openScanner({ title: 'Add to order', continuous: true, onCode: scanHandlers.po }),
  scanRcv: () => openScanner({ title: 'Add received items', continuous: true, onCode: scanHandlers.rcv }),
  scClose: () => closeScanner(),
  scType: () => { const v = prompt('Enter the code'); if (v && v.trim()) scanHit(v.trim()); },
  scTorch: async () => { if (!scan) return; scan.torch = !scan.torch; try { await scan.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: scan.torch }] }); } catch (e) { toast('Light not supported', true); } },
  /* inventory tabs, purchasing, suppliers, stock count */
  itab: d => { invTab = d.t; render(); },
  poFilter: d => { poF = d.f; render(); },
  newPo: () => newPo(), openPo: d => { POD = JSON.parse(JSON.stringify(db.pos.find(x => x.id === d.id))); poSheet(); },
  poRm: d => { syncPo(); POD.items.splice(+d.i, 1); poSheet(); },
  poLow: () => { syncPo(); db.products.filter(p => p.stock !== null && p.stock <= p.low && !POD.items.some(i => i.id === p.id)).forEach(p => POD.items.push({ id: p.id, name: p.name, qty: suggestQty(p), cost: p.cost || 0 })); poSheet(); },
  poSave: d => savePo(d.s),
  poDel: () => { if (confirm('Delete this draft?')) { db.pos = db.pos.filter(x => x.id !== POD.id); IDB.del('pos', POD.id); closeModal(); render(); } },
  poReceive: () => openReceive(db.pos.find(x => x.id === POD.id)), rcOk: () => applyReceive(),
  rcvHome: () => receiveHome(), rcvPo: d => openReceive(db.pos.find(x => x.id === d.id)), rcvDirect: () => openReceive(null),
  rcvBack: () => { const po = RCV && RCV.poId; RCV = null; if (po && POD) poSheet(); else closeModal(); },
  rcvRm: d => { syncRcv(); RCV.items.splice(+d.i, 1); rcvSheet(); },
  rcvNewSup: () => { syncRcv(); supplierForm(null, 'rcv'); },
  grnOpen: d => grnSheet(db.grn.find(x => x.id === d.id)), grnPrint: d => printLines(grnLines(db.grn.find(x => x.id === d.id))),
  /* customers + loyalty */
  cuf: d => { cuF = d.f; render(); },
  custNew: () => customerForm(null, null), custOpen: d => custSheet(d.id), custEdit: d => customerForm(d.id, null), custSave: d => saveCustomer(d.id),
  custFormBack: d => (d.id ? custSheet(d.id) : (cuRet === 'pick' ? custPicker() : closeModal())),
  custAdj: d => adjSheet(d.id), custBack: d => custSheet(d.id),
  custAdjOk: d => { const c = cust(d.id), n = parseInt($('#adjN').value); if (!n) return toast('Enter the number of points', true); c.points = Math.max(0, c.points + n); (c.adj = c.adj || []).unshift({ ts: Date.now(), by: me.name, delta: n, reason: $('#adjR').value.trim() }); persist('customers', c); logEv('points', `${c.name}: ${n > 0 ? '+' : ''}${n} points${$('#adjR').value.trim() ? ' (' + $('#adjR').value.trim() + ')' : ''}`); custSheet(d.id); },
  custDel: d => { const c = cust(d.id); if (!confirm(`Delete ${c.name}? Their past sales stay in the history.`)) return; db.customers = db.customers.filter(x => x.id !== d.id); IDB.del('customers', d.id); if (custId === d.id) custId = null; logEv('customer', `Deleted customer ${c.name}`); closeModal(); render(); },
  custSelect: d => { custId = d.id; closeModal(); view = 'sell'; render(); toast(`Customer: ${cust(d.id).name}`); },
  custPick: () => custPicker(), custClear: () => { custId = null; closeModal(); updateCart(); },
  cpSelect: d => { custId = d.id; closeModal(); updateCart(); toast(`Customer: ${cust(d.id).name}`); }, cpNew: () => customerForm(null, 'pick'),
  custCsv: () => askSecret('Export customers', 'CSV files are not encrypted. Enter your password to continue.', customersCsv),
  ckPtsMax: () => { ck.pts = maxPts(); const i = $('#ckPts'); if (i) i.value = ck.pts; ckUpdate(); },
  poCancel: () => { if (!confirm('Cancel this order?')) return; POD.status = 'cancelled'; const k = db.pos.findIndex(x => x.id === POD.id); db.pos[k] = POD; persist('pos', POD); logEv('po', `Cancelled ${POD.no}`); closeModal(); render(); },
  poPrint: () => printLines(poLines(POD)),
  poShare: async () => { const t = poText(POD); try { if (navigator.share) await navigator.share({ title: POD.no, text: t }); else { await navigator.clipboard.writeText(t); toast('Copied to clipboard'); } } catch (e) {} },
  supList: () => supList(), supAdd: () => supplierForm(null, null), supEdit: d => supplierForm(d.id, null),
  supNewPo: () => { syncPo(); supplierForm(null, 'po'); }, supSave: d => saveSupplier(d.id),
  supDel: d => { if (!confirm('Delete this supplier? Past purchase orders keep the name.')) return; db.suppliers = db.suppliers.filter(x => x.id !== d.id); IDB.del('suppliers', d.id); supList(); },
  supBack: () => (supRet === 'po' && POD ? poSheet() : supRet === 'rcv' && RCV ? rcvSheet() : supList()),
  newCount: () => newCountSheet(), startCount: () => startCount(),
  cntOpen: d => { const c = db.counts.find(x => x.id === d.id); if (c.status === 'applied') countReport(c); else { cnt = c; cntQ = ''; cntF = 'all'; render(); } },
  cntExit: () => { clearTimeout(cntT); persist('counts', cnt); cnt = null; render(); },
  cntFilter: d => { cntF = d.f; render(); },
  cntSame: d => { const i = +d.i, inp = document.querySelector(`.cin[data-ci="${i}"]`); inp.value = cnt.lines[i].sys; cntSetCounted(i, cnt.lines[i].sys); },
  cntMatch: () => { if (!confirm('Mark every uncounted item as matching the system quantity?')) return; cnt.lines.forEach(l => { if (l.counted === null) l.counted = l.sys; }); cntSave(); updateCount(); },
  cntFinish: () => finishSheet(), cntApply: () => applyCount(),
  cntDiscard: () => { if (!confirm('Discard this count? Nothing will change in stock.')) return; db.counts = db.counts.filter(x => x.id !== cnt.id); IDB.del('counts', cnt.id); cnt = null; render(); },
  /* photos + logo */
  pickAv: d => { if (d.id !== me.id && !isAdmin()) return; avTarget = d.id; $('#avFile').click(); },
  rmAv: d => { if (d.id !== me.id && !isAdmin()) return; const u = uById(d.id); delete u.avatar; saveMeta(); render(); if (modalUser) userSheet(uById(modalUser)); },
  pickLogo: () => $('#logoFile').click(),
  rmLogo: () => { delete meta.logo; saveMeta(); render(); },
  dp: d => { dashP = d.p; render(); },
  repPrint: () => printLines(reportLines(rangeFor(dashP))),
  repCsv: () => askSecret('Export sales', 'CSV files are not encrypted. Enter your password to continue.', () => exportCsv(rangeFor(dashP))),
  repCsv2: () => askSecret('Export sales', 'CSV files are not encrypted. Enter your password to continue.', () => exportCsv(rangeFor(salesF))),
  export: () => exportBackup(),
  csv: () => askSecret('Export sales', 'CSV files are not encrypted. Enter your password to continue.', exportCsv),
  import: () => { restoreMode = false; $('#importFile').click(); },
  reset: () => askSecret('Erase all data', 'This deletes every item, sale and user on this device. Enter your password to confirm.', async () => {
    if (!confirm('Really erase everything? This cannot be undone.')) return;
    dek = null; IDB.db.close(); indexedDB.deleteDatabase('epos2').onsuccess = () => location.reload(); setTimeout(() => location.reload(), 1500);
  }),
  askOk: async () => {
    const u = meta.users.find(x => x.id === me.id); toast('Checking…');
    if (!(await tryUnwrap(u, $('#aPw').value))) return toast('Wrong password', true);
    const cb = askSecret.cb; closeModal(); cb();
  },
  /* login / setup */
  pick: d => { L = { sel: d.id || null, pin: '', busy: false, err: '' }; renderLogin(); },
  key: d => { if (L.busy || L.pin.length >= 6) return; L.pin += d.k; L.err = ''; renderLogin(); if (L.pin.length === 6) tryLogin(meta.users.find(u => u.id === L.sel), L.pin); },
  kdel: () => { if (!L.busy) { L.pin = L.pin.slice(0, -1); renderLogin(); } },
  unlockPw: () => { const u = meta.users.find(x => x.id === L.sel), v = $('#lpw').value; if (v) tryLogin(u, v); },
  createVault: () => createVault(),
  restore: () => { restoreMode = true; $('#importFile').click(); },
};
function exportCsv(R) {
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`, rows = [['Invoice', 'Date', 'Status', 'Cashier', 'Item', 'Qty', 'Price', 'Line total', 'Discount', 'Tax', 'Sale total', 'Payment']];
  db.sales.filter(s => !R || (s.ts >= R.from && s.ts <= R.to)).reverse().forEach(s => s.items.forEach((i, n) => rows.push([s.no, new Date(s.ts).toISOString(), s.void ? 'VOID' : 'OK', s.cashier ? s.cashier.name : '', i.name, i.qty, i.price, r2(i.price * i.qty), n ? '' : s.disc, n ? '' : s.tax, n ? '' : s.total, s.method])));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' }));
  a.download = `epos-sales-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); logEv('export', 'Exported sales CSV');
}
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (el) {
    const act = el.dataset.act;
    if ((ADMIN_ONLY.has(act) || ADMIN_RE.test(act)) && !isAdmin()) return toast('Administrator only', true);
    A[act] && A[act](el.dataset); return;
  }
  if (e.target.id === 'modal') closeModal();
});
document.addEventListener('input', e => {
  const t = e.target;
  if (!me) return;
  if (t.id === 'q') { q = t.value; updateGrid(); }
  else if (t.id === 'sq') { stockQ = t.value; updateStock(); }
  else if (t.id === 'ckDisc') { ck.disc = t.value; discount = +t.value || 0; ckUpdate(); }
  else if (t.id === 'ckRecv') { ck.recv = t.value; ckUpdate(); }
  else if (t.id === 'cuq') { cuQ = t.value; updateCust(); }
  else if (t.id === 'cpq') { cpQ = t.value; updateCp(); }
  else if (t.id === 'ckPts') { ck.pts = Math.max(0, parseInt(t.value) || 0); ckUpdate(); if (t.value !== '' && +t.value > ck.pts) t.value = ck.pts; }
  else if (t.dataset.rci !== undefined && RCV) { const n = +t.dataset.rci, it = RCV.items[n]; it[t.dataset.f] = Math.max(0, +t.value || 0); $('#rlt' + n).textContent = money(it.qty * it.cost); $('#rcTot').textContent = money(rcvTotal(RCV)); }
  else if (t.id === 'cq' && cnt) { cntQ = t.value; updateCount(); const i = $('#cq'); i.focus(); }
  else if (t.dataset.poi !== undefined && POD) {
    const n = +t.dataset.poi, it = POD.items[n]; it[t.dataset.f] = Math.max(0, +t.value || 0);
    $('#plt' + n).textContent = money(it.qty * it.cost); $('#poTot').textContent = money(poTotal(POD));
  } else if (t.classList.contains('cin') && cnt) { cntSetCounted(+t.dataset.ci, t.value === '' ? null : Math.max(0, parseInt(t.value) || 0)); }
});
document.addEventListener('keydown', e => {
  if (!me) { // login screen
    const u = meta && meta.users.find(x => x.id === L.sel);
    if (e.target.id === 'lpw' && e.key === 'Enter') A.unlockPw();
    else if (u && u.role !== 'admin' && /^\d$/.test(e.key)) A.key({ k: e.key });
    else if (u && u.role !== 'admin' && e.key === 'Backspace') A.kdel();
    return;
  }
  if (e.key === 'Enter' && e.target.id === 'q') { // barcode scanner behaves like a keyboard
    const hit = bySku(e.target.value.trim());
    const v = e.target.value.trim().toLowerCase(), mc = !hit && v && db.customers.find(c => (c.no || '').toLowerCase() === v || (c.phone && digits(c.phone) === digits(v) && digits(v).length >= 6));
    if (hit) { addToCart(hit.id); q = ''; e.target.value = ''; updateGrid(); }
    else if (mc) { custId = mc.id; q = ''; e.target.value = ''; updateGrid(); updateCart(); toast(`Customer: ${mc.name}`); }
    else if (v) toast('No item or customer with that code', true);
  }
  if (e.key === 'Enter' && e.target.id === 'aPw') A.askOk();
});
document.addEventListener('change', e => {
  const t = e.target;
  if (!me) return;
  if (t.id === 'rcAdd' && RCV && isAdmin()) {
    const v = t.value.trim().toLowerCase(), pr = db.products.find(x => (x.name + (x.sku ? ` (${x.sku})` : '')).toLowerCase() === v) || db.products.find(x => x.name.toLowerCase() === v);
    if (pr) { syncRcv(); if (!RCV.items.some(i => i.id === pr.id)) RCV.items.push({ id: pr.id, name: pr.name, qty: suggestQty(pr), cost: pr.cost || 0 }); rcvSheet(); setTimeout(() => { const i = $('#rcAdd'); i && i.focus(); }, 60); }
    else if (v) toast('Item not found', true);
  } else if (t.id === 'poAdd' && POD && isAdmin()) {
    const v = t.value.trim().toLowerCase(), pr = db.products.find(x => (x.name + (x.sku ? ` (${x.sku})` : '')).toLowerCase() === v) || db.products.find(x => x.name.toLowerCase() === v);
    if (pr) { syncPo(); if (!POD.items.some(i => i.id === pr.id)) POD.items.push({ id: pr.id, name: pr.name, qty: suggestQty(pr), cost: pr.cost || 0 }); poSheet(); setTimeout(() => { const i = $('#poAdd'); i && i.focus(); }, 60); }
    else if (v) toast('Item not found', true);
  } else if (t.dataset.set) {
    if (!isAdmin()) return;
    const k = t.dataset.set; S()[k] = t.type === 'checkbox' ? t.checked : ['dec', 'tax', 'paper', 'cashDiscMax', 'earnPer', 'ptValue', 'minRedeem'].includes(k) ? +t.value || 0 : t.value; saveVault();
    if (k === 'store') { meta.store = t.value; saveMeta(); }
    if (['method', 'paper', 'dec', 'cur', 'store', 'loyaltyOn', 'earnPer', 'ptValue'].includes(k)) render();
  } else if (t.dataset.meta && isAdmin()) { meta[t.dataset.meta] = +t.value; saveMeta(); bump(); }
});
$('#imgFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !isAdmin() || !$('#pPrev')) return;
  try { imgDraft = await resizeImg(f); $('#pPrev').innerHTML = `<img src="${imgDraft}" alt="">`; } catch (err) { toast('Could not read that image', true); }
});
$('#avFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; const u = f && uById(avTarget); if (!u || (u.id !== me.id && !isAdmin())) return;
  try { u.avatar = await resizeImg(f, 220); await saveMeta(); render(); if (modalUser) userSheet(uById(modalUser)); toast('Photo updated'); } catch (err) { toast('Could not read that image', true); }
});
$('#logoFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f || !isAdmin()) return;
  try { meta.logo = await resizeFit(f); await saveMeta(); render(); toast('Logo updated'); } catch (err) { toast('Could not read that image', true); }
});
$('#importFile').addEventListener('change', e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (me && !isAdmin()) return toast('Administrator only', true);
  importBackup(f);
});

document.addEventListener('visibilitychange', () => { if (document.hidden) closeScanner(); }); // release the camera when the app is backgrounded
/* ---------- boot ---------- */
(async function boot() {
  if (!window.crypto || !crypto.subtle) { $('#main').innerHTML = '<div class="empty">A secure (HTTPS) connection is required.<br>Open the app from its https:// address.</div>'; return; }
  try { await IDB.open(); meta = await IDB.get('kv', 'users'); syncSt = (await IDB.get('kv', 'sync')) || { deviceId: uid(), dirty: [], last: 0, err: '', srv: '', seeded: false }; syncSt.err = ''; syncSt.dirty = syncSt.dirty || []; credStore = (await IDB.get('kv', 'creds')) || {}; } catch (e) { $('#main').innerHTML = '<div class="empty">Storage is unavailable.<br>Turn off private/incognito mode.</div>'; return; }
  sbClient(); const has = () => meta && meta.users && meta.users.length;
  if (AUTH_URL.recovery) { // reset-email link: let the user choose a new password first
    if (await shopSession()) return showNewPassword();
    return showShopLogin('This reset link is invalid or has expired. Request a new one in Supabase.');
  }
  if (AUTH_URL.err) { try { history.replaceState(null, '', location.pathname); } catch (e) {} return showShopLogin(AUTH_URL.err); }
  let signed = !!(await shopSession());
  if (!signed && has() && !navigator.onLine) signed = true;            // offline start of a device that already holds the data
  if (!signed && !has() && localStorage.getItem('epos.shop') && !navigator.onLine) { $('#main').innerHTML = '<div class="empty">No internet.<br>Connect once to load the shop data.</div>'; return; }
  if (!signed) showShopLogin(has() ? 'Sign in to the shop once to turn on live sync for this device.' : '');
  else {
    if (!has() && navigator.onLine) { try { await syncPull(); } catch (e) { return showShopLogin('Could not load shop data: ' + e.message); } }
    sbSubscribe(); has() ? showLogin() : showSetup();
  }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
})();
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
