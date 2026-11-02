// Hover Calendar week widget for Scriptable (iPhone).
// 1. Install "Scriptable" from the App Store.
// 2. Make a new script, paste all of this in, and run it once inside Scriptable to sign in.
// 3. Add a Scriptable widget to your home screen (Large looks best), long-press it,
//    choose "Edit Widget", and pick this script.

const SUPABASE_URL = 'https://vazwaoiugxvvljerbdoq.supabase.co';
const SUPABASE_KEY = 'sb_publishable_A5WnzMAGYRWxLaAcGDFiyg_17_MtnGF';
const APP_URL = 'https://kwongyusun.github.io/hover-calendar/';

const KC = 'hover-calendar-session';
const CACHE = FileManager.local().joinPath(FileManager.local().documentsDirectory(), 'hover-calendar-cache.json');

// ---------- sign-in and download ----------

async function auth(grant, body) {
  const r = new Request(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`);
  r.method = 'POST';
  r.headers = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  r.body = JSON.stringify(body);
  const j = await r.loadJSON();
  if (!j.access_token) throw new Error(j.error_description || j.msg || 'Sign-in failed');
  const s = {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    user_id: j.user.id,
  };
  Keychain.set(KC, JSON.stringify(s));
  return s;
}

async function session() {
  if (Keychain.contains(KC)) {
    const s = JSON.parse(Keychain.get(KC));
    if (s.expires_at - 120 > Date.now() / 1000) return s;
    try { return await auth('refresh_token', { refresh_token: s.refresh_token }); } catch (e) { if (config.runsInWidget) throw e; }
  }
  if (config.runsInWidget) throw new Error('Open Scriptable and run this script once to sign in.');
  const a = new Alert();
  a.title = 'Sign in to Hover Calendar';
  a.message = 'Use the same email and password as on your PC.';
  a.addTextField('Email');
  a.addSecureTextField('Password');
  a.addAction('Sign in');
  a.addCancelAction('Cancel');
  if ((await a.presentAlert()) === -1) throw new Error('Sign-in cancelled');
  return auth('password', { email: a.textFieldValue(0).trim(), password: a.textFieldValue(1) });
}

async function loadCalendar() {
  try {
    const s = await session();
    const r = new Request(`${SUPABASE_URL}/rest/v1/calendars?select=data&user_id=eq.${s.user_id}`);
    r.headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${s.access_token}` };
    const rows = await r.loadJSON();
    if (!Array.isArray(rows)) throw new Error(rows.message || 'Could not download');
    const data = rows[0] ? rows[0].data : { events: [], categories: [], tasks: [], settings: {} };
    FileManager.local().writeString(CACHE, JSON.stringify(data));
    return { data, offline: false };
  } catch (err) {
    if (FileManager.local().fileExists(CACHE)) return { data: JSON.parse(FileManager.local().readString(CACHE)), offline: true, error: err.message };
    throw err;
  }
}

// ---------- dates and repeats (same rules as the app) ----------

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
const weekday = (s) => parse(s).getDay();
const weekNum = (s) => Math.floor((dayNum(s) + 3) / 7);
const toMin = (t) => { if (!t) return 0; const [h, m] = t.split(':').map(Number); return h * 60 + m; };

function occursOn(ev, s) {
  if (s < ev.date) return false;
  const r = ev.repeat || { freq: 'none' };
  if (r.until && s > r.until) return false;
  if (ev.exdates && ev.exdates.includes(s)) return false;
  const n = Math.max(1, Number(r.interval) || 1);
  switch (r.freq) {
    case 'daily': return (dayNum(s) - dayNum(ev.date)) % n === 0;
    case 'weekdays': { const wd = weekday(s); return wd >= 1 && wd <= 5; }
    case 'weekly': {
      const days = r.days && r.days.length ? r.days : [weekday(ev.date)];
      if (!days.includes(weekday(s))) return false;
      return (weekNum(s) - weekNum(ev.date)) % n === 0;
    }
    case 'monthly': {
      const a = parse(ev.date), b = parse(s);
      if (a.getDate() !== b.getDate()) return false;
      return ((b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())) % n === 0;
    }
    case 'yearly': {
      const a = parse(ev.date), b = parse(s);
      if (a.getDate() !== b.getDate() || a.getMonth() !== b.getMonth()) return false;
      return (b.getFullYear() - a.getFullYear()) % n === 0;
    }
    default: return s === ev.date;
  }
}

// ---------- drawing ----------

const dark = Device.isUsingDarkAppearance();
const C = dark
  ? { bg: '#161a22', line: '#2a303c', text: '#e8ebf1', muted: '#8f98a8', today: '#4f7cff', now: '#ff5d5d', tint: '#1e2533' }
  : { bg: '#ffffff', line: '#e3e7ee', text: '#1d2330', muted: '#6b7486', today: '#4f7cff', now: '#e5484d', tint: '#eef3ff' };
const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function textOn(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  if (Number.isNaN(n)) return '#ffffff';
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#1a1d24' : '#ffffff';
}

function roundRect(ctx, x, y, w, h, r, color) {
  const p = new Path();
  p.addRoundedRect(new Rect(x, y, w, h), r, r);
  ctx.addPath(p);
  ctx.setFillColor(new Color(color));
  ctx.fillPath();
}

function text(ctx, str, x, y, w, h, { size = 9, color = C.text, bold = false, align = 'left' } = {}) {
  ctx.setFont(bold ? Font.semiboldSystemFont(size) : Font.systemFont(size));
  ctx.setTextColor(new Color(color));
  if (align === 'center') ctx.setTextAlignedCenter(); else if (align === 'right') ctx.setTextAlignedRight(); else ctx.setTextAlignedLeft();
  ctx.drawTextInRect(str, new Rect(x, y, w, h));
}

function drawWeek(data, W, H) {
  const s = data.settings || {};
  const catColor = (id) => ((data.categories || []).find((c) => c.id === id) || { color: '#7d8597' }).color;
  const today = ymd(new Date());
  const ws = Number(s.weekStart ?? 1);
  const start = addDays(today, -((weekday(today) - ws + 7) % 7));
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const events = data.events || [];
  const tasks = (data.tasks || []).filter((t) => !t.done && t.date);

  // Hours shown: from the "scroll to" hour, widened to fit this week's events.
  let from = Number(s.dayStartHour ?? 7), to = 22;
  for (const d of days) for (const ev of events) {
    if (ev.allDay || !occursOn(ev, d)) continue;
    from = Math.min(from, Math.floor(toMin(ev.start) / 60));
    to = Math.max(to, Math.ceil(Math.max(toMin(ev.end), toMin(ev.start) + 30) / 60));
  }
  to = Math.min(24, to);

  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const gutter = 16, headH = 26, topPad = 2;
  const allDayRows = Math.max(0, ...days.map((d) => events.filter((e) => e.allDay && occursOn(e, d)).length + tasks.filter((t) => t.date === d).length));
  const allH = Math.min(2, allDayRows) * 11;
  const gridTop = headH + allH + topPad;
  const colW = (W - gutter) / 7;
  const hourH = (H - gridTop - 2) / (to - from);

  // day headers
  days.forEach((d, i) => {
    const x = gutter + i * colW;
    if (d === today) {
      roundRect(ctx, x + 1, gridTop, colW - 2, H - gridTop, 4, C.tint);
      roundRect(ctx, x + colW / 2 - 9, 11, 18, 14, 7, C.today);
    }
    text(ctx, WD[weekday(d)], x, 0, colW, 11, { size: 8, color: C.muted, align: 'center' });
    text(ctx, String(parse(d).getDate()), x, 11, colW, 14, { size: 10, bold: true, color: d === today ? '#ffffff' : C.text, align: 'center' });
  });

  // hour lines and labels
  for (let hr = from; hr <= to; hr++) {
    const y = gridTop + (hr - from) * hourH;
    ctx.setFillColor(new Color(C.line));
    ctx.fillRect(new Rect(gutter, y, W - gutter, 0.5));
    if ((hr - from) % 3 === 0 && hr < to) text(ctx, String(hr), 0, y - 1, gutter - 3, 9, { size: 7, color: C.muted, align: 'right' });
  }

  // all-day events and planned tasks
  days.forEach((d, i) => {
    const x = gutter + i * colW + 1;
    const items = [
      ...events.filter((e) => e.allDay && occursOn(e, d)).map((e) => ({ title: e.title, color: catColor(e.category), task: false })),
      ...tasks.filter((t) => t.date === d).map((t) => ({ title: '☐ ' + t.title, color: catColor(t.category), task: true })),
    ].slice(0, 2);
    items.forEach((it, k) => {
      const y = headH + k * 11;
      roundRect(ctx, x, y, colW - 2, 10, 2, it.color);
      text(ctx, it.title, x + 2, y, colW - 4, 10, { size: 7, color: textOn(it.color) });
    });
  });

  // timed events, side by side when they overlap
  days.forEach((d, i) => {
    const list = events.filter((e) => !e.allDay && occursOn(e, d))
      .map((e) => ({ e, s: Math.max(toMin(e.start), from * 60), en: Math.min(Math.max(toMin(e.end), toMin(e.start) + 15), to * 60) }))
      .sort((a, b) => a.s - b.s || b.en - a.en);
    let cluster = [], ends = [], clusterEnd = -1;
    const flush = () => { cluster.forEach((it) => { it.cols = ends.length; }); cluster = []; ends = []; };
    for (const it of list) {
      if (it.s >= clusterEnd && cluster.length) flush();
      let c = ends.findIndex((x) => x <= it.s);
      if (c === -1) { c = ends.length; ends.push(it.en); } else ends[c] = it.en;
      it.col = c; cluster.push(it); clusterEnd = Math.max(clusterEnd, it.en);
    }
    flush();
    for (const it of list) {
      const w = (colW - 2) / it.cols;
      const x = gutter + i * colW + 1 + it.col * w;
      const y = gridTop + ((it.s - from * 60) / 60) * hourH;
      const h = Math.max(4, ((it.en - it.s) / 60) * hourH - 1);
      const color = catColor(it.e.category);
      roundRect(ctx, x, y, w - 1, h, 2.5, color);
      if (h >= 9 && w >= 12) text(ctx, it.e.title || '', x + 1.5, y + 0.5, w - 3, h - 1, { size: 7, color: textOn(color) });
    }
  });

  // now line
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const ti = days.indexOf(today);
  if (ti >= 0 && nowMin >= from * 60 && nowMin <= to * 60) {
    const y = gridTop + ((nowMin - from * 60) / 60) * hourH;
    ctx.setFillColor(new Color(C.now));
    ctx.fillRect(new Rect(gutter + ti * colW, y - 0.75, colW, 1.5));
  }
  return ctx.getImage();
}

function todayList(data, w) {
  const today = ymd(new Date());
  const catColor = (id) => ((data.categories || []).find((c) => c.id === id) || { color: '#7d8597' }).color;
  const items = (data.events || []).filter((e) => occursOn(e, today))
    .sort((a, b) => (a.allDay ? -1 : toMin(a.start)) - (b.allDay ? -1 : toMin(b.start)));
  const head = w.addText(new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric' }));
  head.font = Font.semiboldSystemFont(13);
  head.textColor = new Color(C.today);
  w.addSpacer(4);
  if (!items.length) { const t = w.addText('Nothing planned'); t.font = Font.systemFont(11); t.textColor = new Color(C.muted); }
  for (const e of items.slice(0, 5)) {
    const row = w.addStack();
    row.centerAlignContent();
    const bar = row.addStack();
    bar.size = new Size(3, 12);
    bar.backgroundColor = new Color(catColor(e.category));
    bar.cornerRadius = 1.5;
    row.addSpacer(5);
    const t = row.addText(`${e.allDay ? '' : e.start + ' '}${e.title}`);
    t.font = Font.systemFont(11);
    t.textColor = new Color(C.text);
    t.lineLimit = 1;
    w.addSpacer(3);
  }
}

// ---------- main ----------

const w = new ListWidget();
w.backgroundColor = new Color(C.bg);
w.url = APP_URL;
w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
const family = config.widgetFamily || 'large';
try {
  const { data, offline } = await loadCalendar();
  if (family === 'small') {
    w.setPadding(12, 12, 12, 12);
    todayList(data, w);
  } else {
    w.setPadding(8, 8, 8, 8);
    const size = family === 'medium' ? new Size(330, 140) : new Size(330, 330);
    const img = w.addImage(drawWeek(data, size.width, size.height));
    img.centerAlignImage();
    if (offline) { const t = w.addText('offline'); t.font = Font.systemFont(7); t.textColor = new Color(C.muted); }
  }
} catch (err) {
  const t = w.addText(err.message || String(err));
  t.font = Font.systemFont(11);
  t.textColor = new Color(C.muted);
}

if (config.runsInWidget) Script.setWidget(w);
else await (family === 'small' ? w.presentSmall() : family === 'medium' ? w.presentMedium() : w.presentLarge());
Script.complete();
