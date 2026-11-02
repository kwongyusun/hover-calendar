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

// Same colour themes as the app: [background, surface, raised, lines, text, muted, accent, now, dark?]
const THEMES = {"midnight":["#161a22","#1d222c","#252b37","#2c3340","#e8ebf1","#8f98a8","#4f7cff","#ff5d5d",1],"nord":["#2e3440","#353c4a","#3b4252","#4c566a","#eceff4","#a3abbb","#88c0d0","#bf616a",1],"dracula":["#282a36","#2f3140","#3a3c4e","#44475a","#f8f8f2","#a0a4c4","#bd93f9","#ff5555",1],"tokyo":["#1a1b26","#1f2335","#292e42","#2f334d","#c0caf5","#8189b3","#7aa2f7","#f7768e",1],"mocha":["#1e1e2e","#262637","#313244","#45475a","#cdd6f4","#a6adc8","#cba6f7","#f38ba8",1],"gruvbox":["#282828","#32302f","#3c3836","#504945","#ebdbb2","#a89984","#83a598","#fb4934",1],"onedark":["#282c34","#2f343e","#3a3f4b","#3e4451","#dcdfe4","#9da5b4","#61afef","#e06c75",1],"soldark":["#002b36","#073642","#0d4250","#1a4f5c","#eee8d5","#93a1a1","#268bd2","#dc322f",1],"monokai":["#272822","#2f302a","#3b3c35","#49483e","#f8f8f2","#a59f85","#a6e22e","#f92672",1],"rosepine":["#191724","#1f1d2e","#26233a","#403d52","#e0def4","#908caa","#c4a7e7","#eb6f92",1],"everforest":["#2d353b","#343f44","#3d484d","#475258","#d3c6aa","#9da9a0","#a7c080","#e67e80",1],"kanagawa":["#1f1f28","#2a2a37","#363646","#54546d","#dcd7ba","#9a9a8e","#7e9cd8","#ff5d62",1],"ayumirage":["#1f2430","#242936","#2d3343","#343b4c","#cccac2","#8a9199","#ffcc66","#f28779",1],"synthwave":["#241b2f","#2a2139","#34294f","#463465","#f4eeff","#a99bc9","#ff7edb","#fe4450",1],"cyberpunk":["#0d0221","#150734","#1f0f47","#2e1a63","#f3f0ff","#a69cd0","#00f0ff","#ff2a6d",1],"oceanic":["#0f1c2e","#14243a","#1c3049","#24405d","#e3edf7","#8ea6c0","#2ec4b6","#ff6b6b",1],"forest":["#14201a","#1a2a22","#22352b","#2d4437","#e4efe6","#94ae9d","#52b788","#e76f51",1],"matcha":["#1b201a","#222921","#2b3329","#3a4537","#e8eddc","#a3ad96","#9bc53d","#e4572e",1],"ember":["#1c1412","#251a17","#30221d","#43302a","#f3e6df","#b39a8f","#ff7849","#ff4d4d",1],"espresso":["#1e1915","#26201b","#312922","#40362d","#efe4d6","#ab9b88","#c8a27a","#e26d5c",1],"amethyst":["#1a1625","#211c30","#2a2440","#3a3256","#ece8f7","#a49cc0","#9d7cff","#ff6b8b",1],"cherry":["#1f1418","#28191f","#342029","#4a2c39","#f7e9ee","#b9939f","#ff4f81","#ff4f4f",1],"aurora":["#0b1622","#10202f","#162a3d","#21384f","#e6f4f1","#8fb3b0","#4ade80","#f472b6",1],"graphite":["#18181b","#1f1f23","#27272a","#3f3f46","#f4f4f5","#a1a1aa","#d4d4d8","#f87171",1],"oled":["#000000","#0a0a0a","#151515","#262626","#f5f5f5","#9a9a9a","#3b82f6","#ef4444",1],"navygold":["#0e1726","#142036","#1b2a45","#27395a","#f1ece0","#a4acbd","#e6b450","#ef6461",1],"paper":["#ffffff","#f5f7fa","#e9edf3","#dde2ea","#1d2330","#6b7486","#4f7cff","#e5484d",0],"github":["#ffffff","#f6f8fa","#eaeef2","#d0d7de","#1f2328","#656d76","#0969da","#cf222e",0],"latte":["#eff1f5","#e6e9ef","#dce0e8","#ccd0da","#4c4f69","#6c6f85","#8839ef","#d20f39",0],"dawn":["#faf4ed","#fffaf3","#f2e9e1","#dfdad9","#575279","#797593","#907aa9","#b4637a",0],"sollight":["#fdf6e3","#f5efdc","#eee8d5","#ddd6c1","#073642","#657b83","#268bd2","#dc322f",0],"gruvlight":["#fbf1c7","#f2e5bc","#ebdbb2","#d5c4a1","#3c3836","#7c6f64","#076678","#9d0006",0],"snow":["#eceff4","#e5e9f0","#d8dee9","#c9d0dc","#2e3440","#4c566a","#5e81ac","#bf616a",0],"everlight":["#fdf6e3","#f4f0d9","#efebd4","#e0dcc7","#5c6a72","#829181","#8da101","#f85552",0],"ayulight":["#fafafa","#f3f4f5","#e8e9eb","#d9dadc","#5c6166","#8a9199","#ff9940","#f07171",0],"sakura":["#fff7f9","#fdeef2","#f9e1e8","#f0cdd8","#3d2a32","#8a6b77","#e05780","#d62839",0],"mint":["#f4fbf8","#e9f6f0","#dcefe6","#c7e3d6","#1f3a30","#5d7d70","#10b981","#ef4444",0],"sky":["#f5f9ff","#ebf3fe","#dde9fb","#c9daf3","#172b4d","#5e6c84","#0c66e4","#e34935",0],"breeze":["#f2f8fa","#e6f1f5","#d6e8ef","#bfd9e3","#12313d","#55747f","#0e8fa6","#e15554",0],"lavender":["#f8f6fd","#f0ecfa","#e5dff6","#d4cbec","#2d2640","#6f6688","#7c5cff","#e5484d",0],"peach":["#fff8f3","#fdeee4","#fae1d2","#f2ccb5","#3d2a20","#8c6b5a","#ff7a45","#e5383b",0],"sand":["#faf6f0","#f3ece1","#eadfcf","#dccdb7","#3b2f24","#85725f","#c2703d","#c0392b",0],"lemonade":["#fffdf0","#fff8d6","#fff1b8","#f0e3a0","#3a3418","#827a50","#e0a800","#e4572e",0],"sage":["#f6f8f3","#edf1e8","#e1e8da","#cdd8c3","#2a3326","#6b7a64","#5a7d4f","#c8553d",0],"nordic":["#f7f9fb","#eef2f6","#e2e8ef","#cfd8e3","#1c2733","#5f6f80","#3d7dca","#d1495b",0],"terracotta":["#fbf5f1","#f5ebe4","#ecdcd1","#dfc6b6","#3a2219","#86665a","#c75b39","#b23a48",0]};
function mix(a, b, t) {
  const p = (h) => parseInt(h.slice(1), 16);
  const x = p(a), y = p(b);
  const ch = (s) => Math.round(((x >> s) & 255) * (1 - t) + ((y >> s) & 255) * t);
  return "#" + ((1 << 24) + (ch(16) << 16) + (ch(8) << 8) + ch(0)).toString(16).slice(1);
}
let C;
// Use the theme picked in the app; "auto" follows the phone's light/dark setting.
function useTheme(id) {
  const c = THEMES[id] || THEMES[Device.isUsingDarkAppearance() ? "midnight" : "paper"];
  C = { bg: c[0], line: mix(c[3], c[0], 0.3), text: c[4], muted: c[5], today: c[6], now: c[7], tint: mix(c[0], c[6], c[8] ? 0.12 : 0.08) };
}
useTheme(null);
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
  useTheme(data && data.settings && data.settings.theme);
  w.backgroundColor = new Color(C.bg);
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
