const { app, BrowserWindow, ipcMain, screen, Tray, Menu, globalShortcut, nativeImage, clipboard, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const Sync = require('./sync.js');
const { Cloud } = require('./cloud.js');

// Only one copy of the widget at a time.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const TAB_W = 48;
const TAB_H = 58;
const GRIP_H = 14;           // top strip of the tab: drag handle, hovering it does not open the calendar
const SNAP_PX = 28;          // dropping the tab this close to a screen edge snaps it flush
const POLL_MS = 70;
const OPEN_DELAY_MS = 160;   // cursor must rest on the tab this long before it slides out
const CLOSE_DELAY_MS = 450;  // cursor must be away this long before it slides back

let win = null;
let tray = null;
let state = 'collapsed';     // 'collapsed' | 'expanding' | 'expanded' | 'collapsing'
let pinned = false;          // pinned open by the user
let holdOpen = false;        // renderer has a dialog open
let drag = null;             // { origin, cursor, timer } while the tab is being dragged
let insideSince = 0;
let outsideSince = 0;
let anim = null;

const dataFile = () => path.join(app.getPath('userData'), 'calendar-data.json');

function defaultData() {
  return {
    version: 2,
    settings: {
      weekStart: 1, hour12: false, dayStartHour: 7, monthFrom: 6, monthTo: 24, theme: 'auto',
      edge: 'right', tabPos: 0.35, // only used to place the tab the first time
    },
    categories: [
      { id: 'work', name: 'Work', color: '#4f7cff' },
      { id: 'personal', name: 'Personal', color: '#34c77b' },
      { id: 'study', name: 'Study', color: '#b06cff' },
      { id: 'health', name: 'Health', color: '#ff9f43' },
      { id: 'social', name: 'Social', color: '#ff5d8f' },
    ],
    events: [],
    tasks: [],
  };
}

function loadData() {
  const file = dataFile();
  try {
    const text = fs.readFileSync(file, 'utf8');
    const raw = JSON.parse(text);
    // One-time safety copy of the data from before this version.
    const backup = file.replace(/\.json$/, '.backup-v1.json');
    if ((raw.version || 1) < 2 && !fs.existsSync(backup)) fs.writeFileSync(backup, text);
    const d = defaultData();
    return { ...d, ...raw, version: 2, settings: { ...d.settings, ...(raw.settings || {}) } };
  } catch {
    return defaultData();
  }
}

let data = loadData();
// Make sure everything carries a change time, so syncing can tell old from new.
Sync.stamp(Sync.clone(data), data);
let rev = 1; // goes up whenever data changes from outside the page (a sync)

function writeData() {
  const file = dataFile();
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/* ---------------- geometry ---------------- */

function defaultTabPos() {
  const wa = screen.getPrimaryDisplay().workArea;
  const y = wa.y + Math.round(wa.height * clamp(Number(data.settings.tabPos) || 0.35, 0.05, 0.95)) - TAB_H / 2;
  const x = data.settings.edge === 'left' ? wa.x : wa.x + wa.width - TAB_W;
  return { x, y: clamp(y, wa.y, wa.y + wa.height - TAB_H) };
}

function onSomeDisplay(x, y) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return x + TAB_W / 2 >= a.x && x + TAB_W / 2 <= a.x + a.width && y + TAB_H / 2 >= a.y && y + TAB_H / 2 <= a.y + a.height;
  });
}

function tabRect() {
  let { tabX: x, tabY: y } = data.settings;
  if (typeof x !== 'number' || typeof y !== 'number' || !onSomeDisplay(x, y)) {
    ({ x, y } = defaultTabPos());
  }
  return { x: Math.round(x), y: Math.round(y), width: TAB_W, height: TAB_H };
}

function workAreaFor(rect) {
  return screen.getDisplayMatching(rect).workArea;
}

function panelSize(wa) {
  return { w: Math.min(1120, wa.width - 24), h: Math.min(900, wa.height - 16) };
}

// Where the open calendar goes: it grows from the tab toward the middle of the screen.
function panelLayout() {
  const tab = tabRect();
  const wa = workAreaFor(tab);
  const { w, h } = panelSize(wa);
  const growLeft = tab.x + TAB_W / 2 > wa.x + wa.width / 2;
  let x = growLeft ? tab.x + TAB_W - w : tab.x;
  x = clamp(x, wa.x, wa.x + wa.width - w);
  const y = clamp(Math.round(tab.y + TAB_H / 2 - h / 2), wa.y, wa.y + wa.height - h);
  return { bounds: { x, y, width: w, height: h }, anchor: growLeft ? 'right' : 'left', panel: { w, h } };
}

function sendMode(mode) {
  if (win && !win.isDestroyed()) {
    const l = panelLayout();
    win.webContents.send('mode', { mode, anchor: l.anchor, panel: l.panel, pinned });
  }
}

/* ---------------- open / close ---------------- */

function animateTo(target, done) {
  if (anim) clearInterval(anim);
  const from = win.getBounds();
  const steps = 7;
  let i = 0;
  anim = setInterval(() => {
    i++;
    const t = 1 - Math.pow(1 - i / steps, 3); // ease-out
    win.setBounds({
      x: Math.round(from.x + (target.x - from.x) * t),
      y: Math.round(from.y + (target.y - from.y) * t),
      width: Math.round(from.width + (target.width - from.width) * t),
      height: Math.round(from.height + (target.height - from.height) * t),
    });
    if (i >= steps) {
      clearInterval(anim);
      anim = null;
      win.setBounds(target);
      done && done();
    }
  }, 16);
}

function expand() {
  scheduleSync(0);
  if (drag || state === 'expanded' || state === 'expanding') return;
  state = 'expanding';
  sendMode('expanded');
  animateTo(panelLayout().bounds, () => {
    state = 'expanded';
    outsideSince = 0;
  });
}

function collapse() {
  if (state === 'collapsed' || state === 'collapsing') return;
  state = 'collapsing';
  animateTo(tabRect(), () => {
    state = 'collapsed';
    insideSince = 0;
    sendMode('collapsed');
    if (win.isFocused()) win.blur();
  });
}

function snap() {
  // Re-place the window right away (after a setting or screen change).
  if (anim) { clearInterval(anim); anim = null; }
  const mode = state === 'expanded' || state === 'expanding' ? 'expanded' : 'collapsed';
  state = mode;
  win.setBounds(mode === 'expanded' ? panelLayout().bounds : tabRect());
  sendMode(mode);
}

function cursorIn(b, p, m = 2) {
  return p.x >= b.x - m && p.x <= b.x + b.width + m && p.y >= b.y - m && p.y <= b.y + b.height + m;
}

function poll() {
  if (!win || win.isDestroyed() || drag) return;
  const now = Date.now();
  const p = screen.getCursorScreenPoint();
  const b = win.getBounds();
  if (state === 'collapsed') {
    // Only the date part of the tab opens it; the grip strip on top is for dragging.
    const hot = { x: b.x, y: b.y + GRIP_H, width: b.width, height: b.height - GRIP_H };
    if (cursorIn(hot, p, 0)) {
      if (!insideSince) insideSince = now;
      if (now - insideSince >= OPEN_DELAY_MS) expand();
    } else {
      insideSince = 0;
    }
  } else if (state === 'expanded') {
    if (cursorIn(b, p) || pinned || holdOpen) {
      outsideSince = 0;
    } else {
      if (!outsideSince) outsideSince = now;
      if (now - outsideSince >= CLOSE_DELAY_MS) collapse();
    }
  }
}

/* ---------------- dragging the tab ---------------- */

function dragStart() {
  if (state !== 'collapsed' || drag) return;
  const b = win.getBounds();
  drag = { origin: { x: b.x, y: b.y }, cursor: screen.getCursorScreenPoint() };
  drag.timer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    win.setBounds({ x: drag.origin.x + p.x - drag.cursor.x, y: drag.origin.y + p.y - drag.cursor.y, width: TAB_W, height: TAB_H });
  }, 12);
}

function dragEnd() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  const b = win.getBounds();
  const wa = workAreaFor(b);
  let x = clamp(b.x, wa.x, wa.x + wa.width - TAB_W);
  let y = clamp(b.y, wa.y, wa.y + wa.height - TAB_H);
  if (x - wa.x < SNAP_PX) x = wa.x;
  if (wa.x + wa.width - TAB_W - x < SNAP_PX) x = wa.x + wa.width - TAB_W;
  if (y - wa.y < SNAP_PX) y = wa.y;
  if (wa.y + wa.height - TAB_H - y < SNAP_PX) y = wa.y + wa.height - TAB_H;
  data.settings.tabX = x;
  data.settings.tabY = y;
  writeData();
  win.setBounds({ x, y, width: TAB_W, height: TAB_H });
  insideSince = 0;
  sendMode('collapsed');
}

function resetTab() {
  delete data.settings.tabX;
  delete data.settings.tabY;
  data.settings.edge = 'right';
  writeData();
  snap();
}

/* ---------------- tray and settings ---------------- */

function setPinned(v) {
  pinned = v;
  if (pinned) expand();
  sendMode(state === 'collapsed' ? 'collapsed' : 'expanded');
  buildTrayMenu();
}

// The portable .exe unpacks itself to a temp folder, so point Windows at the real .exe instead.
const loginOpts = () => (process.env.PORTABLE_EXECUTABLE_FILE ? { path: process.env.PORTABLE_EXECUTABLE_FILE } : {});
const isLoginItem = () => app.getLoginItemSettings(loginOpts()).openAtLogin;

function setLogin(on) {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: on, ...loginOpts() });
  }
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: pinned ? 'Unpin (auto-hide)' : 'Pin open', click: () => setPinned(!pinned) },
    { label: 'Move tab back to the right edge', click: resetTab },
    { type: 'separator' },
    { label: 'Start with Windows', type: 'checkbox', checked: isLoginItem(), click: (item) => setLogin(item.checked) },
    { type: 'separator' },
    { label: 'Quit Hover Calendar', click: () => app.quit() },
  ]));
}

function createWindow() {
  win = new BrowserWindow({
    ...tabRect(),
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#161a22',
    title: 'Hover Calendar',
    icon: path.join(__dirname, 'tray.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    win.showInactive();
    sendMode('collapsed');
  });
  // Keep it above other windows even after something else grabs "topmost".
  win.on('blur', () => win.setAlwaysOnTop(true, 'screen-saver'));
  setInterval(poll, POLL_MS);
}

ipcMain.handle('load', () => ({ doc: data, rev, loginItem: isLoginItem() }));
ipcMain.on('save', (_e, next, baseRev) => {
  // The tab position is owned here; never let an older copy from the page overwrite it.
  const { tabX, tabY } = data.settings;
  next.settings = { ...next.settings, tabX, tabY };
  if (tabX === undefined) delete next.settings.tabX;
  if (tabY === undefined) delete next.settings.tabY;
  if (baseRev === rev) {
    data = next;
  } else {
    // The page saved on top of an older copy (a sync landed meanwhile): merge, don't overwrite.
    data = Sync.merge(next, data);
    replaced();
  }
  writeData();
  scheduleSync(1500);
});

/* ---------------- cloud sync ---------------- */

const syncFile = () => path.join(app.getPath('userData'), 'sync.json');
let cloud = null;
let syncTimer = null;
let syncing = false;
let syncAgain = false;
let syncState = { status: 'off', at: 0, error: '' };

function loadSyncConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(syncFile(), 'utf8'));
    let session = null;
    if (cfg.session) {
      const raw = Buffer.from(cfg.session, 'base64');
      session = JSON.parse(cfg.encrypted && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8'));
    }
    return { url: cfg.url, key: cfg.key, session };
  } catch {
    return null;
  }
}

function saveSyncConfig(url, key, session) {
  const enc = session && safeStorage.isEncryptionAvailable();
  const raw = session ? (enc ? safeStorage.encryptString(JSON.stringify(session)) : Buffer.from(JSON.stringify(session))) : null;
  fs.writeFileSync(syncFile(), JSON.stringify({ url, key, encrypted: !!enc, session: raw ? raw.toString('base64') : null }, null, 2));
}

function makeCloud(url, key, session) {
  return new Cloud({ url, key, session, onSession: (sess) => saveSyncConfig(url, key, sess) });
}

function setSyncState(patch) {
  syncState = { ...syncState, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('sync-state', syncState);
}

function replaced() {
  rev++;
  if (win && !win.isDestroyed()) win.webContents.send('data-replaced', { doc: data, rev });
}

function scheduleSync(ms = 0) {
  if (!cloud || !cloud.session) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, ms);
}

async function syncNow() {
  if (process.env.HC_DEBUG) console.error('syncNow', !!cloud, cloud && !!cloud.session);
  if (!cloud || !cloud.session) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSyncState({ status: 'syncing' });
  try {
    const row = await cloud.pull();
    if (process.env.HC_DEBUG) console.error('pulled', !!row);
    const remote = row && row.data;
    const merged = Sync.merge(data, remote);
    if (!Sync.same(merged, data)) {
      data = merged;
      writeData();
      replaced();
    }
    if (!remote || !Sync.same(Sync.forCloud(data), remote)) await cloud.push(Sync.forCloud(data));
    setSyncState({ status: 'ok', at: Date.now(), error: '' });
  } catch (err) {
    const signedOut = err.status === 400 || err.status === 401;
    if (signedOut && /refresh|token|jwt|session/i.test(err.message)) {
      cloud.signOut();
      setSyncState({ status: 'signed-out', error: 'Please sign in again.' });
    } else {
      if (process.env.HC_DEBUG) console.error('sync error', err);
      setSyncState({ status: 'error', error: err.message || String(err) });
    }
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; scheduleSync(500); }
  }
}

ipcMain.handle('sync-state', () => {
  const cfg = loadSyncConfig();
  return { ...syncState, url: cfg && cfg.url, key: cfg && cfg.key, email: cloud && cloud.session && cloud.session.email };
});
ipcMain.handle('sync-connect', async (_e, { url, key, email, password }) => {
  try {
    const c = makeCloud(url, key, null);
    await c.signIn(email, password);
    cloud = c;
    await syncNow();
    return { ok: true, state: syncState };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});
ipcMain.handle('sync-disconnect', () => {
  if (cloud) cloud.signOut();
  cloud = null;
  setSyncState({ status: 'off', error: '' });
  return true;
});
ipcMain.on('sync-now', () => scheduleSync(0));
ipcMain.on('hold-open', (_e, v) => { holdOpen = !!v; if (holdOpen) expand(); });
ipcMain.on('set-pinned', (_e, v) => setPinned(!!v));
ipcMain.on('expand', () => expand());
ipcMain.on('collapse', () => { pinned = false; buildTrayMenu(); collapse(); });
ipcMain.on('drag-start', dragStart);
ipcMain.on('drag-end', dragEnd);
ipcMain.on('reset-tab', resetTab);
ipcMain.on('set-login', (_e, v) => setLogin(!!v));
ipcMain.on('quit', () => app.quit());

// ---- sharing ----
async function grab(rect) {
  const r = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  return win.webContents.capturePage(r);
}
ipcMain.handle('capture-copy', async (_e, rect) => {
  clipboard.writeImage(await grab(rect));
  return true;
});
ipcMain.handle('capture-save', async (_e, rect, name) => {
  const img = await grab(rect);
  const res = await dialog.showSaveDialog(win, {
    title: 'Save picture', defaultPath: path.join(app.getPath('pictures'), name), filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, img.toPNG());
  shell.showItemInFolder(res.filePath);
  return res.filePath;
});
ipcMain.handle('save-text', async (_e, text, name, filterName, ext) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save file', defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: filterName, extensions: [ext] }],
  });
  if (res.canceled || !res.filePath) return null;
  fs.writeFileSync(res.filePath, text);
  shell.showItemInFolder(res.filePath);
  return res.filePath;
});

app.on('second-instance', () => setPinned(true));

app.whenReady().then(() => {
  const cfg = loadSyncConfig();
  if (cfg && cfg.url && cfg.key && cfg.session) {
    cloud = makeCloud(cfg.url, cfg.key, cfg.session);
    setTimeout(syncNow, 1500);
  }
  // Check for changes from the phone every minute.
  setInterval(() => scheduleSync(0), 60 * 1000);
  if (process.platform === 'win32') app.setAppUserModelId('com.hovercalendar.app');
  createWindow();

  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.setToolTip('Hover Calendar');
  tray.on('click', () => setPinned(!pinned));
  buildTrayMenu();

  // Ctrl+Alt+C pins / unpins the calendar from the keyboard.
  globalShortcut.register('CommandOrControl+Alt+C', () => setPinned(!pinned));

  screen.on('display-metrics-changed', snap);
  screen.on('display-added', snap);
  screen.on('display-removed', snap);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
