/* global Recur */
const { ymd, parse, addDays, weekday, toMin, occursOn, occurrences, layoutDay, pad } = Recur;

let data = null;
let view = 'week';
let cursor = ymd(new Date());        // a date inside the period being shown
let hidden = new Set();              // category ids filtered out
let pinned = false;
let rev = 0;               // which copy of the data from the main process/cloud we're based on
let lastSaved = null;      // the data as last saved, to tell what changed
let pendingDoc = null;     // newer data from a sync, applied once no dialog is open
const IS_WEB = !!window.cal.isWeb;
if (IS_WEB) document.body.classList.add('web');
if (window.cal.isMac) { document.body.classList.add('mac'); document.querySelector('#pinBtn')?.setAttribute('title', 'Pin open (⌘⌥C)'); }
let scrolledOnce = false;

const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
};

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function today() { return ymd(new Date()); }

// Dark or light text, whichever reads better on the given colour.
function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#1a1d24' : '#ffffff';
}
const fill = (color) => `background:${color};color:${textOn(color)}`;

/* ---------------- themes ---------------- */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function currentTheme() {
  const id = data && data.settings.theme;
  const t = window.THEMES.find((x) => x.id === id);
  if (t) return t;
  return window.THEMES.find((x) => x.id === (darkQuery.matches ? 'midnight' : 'paper'));
}
function applyTheme(t = currentTheme()) {
  const [bg, bg2, bg3, line, text, muted, accent, now] = t.c;
  const r = document.documentElement.style;
  r.setProperty('--bg', bg);
  r.setProperty('--bg2', bg2);
  r.setProperty('--bg3', bg3);
  r.setProperty('--line', line);
  r.setProperty('--line-soft', `color-mix(in srgb, ${line} 55%, ${bg})`);
  r.setProperty('--text', text);
  r.setProperty('--muted', muted);
  r.setProperty('--accent', accent);
  r.setProperty('--accent-text', textOn(accent));
  r.setProperty('--danger', now);
  r.colorScheme = t.dark ? 'dark' : 'light';
}
darkQuery.addEventListener('change', () => { if (!data || !data.settings.theme || data.settings.theme === 'auto') applyTheme(); });
function save() {
  Sync.stamp(lastSaved, data);
  lastSaved = Sync.clone(data);
  window.cal.save(data, rev);
}

// Newer data arrived from another device. Swap it in, unless you're in the middle of editing.
function applyRemote(doc, newRev) {
  pendingDoc = { doc, rev: newRev };
  if (holdCount > 0 || !$('#backdrop').hidden) return;
  flushRemote();
}
function flushRemote() {
  if (!pendingDoc) return;
  data = pendingDoc.doc;
  rev = pendingDoc.rev;
  pendingDoc = null;
  if (!Array.isArray(data.tasks)) data.tasks = [];
  lastSaved = Sync.clone(data);
  applyTheme();
  render();
}
function cat(id) { return data.categories.find((c) => c.id === id) || { id: '', name: 'No category', color: '#7d8597' }; }
function visibleEvents() { return data.events.filter((e) => !hidden.has(e.category || '')); }

function fmtTime(t) {
  if (!t) return '';
  if (!data.settings.hour12) return t;
  let [hh, mm] = t.split(':').map(Number);
  const ap = hh >= 12 ? 'pm' : 'am';
  hh = hh % 12 || 12;
  return mm ? `${hh}:${pad(mm)}${ap}` : `${hh}${ap}`;
}
function minToTime(m) {
  m = Math.max(0, Math.min(24 * 60 - 1, m));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}
function weekStartOf(s) {
  const ws = data.settings.weekStart;
  const diff = (weekday(s) - ws + 7) % 7;
  return addDays(s, -diff);
}
function repeatLabel(ev) {
  const r = ev.repeat || {};
  const n = Number(r.interval) || 1;
  switch (r.freq) {
    case 'daily': return n > 1 ? `Every ${n} days` : 'Daily';
    case 'weekdays': return 'Every weekday';
    case 'weekly': {
      const days = (r.days && r.days.length ? r.days : [weekday(ev.date)]).map((d) => WD[d]).join(', ');
      return (n > 1 ? `Every ${n} weeks` : 'Weekly') + ` on ${days}`;
    }
    case 'monthly': return n > 1 ? `Every ${n} months` : 'Monthly';
    case 'yearly': return 'Yearly';
    default: return '';
  }
}
function sortOcc(a, b) {
  if (a.ev.allDay !== b.ev.allDay) return a.ev.allDay ? -1 : 1;
  return toMin(a.ev.start) - toMin(b.ev.start);
}

/* ---------------- header ---------------- */

function renderHeader() {
  const title = $('#title');
  if (view === 'week') {
    const s = weekStartOf(cursor), e = addDays(s, 6);
    const a = parse(s), b = parse(e);
    title.textContent = a.getMonth() === b.getMonth()
      ? `${MONTHS[a.getMonth()]} ${a.getFullYear()}`
      : `${MONTHS[a.getMonth()].slice(0, 3)} – ${MONTHS[b.getMonth()].slice(0, 3)} ${b.getFullYear()}`;
  } else {
    const d = parse(cursor);
    title.textContent = `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }
  if (view === 'tasks') title.textContent = 'Tasks';
  for (const id of ['#prevBtn', '#nextBtn', '#todayBtn']) $(id).hidden = view === 'tasks';
  $('#newBtn').textContent = view === 'tasks' ? '+ New task' : '+ New event';
  for (const b of document.querySelectorAll('#viewSeg button')) b.classList.toggle('on', b.dataset.view === view);
  $('#pinBtn').classList.toggle('on', pinned);

  const f = $('#filters');
  f.replaceChildren(...data.categories.map((c) =>
    h('span', {
      class: 'chip' + (hidden.has(c.id) ? ' off' : ''),
      title: hidden.has(c.id) ? 'Show this category' : 'Hide this category',
      onclick: () => { hidden.has(c.id) ? hidden.delete(c.id) : hidden.add(c.id); render(); },
    }, h('span', { class: 'dot', style: `background:${c.color}` }), c.name)));
}

function renderTab() {
  const t = today();
  const d = parse(t);
  $('#tabWd').textContent = WD[d.getDay()];
  $('#tabNum').textContent = d.getDate();
}

/* ---------------- week view ---------------- */

function renderWeek() {
  const start = weekStartOf(cursor);
  const days = [...Array(7)].map((_, i) => addDays(start, i));
  const occ = occurrences(visibleEvents(), days[0], days[6]);
  const t = today();

  const head = h('div', { class: 'week-head' }, h('div'),
    days.map((d) => h('div', {
      class: 'd' + (d === t ? ' today' : ''), title: 'Open in month view',
      onclick: () => { cursor = d; view = 'month'; render(); },
    }, h('div', { class: 'wd' }, WD[weekday(d)]), h('div', { class: 'num' }, parse(d).getDate()))));

  const allday = h('div', { class: 'allday-row' }, h('div', { class: 'lbl' }, 'all-day'),
    days.map((d) => h('div', { class: 'cell', ondblclick: () => openEditor({ date: d, allDay: true }) },
      occ.filter((o) => o.date === d && o.ev.allDay).map((o) =>
        h('div', {
          class: 'allday', style: fill(cat(o.ev.category).color), title: tooltip(o),
          onclick: (e) => { e.stopPropagation(); openEditor(o.ev, o.date); },
        }, evTitle(o.ev))),
      tasksOn(d).map(taskBar))));

  const gutter = h('div', { class: 'gutter' },
    [...Array(23)].map((_, i) => h('div', { class: 'h', style: `top:calc(var(--hour) * ${i + 1})` }, fmtTime(`${pad(i + 1)}:00`))));

  const cols = days.map((d) => {
    const col = h('div', { class: 'col' + (d === t ? ' today' : '') });
    const items = layoutDay(occ.filter((o) => o.date === d && !o.ev.allDay));
    for (const it of items) {
      const c = cat(it.ev.category);
      const w = 100 / it.cols;
      const rep = it.ev.repeat && it.ev.repeat.freq !== 'none';
      const el = h('div', {
        class: 'ev', title: tooltip(it),
        style: `top:calc(var(--hour) * ${it.s / 60});height:calc(var(--hour) * ${(it.e - it.s) / 60} - 2px);` +
          `left:calc(${it.col * w}% + 2px);width:calc(${w}% - 4px);${fill(c.color)}`,
        onmousedown: (e) => e.stopPropagation(),
      }, h('div', { class: 'rz top', title: 'Drag to change the start time' }),
        h('b', {}, evTitle(it.ev)),
        h('span', { class: 't' }, `${fmtTime(it.ev.start)} – ${fmtTime(it.ev.end)}`),
        rep ? h('span', { class: 'rep', title: repeatLabel(it.ev) }, '↻') : null,
        progress(it.ev, it.date),
        h('div', { class: 'rz bottom', title: 'Drag to change the end time' }));
      enableEventDrag(el, it.ev, it.date, days);
      col.append(el);
    }
    if (d === t) {
      const now = new Date();
      col.append(h('div', { class: 'now-line', style: `top:calc(var(--hour) * ${(now.getHours() * 60 + now.getMinutes()) / 60})` }));
    }
    enableDragCreate(col, d);
    return col;
  });

  const grid = h('div', { class: 'week-grid' }, gutter, cols);
  const scroll = h('div', { class: 'week-scroll' }, grid);
  $('#view').replaceChildren(head, allday, scroll);
  // Line the day headers up with the grid below, which loses some width to its scrollbar.
  const sbw = scroll.offsetWidth - scroll.clientWidth;
  head.style.paddingRight = allday.style.paddingRight = sbw + 'px';

  const hourPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hour')) || 46;
  if (!scrolledOnce || scrollMemo == null) {
    scroll.scrollTop = hourPx * (data.settings.dayStartHour ?? 7);
    scrolledOnce = true;
  } else {
    scroll.scrollTop = scrollMemo;
  }
  scroll.addEventListener('scroll', () => { scrollMemo = scroll.scrollTop; });
}
let scrollMemo = null;

// Click or click-and-drag on an empty part of a day column to create an event there.
function enableDragCreate(col, date) {
  col.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const rect = col.getBoundingClientRect();
    const hourPx = rect.height / 24;
    const snapMin = (y) => Math.round(((y - rect.top) / hourPx) * 60 / 15) * 15;
    const startMin = Math.floor(((e.clientY - rect.top) / hourPx) * 60 / 30) * 30;
    let endMin = startMin + 60;
    let moved = false;
    const draft = h('div', { class: 'ev draft' });
    const paint = () => {
      const a = Math.min(startMin, endMin), b = Math.max(startMin, endMin);
      draft.style.cssText = `top:${(a / 60) * hourPx}px;height:${((b - a) / 60) * hourPx}px;left:2px;right:2px`;
      draft.textContent = `${fmtTime(minToTime(a))} – ${fmtTime(minToTime(b))}`;
    };
    paint();
    col.append(draft);
    const move = (ev) => {
      const m = snapMin(ev.clientY);
      if (Math.abs(m - startMin) >= 15) { moved = true; endMin = m === startMin ? startMin + 15 : m; paint(); }
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      draft.remove();
      let a = Math.min(startMin, endMin), b = Math.max(startMin, endMin);
      if (!moved) { a = startMin; b = startMin + 60; }
      openEditor({ date, start: minToTime(a), end: minToTime(Math.min(b, 24 * 60 - 1)) });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

/* ---------------- notes with checkboxes ---------------- */

// While making a "busy only" picture, event names are hidden.
let busyMode = false;
const evTitle = (ev) => (busyMode ? 'Busy' : ev.title || '(untitled)');

function progress(ev, date) {
  if (busyMode) return null;
  const c = checklist(ev, date);
  if (!c.total) return null;
  return h('span', { class: 'prog' + (c.done === c.total ? ' all' : '') }, `☑ ${c.done}/${c.total}`);
}

// Notes are plain text. A line starting with "[ ] " is a checkbox. Ticks are stored per day
// in ev.checked[date] (a list of ticked item texts), so a repeating event starts fresh each day.
const CHECK_RE = /^\[[ xX]?\] ?(.*)$/;
function parseNotes(text) {
  return (text || '').split('\n').map((line) => {
    const m = CHECK_RE.exec(line);
    return m ? { check: true, text: m[1] } : { check: false, text: line };
  });
}
function checklist(ev, date) {
  const items = parseNotes(ev.notes).filter((l) => l.check && l.text.trim());
  const ticked = new Set((ev.checked && ev.checked[date]) || []);
  return { done: items.filter((l) => ticked.has(l.text)).length, total: items.length };
}
function setChecks(ev, date, texts) {
  ev.checked = ev.checked || {};
  if (texts.length) ev.checked[date] = texts;
  else delete ev.checked[date];
}

// A notes box where typing "-- " at the start of a line turns it into a tickable checkbox.
function notesEditor(text, tickedTexts, onToggle) {
  const ticked = new Set(tickedTexts || []);
  let lines = parseNotes(text).map((l) => ({ ...l, done: l.check && ticked.has(l.text) }));
  if (!lines.length) lines = [{ check: false, text: '', done: false }];
  const box = h('div', { class: 'notes' });
  const fit = (ta) => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
  const focusLine = (i, pos) => {
    const ta = box.querySelectorAll('textarea')[i];
    if (!ta) return;
    ta.focus();
    const p = pos === 'end' ? ta.value.length : pos;
    ta.setSelectionRange(p, p);
  };
  const ticks = () => lines.filter((l) => l.check && l.done && l.text.trim()).map((l) => l.text);

  const paint = () => {
    const onlyEmpty = lines.length === 1 && !lines[0].check && !lines[0].text;
    box.replaceChildren(...lines.map((l, i) => {
      const ta = h('textarea', { rows: 1, placeholder: onlyEmpty ? 'Notes. Type -- and a space to add a checkbox' : '' });
      ta.value = l.text;
      ta.addEventListener('input', () => {
        if (!l.check && ta.value.startsWith('-- ')) {
          l.check = true;
          l.done = false;
          l.text = ta.value.slice(3);
          paint();
          focusLine(i, 0);
          return;
        }
        l.text = ta.value;
        fit(ta);
      });
      ta.addEventListener('keydown', (e) => {
        const a = ta.selectionStart, b = ta.selectionEnd;
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return; // Ctrl+Enter saves (handled by the dialog)
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          if (l.check && !l.text && a === 0) { l.check = false; paint(); focusLine(i, 0); return; }
          const after = l.text.slice(b);
          l.text = l.text.slice(0, a);
          lines.splice(i + 1, 0, { check: l.check, done: false, text: after });
          paint();
          focusLine(i + 1, 0);
        } else if (e.key === 'Backspace' && a === 0 && b === 0) {
          if (l.check) { e.preventDefault(); l.check = false; l.done = false; paint(); focusLine(i, 0); }
          else if (i > 0) {
            e.preventDefault();
            const prev = lines[i - 1], pos = prev.text.length;
            prev.text += l.text;
            lines.splice(i, 1);
            paint();
            focusLine(i - 1, pos);
          }
        } else if (e.key === 'Delete' && a === l.text.length && b === a && i < lines.length - 1) {
          e.preventDefault();
          l.text += lines[i + 1].text;
          lines.splice(i + 1, 1);
          paint();
          focusLine(i, a);
        } else if (e.key === 'ArrowUp' && a === 0 && i > 0) {
          e.preventDefault(); focusLine(i - 1, 'end');
        } else if (e.key === 'ArrowDown' && a === l.text.length && i < lines.length - 1) {
          e.preventDefault(); focusLine(i + 1, 0);
        }
      });
      ta.addEventListener('paste', (e) => {
        const txt = e.clipboardData.getData('text');
        if (!txt.includes('\n')) return;
        e.preventDefault();
        const a = ta.selectionStart, b = ta.selectionEnd;
        const head = l.text.slice(0, a), tail = l.text.slice(b);
        const parts = txt.replace(/\r/g, '').split('\n').map((t) => {
          if (t.startsWith('-- ')) return { check: true, done: false, text: t.slice(3) };
          const m = CHECK_RE.exec(t);
          return m ? { check: true, done: false, text: m[1] } : { check: false, done: false, text: t };
        });
        l.text = head + parts[0].text;
        if (!head && parts[0].check) l.check = true;
        const rest = parts.slice(1);
        if (rest.length) rest[rest.length - 1].text += tail; else l.text += tail;
        lines.splice(i + 1, 0, ...rest);
        paint();
        focusLine(i + rest.length, 'end');
      });
      const row = h('div', { class: 'nrow' + (l.check ? ' check' : '') + (l.check && l.done ? ' done' : '') },
        l.check ? h('span', {
          class: 'nchk', title: l.done ? 'Untick' : 'Tick off',
          onmousedown: (e) => e.preventDefault(),
          onclick: () => { l.done = !l.done; paint(); if (onToggle) onToggle(ticks()); },
        }, l.done ? '✓' : '') : null,
        ta);
      requestAnimationFrame(() => fit(ta));
      return row;
    }));
  };
  box.addEventListener('mousedown', (e) => {
    if (e.target === box) { e.preventDefault(); focusLine(lines.length - 1, 'end'); }
  });
  paint();
  return {
    el: box,
    text: () => lines.map((l) => (l.check ? '[ ] ' : '') + l.text).join('\n').replace(/\s+$/, ''),
    ticks,
  };
}

// Drag an event to move it (to another time or day), or drag its top/bottom edge to resize it.
// A click without movement opens the editor.
function enableEventDrag(el, ev, date, days) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.pointerType === 'touch') {
      // On a phone, a finger on an event scrolls the week; a tap opens it.
      el.onclick = () => openEditor(ev, date);
      return;
    }
    const mode = e.target.classList.contains('rz') ? (e.target.classList.contains('top') ? 'top' : 'bottom') : 'move';
    const col = el.parentElement;
    const cols = [...col.parentElement.querySelectorAll('.col')];
    const dayIdx = cols.indexOf(col);
    const rect = col.getBoundingClientRect();
    const hourPx = rect.height / 24;
    const s0 = toMin(ev.start), e0 = Math.max(toMin(ev.end), s0 + 15);
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false, s = s0, en = e0, dd = 0;
    el.setPointerCapture(e.pointerId);
    const label = el.querySelector('.t');
    const snap = (px) => Math.round((px / hourPx) * 60 / 15) * 15;

    const move = (m) => {
      if (!moved && Math.abs(m.clientX - x0) < 4 && Math.abs(m.clientY - y0) < 4) return;
      if (!moved) { moved = true; el.classList.add('dragging'); document.body.classList.add('is-dragging'); }
      const dm = snap(m.clientY - y0);
      if (mode === 'move') {
        const len = e0 - s0;
        s = Math.max(0, Math.min(24 * 60 - len, s0 + dm));
        en = s + len;
        // Which day column is the pointer over?
        let idx = cols.findIndex((c) => { const r = c.getBoundingClientRect(); return m.clientX >= r.left && m.clientX < r.right; });
        if (idx === -1) idx = m.clientX < cols[0].getBoundingClientRect().left ? 0 : cols.length - 1;
        dd = idx - dayIdx;
        el.style.transform = `translateX(${cols[idx].getBoundingClientRect().left - rect.left}px)`;
      } else if (mode === 'top') {
        s = Math.max(0, Math.min(e0 - 15, s0 + dm));
      } else {
        en = Math.min(24 * 60 - 1, Math.max(s0 + 15, e0 + dm));
      }
      el.style.top = `${(s / 60) * hourPx}px`;
      el.style.height = `${((en - s) / 60) * hourPx - 2}px`;
      if (dd) { el.style.left = '2px'; el.style.width = `${rect.width - 4}px`; }
      if (label) label.textContent = `${fmtTime(minToTime(s))} – ${fmtTime(minToTime(en))}`;
    };
    const up = async () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      document.body.classList.remove('is-dragging');
      if (!moved) { openEditor(ev, date); return; }
      const newDate = addDays(date, dd);
      if (s === s0 && en === e0 && !dd) { render(); return; }
      await moveEvent(ev, date, newDate, minToTime(s), minToTime(en), dd);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

async function moveEvent(ev, occDate, newDate, start, end, dayDelta) {
  const isRepeat = ev.repeat && ev.repeat.freq !== 'none';
  if (!isRepeat) {
    if (ev.checked && ev.checked[occDate] && newDate !== occDate) { ev.checked[newDate] = ev.checked[occDate]; delete ev.checked[occDate]; }
    Object.assign(ev, { date: newDate, start, end });
  } else {
    const choice = await ask('Move a repeating event', [['Only this one', 'one'], ['This and all following', 'following'], ['All events in the series', 'all']]);
    if (!choice) { render(); return; }
    const { id, exdates, checked, ...rest } = ev;
    const vals = { ...JSON.parse(JSON.stringify(rest)), date: newDate, start, end };
    if (choice === 'all' || (choice === 'following' && occDate <= ev.date)) {
      // Shift the whole series by the same number of days.
      ev.start = start;
      ev.end = end;
      if (dayDelta) {
        ev.date = addDays(ev.date, dayDelta);
        if (ev.repeat.freq === 'weekly' && ev.repeat.days && ev.repeat.days.length) {
          ev.repeat.days = ev.repeat.days.map((d) => (((d + dayDelta) % 7) + 7) % 7);
        }
        if (ev.repeat.until) ev.repeat.until = addDays(ev.repeat.until, dayDelta);
        ev.exdates = (ev.exdates || []).map((d) => addDays(d, dayDelta));
      }
    } else {
      if (choice === 'following' && dayDelta && vals.repeat.freq === 'weekly' && vals.repeat.days && vals.repeat.days.length) {
        vals.repeat.days = vals.repeat.days.map((d) => (((d + dayDelta) % 7) + 7) % 7);
      }
      const count = data.events.length;
      applySeriesEdit(ev, occDate, vals, choice);
      const made = data.events.length > count ? data.events[data.events.length - 1] : null;
      if (made && ev.checked && ev.checked[occDate]) made.checked = { [newDate]: ev.checked[occDate] };
    }
  }
  save();
  render();
}

function tooltip(o) {
  const ev = o.ev;
  const lines = [ev.title || '(untitled)'];
  lines.push(ev.allDay ? 'All day' : `${fmtTime(ev.start)} – ${fmtTime(ev.end)}`);
  lines.push(cat(ev.category).name);
  const r = repeatLabel(ev);
  if (r) lines.push('↻ ' + r);
  if (ev.notes) {
    const ticked = new Set((ev.checked && ev.checked[o.date]) || []);
    lines.push('', ...parseNotes(ev.notes).map((l) => (l.check ? (ticked.has(l.text) ? '☑ ' : '☐ ') : '') + l.text));
  }
  return lines.join('\n');
}

/* ---------------- month view ---------------- */

// Lay out spans {s, e} (minutes) side by side where they overlap. Adds col / cols.
function layoutSpans(items) {
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], colEnds = [], clusterEnd = -1;
  const flush = () => { for (const it of cluster) it.cols = colEnds.length; cluster = []; colEnds = []; };
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) flush();
    let col = colEnds.findIndex((end) => end <= it.s);
    if (col === -1) { col = colEnds.length; colEnds.push(it.e); } else colEnds[col] = it.e;
    it.col = col;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush();
  return items;
}

function hourLabel(hr) {
  if (!data.settings.hour12) return String(hr);
  const ap = hr >= 12 && hr < 24 ? 'p' : 'a';
  return (hr % 12 || 12) + ap;
}

function renderMonth() {
  const d = parse(cursor);
  const first = ymd(new Date(d.getFullYear(), d.getMonth(), 1));
  const start = weekStartOf(first);
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const rows = Math.ceil(((Recur.dayNum(first) - Recur.dayNum(start)) + daysInMonth) / 7);
  const cells = [...Array(rows * 7)].map((_, i) => addDays(start, i));
  const occ = occurrences(visibleEvents(), cells[0], cells[cells.length - 1]);
  const t = today();
  const month = d.getMonth();
  const from = Math.max(0, Math.min(23, Number(data.settings.monthFrom ?? 6))) * 60;
  const to = Math.max(from / 60 + 1, Math.min(24, Number(data.settings.monthTo ?? 24))) * 60;

  const head = h('div', { class: 'month-head' },
    [...Array(7)].map((_, i) => h('div', {}, WD[(data.settings.weekStart + i) % 7])));

  const areas = [];
  const grid = h('div', { class: 'month-grid', style: `grid-template-rows:repeat(${rows}, 1fr)` }, cells.map((c, idx) => {
    const allDay = occ.filter((o) => o.date === c && o.ev.allDay);
    const shown = allDay.length > 2 ? allDay.slice(0, 1) : allDay;
    const area = h('div', {
      class: 'mtime',
      title: 'Double-click to add an event at this time',
      ondblclick: (e) => {
        e.stopPropagation();
        const r = area.getBoundingClientRect();
        const m = Math.floor((from + ((e.clientY - r.top) / r.height) * (to - from)) / 30) * 30;
        openEditor({ date: c, start: minToTime(m), end: minToTime(Math.min(m + 60, 24 * 60 - 1)) });
      },
    });
    areas.push({ date: c, area, first: idx % 7 === 0 });
    return h('div', {
      class: 'mcell' + (parse(c).getMonth() !== month ? ' other' : '') + (c === t ? ' today' : ''),
      ondblclick: () => openEditor({ date: c, allDay: true }),
    },
    h('div', { class: 'mhead', style: 'height:30px' },
      h('div', {
        class: 'mnum', title: 'Open this week',
        onclick: (e) => { e.stopPropagation(); cursor = c; view = 'week'; scrollMemo = null; render(); },
      }, parse(c).getDate()),
      h('div', { class: 'mallday' },
        shown.map((o) => h('div', {
          style: fill(cat(o.ev.category).color), title: tooltip(o),
          ondblclick: (e) => e.stopPropagation(),
          onclick: (e) => { e.stopPropagation(); openEditor(o.ev, o.date); },
        }, evTitle(o.ev))),
        allDay.length > 2 ? h('div', { style: 'color:var(--muted)', title: allDay.slice(1).map((o) => o.ev.title).join('\n') }, `+${allDay.length - 1} all-day`) : null),
      monthTasks(c)),
    area);
  }));
  $('#view').replaceChildren(head, grid);

  // Now that the cells have a size, place each event by its time of day.
  const H = areas.length ? areas[0].area.clientHeight : 0;
  if (!H) return;
  const pxPerMin = H / (to - from);
  const MIN_PX = 12;
  const minMins = MIN_PX / pxPerMin;
  for (const { date, area, first } of areas) {
    for (let hr = Math.ceil(from / 60 / 3) * 3; hr * 60 < to; hr += 3) {
      if (hr * 60 <= from) continue;
      area.append(h('div', { class: 'gl' + (hr === 12 ? ' noon' : ''), style: `top:${(hr * 60 - from) * pxPerMin}px` },
        first ? h('i', {}, hourLabel(hr)) : null));
    }
    const items = occ.filter((o) => o.date === date && !o.ev.allDay).map((o) => {
      const s0 = toMin(o.ev.start), e0 = Math.max(toMin(o.ev.end), s0 + 15);
      const s = Math.max(from, Math.min(s0, to - minMins));
      const e = Math.max(Math.min(e0, to), s + minMins);
      return { o, s, e };
    });
    for (const it of layoutSpans(items)) {
      const w = 100 / it.cols;
      const color = cat(it.o.ev.category).color;
      area.append(h('div', {
        class: 'mev', title: tooltip(it.o),
        style: `top:${(it.s - from) * pxPerMin}px;height:${(it.e - it.s) * pxPerMin - 1}px;` +
          `left:calc(${it.col * w}% + 1px);width:calc(${w}% - 2px);${fill(color)}`,
        ondblclick: (e) => e.stopPropagation(),
        onclick: (e) => { e.stopPropagation(); openEditor(it.o.ev, it.o.date); },
      }, it.cols < 3 ? h('span', { class: 't' }, fmtTime(it.o.ev.start)) : null, evTitle(it.o.ev), progress(it.o.ev, it.o.date)));
    }
  }
}

function render() {
  renderHeader();
  renderTab();
  if (view === 'week') renderWeek();
  else if (view === 'tasks') renderTasks();
  else renderMonth();
}

/* ---------------- dialogs ---------------- */

function openDialog(build) {
  const dlg = $('#dialog');
  dlg.replaceChildren();
  build(dlg);
  if ($('#backdrop').hidden) hold(1);
  $('#backdrop').hidden = false;
  const first = dlg.querySelector('input[type=text]');
  if (first) setTimeout(() => first.focus(), 30);
}
function closeDialog() {
  if (!$('#backdrop').hidden) hold(-1);
  $('#backdrop').hidden = true;
  $('#dialog').replaceChildren();
  $('#dialog').className = 'dialog';
}

// Keeps the calendar from sliding shut while any dialog or popup is open.
let holdCount = 0;
function hold(d) {
  holdCount = Math.max(0, holdCount + d);
  window.cal.holdOpen(holdCount > 0);
  if (holdCount === 0 && pendingDoc) setTimeout(() => { if (holdCount === 0 && $('#backdrop').hidden) flushRemote(); }, 0);
}

// A popup that sits above everything else, including an open dialog. Returns its close function.
function popup(build) {
  const box = h('div', { class: 'dialog' });
  const layer = h('div', { class: 'layer' }, box);
  let open = true;
  const close = () => { if (open) { open = false; layer.remove(); hold(-1); } };
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) close(); });
  layer.close = close;
  build(box, close);
  document.body.append(layer);
  hold(1);
  return close;
}
$('#backdrop').addEventListener('mousedown', (e) => { if (e.target.id === 'backdrop') closeDialog(); });

function ask(title, options) {
  return new Promise((resolve) => {
    openDialog((dlg) => {
      dlg.append(h('h2', {}, title), h('div', { class: 'choice' },
        options.map(([label, value]) => h('button', { onclick: () => { closeDialog(); resolve(value); } }, label)),
        h('button', { onclick: () => { closeDialog(); resolve(null); } }, 'Cancel')));
    });
  });
}

// Open the event editor. `src` is an existing event, or a partial new one.
// `occDate` is the date of the clicked occurrence (for repeating events).
function openEditor(src, occDate) {
  const existing = data.events.find((e) => e.id === src.id);
  const isRepeat = existing && existing.repeat && existing.repeat.freq !== 'none';
  const lastCat = data.settings.lastCategory && data.categories.some((c) => c.id === data.settings.lastCategory)
    ? data.settings.lastCategory : (data.categories[0] || {}).id || '';
  const f = {
    title: src.title || '',
    category: src.category ?? lastCat,
    date: occDate || src.date || today(),
    allDay: !!src.allDay,
    start: src.start || '09:00',
    end: src.end || '10:00',
    notes: src.notes || '',
    freq: (src.repeat && src.repeat.freq) || 'none',
    interval: (src.repeat && src.repeat.interval) || 1,
    days: (src.repeat && src.repeat.days && src.repeat.days.slice()) || [],
    until: (src.repeat && src.repeat.until) || '',
  };

  openDialog((dlg) => {
    const titleIn = h('input', { type: 'text', value: f.title, placeholder: 'Event name' });
    const dateIn = h('input', { type: 'date', value: f.date });
    const allDayIn = h('input', { type: 'checkbox', id: 'allday' });
    allDayIn.checked = f.allDay;
    const startIn = h('input', { type: 'time', value: f.start, step: 300 });
    const endIn = h('input', { type: 'time', value: f.end, step: 300 });
    const noteDate = occDate || f.date;
    const notes = notesEditor(f.notes, existing ? (existing.checked || {})[noteDate] : [], (ticks) => {
      // Ticking saves straight away for an event that already exists, so you can tick as you go.
      if (existing) { setChecks(existing, noteDate, ticks); save(); render(); }
    });
    const timeRow = h('div', { class: 'row' }, h('label', { class: 'l' }, 'Time'), startIn, '–', endIn);

    const swatches = h('div', { class: 'swatches' });
    const paintSwatches = () => swatches.replaceChildren(...data.categories.map((c) =>
      h('span', { class: 'swatch' + (f.category === c.id ? ' sel' : ''), onclick: () => { f.category = c.id; paintSwatches(); } },
        h('span', { class: 'dot', style: `background:${c.color}` }), c.name)));
    paintSwatches();

    const freqIn = h('select', {},
      [['none', 'Does not repeat'], ['daily', 'Daily'], ['weekdays', 'Every weekday (Mon–Fri)'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']]
        .map(([v, l]) => h('option', { value: v }, l)));
    freqIn.value = f.freq;
    const intervalIn = h('input', { type: 'number', min: 1, max: 99, value: f.interval, style: 'width:60px' });
    const unitLbl = h('span');
    const daysWrap = h('div', { class: 'days' });
    const paintDays = () => {
      const order = [...Array(7)].map((_, i) => (data.settings.weekStart + i) % 7);
      if (!f.days.length) f.days = [weekday(dateIn.value || today())];
      daysWrap.replaceChildren(...order.map((d) => h('button', {
        class: f.days.includes(d) ? 'on' : '', type: 'button',
        onclick: () => {
          f.days = f.days.includes(d) ? f.days.filter((x) => x !== d) : [...f.days, d];
          if (!f.days.length) f.days = [d];
          paintDays();
        },
      }, WD[d].slice(0, 2))));
    };
    const untilIn = h('input', { type: 'date', value: f.until });
    const everyRow = h('div', { class: 'row' }, h('label', { class: 'l' }, 'Every'), intervalIn, unitLbl);
    const daysRow = h('div', { class: 'row' }, h('label', { class: 'l' }, 'On'), daysWrap);
    const untilRow = h('div', { class: 'row' }, h('label', { class: 'l' }, 'Ends'), untilIn,
      h('span', { class: 'hint', style: 'margin:0' }, 'leave empty to repeat forever'));

    const sync = () => {
      timeRow.hidden = allDayIn.checked;
      const fr = freqIn.value;
      everyRow.hidden = !['daily', 'weekly', 'monthly', 'yearly'].includes(fr);
      unitLbl.textContent = { daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', yearly: 'year(s)' }[fr] || '';
      daysRow.hidden = fr !== 'weekly';
      untilRow.hidden = fr === 'none';
      if (fr === 'weekly') paintDays();
    };
    allDayIn.addEventListener('change', sync);
    freqIn.addEventListener('change', sync);

    const doSave = async () => {
      const vals = {
        title: titleIn.value.trim() || '(untitled)',
        category: f.category,
        date: dateIn.value || f.date,
        allDay: allDayIn.checked,
        start: startIn.value || '09:00',
        end: endIn.value || '10:00',
        notes: notes.text(),
        repeat: {
          freq: freqIn.value,
          interval: Math.max(1, Number(intervalIn.value) || 1),
          days: freqIn.value === 'weekly' ? f.days.slice().sort() : [],
          until: freqIn.value === 'none' ? '' : untilIn.value,
        },
      };
      if (!vals.allDay && toMin(vals.end) <= toMin(vals.start)) {
        vals.end = minToTime(Math.min(toMin(vals.start) + 60, 24 * 60 - 1));
      }
      if (vals.repeat.until && vals.repeat.until < vals.date) vals.repeat.until = '';
      data.settings.lastCategory = vals.category;

      const ticks = notes.ticks();
      if (!existing) {
        const ev = { id: crypto.randomUUID(), exdates: [], ...vals };
        setChecks(ev, vals.date, ticks);
        data.events.push(ev);
      } else if (isRepeat && occDate) {
        // Only ask when something other than the notes' ticks changed.
        const same = ['title', 'category', 'allDay', 'start', 'end', 'notes'].every((k) => existing[k] === vals[k])
          && vals.date === occDate && JSON.stringify(vals.repeat) === JSON.stringify({ ...existing.repeat, days: existing.repeat.freq === 'weekly' ? (existing.repeat.days || []).slice().sort() : [] });
        if (same) {
          setChecks(existing, occDate, ticks);
        } else {
          const choice = await ask('Change a repeating event', [['Only this one', 'one'], ['This and all following', 'following'], ['All events in the series', 'all']]);
          if (!choice) return openEditor(existing, occDate);
          const count = data.events.length;
          applySeriesEdit(existing, occDate, vals, choice);
          if (data.events.length > count) setChecks(data.events[data.events.length - 1], vals.date, ticks);
          else setChecks(existing, occDate, ticks);
        }
      } else {
        Object.assign(existing, vals);
        setChecks(existing, vals.date, ticks);
      }
      save();
      closeDialog();
      render();
    };

    const doDelete = async () => {
      if (isRepeat && occDate) {
        const choice = await ask('Delete a repeating event', [['Only this one', 'one'], ['This and all following', 'following'], ['All events in the series', 'all']]);
        if (!choice) return openEditor(existing, occDate);
        if (choice === 'one') existing.exdates = [...(existing.exdates || []), occDate];
        else if (choice === 'following' && occDate > existing.date) existing.repeat.until = addDays(occDate, -1);
        else data.events = data.events.filter((e) => e.id !== existing.id);
      } else {
        data.events = data.events.filter((e) => e.id !== existing.id);
      }
      save();
      closeDialog();
      render();
    };

    titleIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) doSave(); });

    dlg.append(
      h('h2', {}, existing ? 'Edit event' : 'New event'),
      h('div', { class: 'row' }, titleIn),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Category'), swatches),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Date'), dateIn,
        h('label', { for: 'allday', style: 'display:flex;gap:5px;align-items:center;margin-left:8px' }, allDayIn, 'All day')),
      timeRow,
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Repeat'), freqIn),
      everyRow, daysRow, untilRow,
      h('div', { class: 'row' }, notes.el),
      h('div', { class: 'btns' },
        existing ? h('button', { class: 'danger', onclick: doDelete }, 'Delete') : null,
        h('span', { class: 'spacer' }),
        h('button', { onclick: closeDialog }, 'Cancel'),
        h('button', { class: 'primary', onclick: doSave }, 'Save')),
    );
    sync();
  });
}

function applySeriesEdit(series, occDate, vals, choice) {
  if (choice === 'one') {
    series.exdates = [...(series.exdates || []), occDate];
    data.events.push({ id: crypto.randomUUID(), exdates: [], ...vals, repeat: { freq: 'none', interval: 1, days: [], until: '' } });
  } else if (choice === 'following' && occDate > series.date) {
    const oldUntil = series.repeat.until;
    series.repeat.until = addDays(occDate, -1);
    const repeat = { ...vals.repeat };
    if (!repeat.until && oldUntil) repeat.until = oldUntil;
    data.events.push({ id: crypto.randomUUID(), exdates: (series.exdates || []).filter((d) => d >= vals.date), ...vals, repeat });
  } else {
    // Whole series. If the date field wasn't changed, keep the series' original start date.
    const date = vals.date === occDate ? series.date : vals.date;
    Object.assign(series, vals, { date });
  }
}

function openCategories() {
  openDialog((dlg) => {
    const list = h('div');
    const paint = () => list.replaceChildren(...data.categories.map((c) => {
      const color = h('input', { type: 'color', value: c.color });
      color.addEventListener('input', () => { c.color = color.value; save(); render(); });
      const name = h('input', { type: 'text', value: c.name });
      name.addEventListener('input', () => { c.name = name.value; save(); render(); });
      return h('div', { class: 'catrow' }, color, name, h('button', {
        class: 'icon', title: 'Delete category',
        onclick: () => {
          const used = data.events.filter((e) => e.category === c.id).length;
          if (used && !confirm(`${used} event(s) use "${c.name}". They will become uncategorised. Delete it?`)) return;
          data.categories = data.categories.filter((x) => x.id !== c.id);
          for (const e of data.events) if (e.category === c.id) e.category = '';
          save(); paint(); render();
        },
      }, '🗑'));
    }));
    paint();
    const palette = ['#4f7cff', '#34c77b', '#b06cff', '#ff9f43', '#ff5d8f', '#22b8cf', '#f5c518', '#8d6e63', '#7d8597'];
    dlg.append(h('h2', {}, 'Categories'), list,
      h('div', { class: 'btns' },
        h('button', {
          onclick: () => {
            data.categories.push({ id: crypto.randomUUID(), name: 'New category', color: palette[data.categories.length % palette.length] });
            save(); paint(); render();
            const inputs = list.querySelectorAll('input[type=text]');
            inputs[inputs.length - 1].select();
          },
        }, '+ Add category'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'primary', onclick: closeDialog }, 'Done')));
  });
}

// "Phone sync" part of Settings.
function syncSection() {
  const status = h('span', { class: 'sync-status' }, 'Checking…');
  const btns = h('span', { style: 'display:flex;gap:6px;flex-wrap:wrap' });
  const row = h('div', { class: 'row' }, h('label', { class: 'l' }, 'Sync'), h('div', { style: 'display:flex;flex-direction:column;gap:6px;flex:1' }, status, btns));
  window.cal.syncState().then((st) => {
    const signedIn = st.email && st.status !== 'off' && st.status !== 'signed-out';
    status.textContent = syncLabel(st);
    btns.replaceChildren(
      signedIn ? h('button', { class: 'small', onclick: () => { window.cal.syncNow(); status.textContent = 'Syncing…'; } }, 'Sync now') : null,
      signedIn ? h('button', { class: 'small', onclick: async () => {
        if (!confirm('Stop syncing on this device? Your events stay here and in the cloud.')) return;
        await window.cal.syncDisconnect(); closeDialog();
      } }, 'Sign out') : null,
      !signedIn && !IS_WEB ? h('button', { class: 'small primary-ish', onclick: () => openSyncSetup(st) }, 'Set up phone sync…') : null);
  });
  return row;
}
function syncLabel(st) {
  if (!st || st.status === 'off') return 'Off. Your calendar is only on this device.';
  if (st.status === 'signed-out') return 'Signed out. ' + (st.error || '');
  if (st.status === 'error') return `Problem syncing: ${st.error}`;
  const when = st.at ? new Date(st.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return `${st.status === 'syncing' ? 'Syncing…' : 'On'}${st.email ? ` as ${st.email}` : ''}${when ? ` · last synced ${when}` : ''}`;
}
function openSyncSetup(st) {
  openDialog((dlg) => {
    const url = h('input', { type: 'text', value: (st && st.url) || '', placeholder: 'https://xxxx.supabase.co' });
    const key = h('input', { type: 'text', value: (st && st.key) || '', placeholder: 'anon / publishable key' });
    const email = h('input', { type: 'text', placeholder: 'you@example.com' });
    const pw = h('input', { type: 'password', placeholder: 'Password' });
    const msg = h('div', { class: 'hint', style: 'margin:6px 0 0' });
    const go = async () => {
      msg.textContent = 'Signing in…';
      const r = await window.cal.syncConnect({ url: url.value.trim(), key: key.value.trim(), email: email.value.trim(), password: pw.value });
      if (r.ok) { closeDialog(); toast('Sync is on. Your calendar is now in the cloud.'); }
      else msg.textContent = r.error;
    };
    pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    dlg.append(h('h2', {}, 'Set up phone sync'),
      h('div', { class: 'hint', style: 'margin:-4px 0 10px' }, 'Uses your Supabase project. Your events on this PC are kept and uploaded.'),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Project URL'), url),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Key'), key),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Email'), email),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Password'), pw),
      msg,
      h('div', { class: 'btns' }, h('span', { class: 'spacer' }), h('button', { onclick: closeDialog }, 'Cancel'), h('button', { class: 'primary', onclick: go }, 'Sign in')));
  });
}

async function openSettings() {
  const s = data.settings;
  const fresh = await window.cal.load();
  openDialog((dlg) => {
    const ws = h('select', {}, h('option', { value: '1' }, 'Monday'), h('option', { value: '0' }, 'Sunday'));
    ws.value = String(s.weekStart);
    const fmt = h('select', {}, h('option', { value: '24' }, '24-hour (14:00)'), h('option', { value: '12' }, '12-hour (2pm)'));
    fmt.value = s.hour12 ? '12' : '24';
    const dayStart = h('input', { type: 'number', min: 0, max: 20, value: s.dayStartHour ?? 7, style: 'width:60px' });
    const mFrom = h('input', { type: 'number', min: 0, max: 22, value: s.monthFrom ?? 6, style: 'width:60px' });
    const mTo = h('input', { type: 'number', min: 2, max: 24, value: s.monthTo ?? 24, style: 'width:60px' });
    const login = h('input', { type: 'checkbox', id: 'login' });
    login.checked = !!fresh.loginItem;

    dlg.append(h('h2', {}, 'Settings'),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Week starts'), ws),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Time'), fmt),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Scroll to'), dayStart, h('span', {}, ':00 when the week opens')),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Month day'), mFrom, h('span', {}, ':00 to'), mTo, h('span', {}, ':00')),
      h('div', { class: 'hint' }, 'The hours each day box in the month view covers, top to bottom.'),
      h('div', { class: 'row desk-only' }, h('label', { class: 'l' }, ''), h('label', { for: 'login', style: 'display:flex;gap:6px;align-items:center' }, login, window.cal.isMac ? 'Open at login' : 'Start with Windows')),
      h('div', { class: 'row desk-only' }, h('label', { class: 'l' }, 'Tab'),
        h('button', { onclick: () => { closeDialog(); window.cal.resetTab(); } }, 'Move the tab back to the right edge')),
      h('div', { class: 'hint desk-only' }, 'Drag the dotted strip at the top of the tab to put it anywhere.'),
      syncSection(),
      h('div', { class: 'btns' },
        h('button', { class: 'danger desk-only', onclick: () => window.cal.quit() }, 'Quit app'),
        h('span', { class: 'spacer' }),
        h('button', { onclick: closeDialog }, 'Cancel'),
        h('button', {
          class: 'primary',
          onclick: () => {
            s.weekStart = Number(ws.value);
            s.hour12 = fmt.value === '12';
            s.dayStartHour = Math.max(0, Math.min(20, Number(dayStart.value) || 0));
            let a = Math.max(0, Math.min(22, Math.round(Number(mFrom.value) || 0)));
            let b = Math.max(2, Math.min(24, Math.round(Number(mTo.value) || 24)));
            if (b <= a) b = Math.min(24, a + 2);
            s.monthFrom = a;
            s.monthTo = b;
            if (login.checked !== !!fresh.loginItem) window.cal.setLogin(login.checked);
            scrollMemo = null;
            save();
            closeDialog();
            render();
          },
        }, 'Save')));
  });
}

function openThemes() {
  const before = data.settings.theme || 'auto';
  const beforeColors = data.categories.map((c) => c.color);
  let filter = 'all';
  openDialog((dlg) => {
    dlg.classList.add('wide');
    const grid = h('div', { class: 'theme-grid' });
    const tabs = h('div', { class: 'theme-tabs' });
    const card = (t, label, auto) => {
      const [bg, bg2, , line, text, muted, accent] = t.c;
      const id = auto ? 'auto' : t.id;
      return h('div', {
        class: 'tcard' + ((data.settings.theme || 'auto') === id ? ' sel' : ''),
        style: `background:${bg};color:${text}`,
        onclick: () => { data.settings.theme = id; applyTheme(); paint(); render(); },
      },
      h('div', { class: 'tprev' },
        h('div', { class: 'tb' }, h('span', { class: 'pill', style: `background:${accent}` }), h('span', { class: 'pill', style: `background:${line};width:40px` })),
        h('div', { class: 'row2' }, t.pal.slice(0, 4).map((c, i) =>
          h('span', { class: 'blk', style: `background:${c};margin-top:${(i % 2) * 10}px;margin-bottom:${((i + 1) % 2) * 8}px` })))),
      h('div', { class: 'tname', style: `background:${bg2};color:${text}` },
        h('span', {}, label),
        h('span', { class: 'tdots' }, t.pal.slice(0, 5).map((c) => h('span', { style: `background:${c}` })))),
      );
    };
    const paint = () => {
      tabs.replaceChildren(...[['all', 'All'], ['dark', 'Dark'], ['light', 'Light']].map(([k, l]) =>
        h('button', { class: filter === k ? 'on' : '', onclick: () => { filter = k; paint(); } }, l)));
      const list = window.THEMES.filter((t) => filter === 'all' || (filter === 'dark') === t.dark);
      const auto = window.THEMES.find((x) => x.id === (darkQuery.matches ? 'midnight' : 'paper'));
      grid.replaceChildren(...(filter === 'all' ? [card(auto, window.cal.isMac ? 'Match macOS' : (IS_WEB ? 'Match my phone' : 'Match Windows'), true)] : []), ...list.map((t) => card(t, t.name)));
    };
    paint();
    dlg.append(h('h2', {}, 'Colour theme'),
      h('div', { class: 'hint', style: 'margin:-6px 0 10px' }, 'Click a theme to try it. Your category colours stay as they are unless you recolour them below.'),
      tabs, grid,
      h('div', { class: 'btns' },
        h('button', {
          title: "Give your categories this theme's colours, in order",
          onclick: () => {
            const pal = currentTheme().pal;
            if (!confirm("Recolour your categories with this theme's colours?")) return;
            data.categories.forEach((c, i) => { c.color = pal[i % pal.length]; });
            render();
          },
        }, 'Recolour my categories to match'),
        h('span', { class: 'spacer' }),
        h('button', { onclick: () => {
          data.settings.theme = before;
          data.categories.forEach((c, i) => { if (beforeColors[i]) c.color = beforeColors[i]; });
          applyTheme(); render(); closeDialog();
        } }, 'Cancel'),
        h('button', { class: 'primary', onclick: () => { save(); closeDialog(); } }, 'Done')));
  });
}

/* ---------------- tasks ---------------- */

const tasks = () => data.tasks || (data.tasks = []);
const visibleTasks = () => tasks().filter((t) => !hidden.has(t.category || ''));
const tasksOn = (date) => (busyMode ? [] : visibleTasks().filter((t) => t.date === date));

function fmtShort(s) {
  const d = parse(s);
  return `${WD[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}
function relDay(s) {
  const n = Recur.dayNum(s) - Recur.dayNum(today());
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return fmtShort(s);
}
function setDone(t, v) {
  t.done = v;
  t.doneAt = v ? today() : '';
  save();
  render();
}
function taskTip(t) {
  return [`Task: ${t.title}`, cat(t.category).name, t.done ? `Done ${t.doneAt ? fmtShort(t.doneAt) : ''}` : (t.date ? `Planned ${fmtShort(t.date)}` : 'Not planned'), t.notes || ''].filter(Boolean).join('\n');
}

// Small task bar used in the month and week views.
function taskBar(t) {
  return h('div', {
    class: 'tbar' + (t.done ? ' done' : ''), style: `--c:${cat(t.category).color}`, title: taskTip(t),
    ondblclick: (e) => e.stopPropagation(),
    onclick: (e) => { e.stopPropagation(); openTaskEditor(t); },
  },
  h('span', { class: 'tchk', title: t.done ? 'Mark as not done' : 'Tick off', onclick: (e) => { e.stopPropagation(); setDone(t, !t.done); } }, t.done ? '✓' : ''),
  h('span', { class: 'tt' }, t.title || '(untitled)'));
}

function monthTasks(date) {
  const list = tasksOn(date).sort((a, b) => Number(a.done) - Number(b.done));
  if (!list.length) return null;
  const shown = list.length > 2 ? list.slice(0, 1) : list;
  return h('div', { class: 'mtasks' }, shown.map(taskBar),
    list.length > 2 ? h('div', {
      class: 'tmore', title: list.slice(1).map((t) => t.title).join('\n'),
      onclick: (e) => { e.stopPropagation(); view = 'tasks'; render(); },
    }, `+${list.length - 1} tasks`) : null);
}

// Mini month calendar for choosing a task's date. Shows your events and other tasks on each day.
function pickDate({ title, current, exclude, onPick }) {
  const base = parse(current || today());
  let ym = new Date(base.getFullYear(), base.getMonth(), 1);
  popup((box, close) => {
    box.classList.add('picker');
    const body = h('div');
    const choose = (d) => { close(); onPick(d); };
    const paint = () => {
      const first = ymd(ym);
      const start = weekStartOf(first);
      const cells = [...Array(42)].map((_, i) => addDays(start, i));
      const occ = occurrences(visibleEvents(), cells[0], cells[41]);
      const t = today();
      body.replaceChildren(
        h('div', { class: 'pk-head' },
          h('button', { class: 'icon', onclick: () => { ym = new Date(ym.getFullYear(), ym.getMonth() - 1, 1); paint(); } }, '‹'),
          h('b', {}, `${MONTHS[ym.getMonth()]} ${ym.getFullYear()}`),
          h('button', { class: 'icon', onclick: () => { ym = new Date(ym.getFullYear(), ym.getMonth() + 1, 1); paint(); } }, '›')),
        h('div', { class: 'pk-wd' }, [...Array(7)].map((_, i) => h('div', {}, WD[(data.settings.weekStart + i) % 7].slice(0, 2)))),
        h('div', { class: 'pk-grid' }, cells.map((c) => {
          const items = [
            ...visibleTasks().filter((x) => x.date === c && x !== exclude).map((x) => ({ task: true, done: x.done, color: cat(x.category).color, label: x.title })),
            ...occ.filter((o) => o.date === c).sort(sortOcc).map((o) => ({ color: cat(o.ev.category).color, label: (o.ev.allDay ? '' : fmtTime(o.ev.start) + ' ') + (o.ev.title || '') })),
          ];
          const max = 3;
          return h('div', {
            class: 'pk-cell' + (parse(c).getMonth() !== ym.getMonth() ? ' other' : '') + (c === t ? ' today' : '') + (c === current ? ' sel' : '') + (c < t ? ' past' : ''),
            title: `${fmtShort(c)}\n` + (items.length ? items.map((i) => (i.task ? '☐ ' : '• ') + i.label).join('\n') : 'Nothing planned'),
            onclick: () => choose(c),
          },
          h('div', { class: 'pk-num' }, parse(c).getDate()),
          items.slice(0, items.length > max ? max - 1 : max).map((i) =>
            h('div', { class: i.task ? 'pk-task' + (i.done ? ' done' : '') : 'pk-ev', style: `--c:${i.color}` }, i.label)),
          items.length > max ? h('div', { class: 'pk-more' }, `+${items.length - max + 1} more`) : null);
        })));
    };
    paint();
    box.append(h('h2', {}, title), body,
      h('div', { class: 'btns' },
        h('button', { onclick: () => choose(today()) }, 'Today'),
        h('button', { onclick: () => choose(addDays(today(), 1)) }, 'Tomorrow'),
        current ? h('button', { onclick: () => choose('') }, 'Remove date') : null,
        h('span', { class: 'spacer' }),
        h('button', { onclick: close }, 'Cancel')));
  });
}

function planTask(t) {
  pickDate({
    title: `Plan “${t.title}”`, current: t.date || '', exclude: t,
    onPick: (d) => { t.date = d; save(); render(); },
  });
}

function catDots(get, set) {
  const wrap = h('div', { class: 'catdots' });
  const paint = () => wrap.replaceChildren(...data.categories.map((c) =>
    h('span', {
      class: 'cd' + (get() === c.id ? ' sel' : ''), title: c.name, style: `background:${c.color}`,
      onclick: () => { set(c.id); paint(); },
    })));
  paint();
  return wrap;
}

let newTaskCat = null;
function renderTasks() {
  const all = visibleTasks();
  const unplanned = all.filter((t) => !t.done && !t.date);
  const planned = all.filter((t) => !t.done && t.date).sort((a, b) => a.date.localeCompare(b.date));
  const done = all.filter((t) => t.done).sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || ''));
  const t0 = today();
  if (newTaskCat === null || !data.categories.some((c) => c.id === newTaskCat)) {
    newTaskCat = data.settings.lastCategory && data.categories.some((c) => c.id === data.settings.lastCategory)
      ? data.settings.lastCategory : (data.categories[0] || {}).id || '';
  }

  const row = (t, kind) => h('div', { class: 'trow' + (t.done ? ' done' : ''), style: `--c:${cat(t.category).color}` },
    h('span', { class: 'chk', title: t.done ? 'Mark as not done' : 'Tick off', onclick: () => setDone(t, !t.done) }, t.done ? '✓' : ''),
    h('span', { class: 'tname-t', title: taskTip(t), onclick: () => openTaskEditor(t) }, t.title || '(untitled)'),
    kind === 'unplanned' ? h('button', { class: 'plan', title: 'Pick a date', onclick: () => planTask(t) }, '📅 Plan') : null,
    kind === 'planned' ? h('button', {
      class: 'datepill' + (t.date < t0 ? ' late' : '') + (t.date === t0 ? ' now' : ''),
      title: t.date < t0 ? 'Overdue. Click to change the date' : 'Click to change the date', onclick: () => planTask(t),
    }, relDay(t.date)) : null,
    kind === 'done' ? h('span', { class: 'donedate' }, t.doneAt ? relDay(t.doneAt) : '') : null,
    h('button', {
      class: 'icon tdel', title: 'Delete task',
      onclick: () => { data.tasks = tasks().filter((x) => x !== t); save(); render(); },
    }, '✕'));

  const input = h('input', { type: 'text', placeholder: 'Add a task and press Enter' });
  const add = () => {
    const title = input.value.trim();
    if (!title) return;
    tasks().push({ id: crypto.randomUUID(), title, category: newTaskCat, date: '', done: false, doneAt: '', notes: '', created: new Date().toISOString() });
    data.settings.lastCategory = newTaskCat;
    save();
    render();
    setTimeout(() => { const i = $('.tcol input[type=text]'); if (i) i.focus(); }, 0);
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

  const col = (cls, label, count, hint, extra, items) => h('div', { class: 'tcol ' + cls },
    h('div', { class: 'tcol-head' }, h('b', {}, label), h('span', { class: 'count' }, count), h('span', { class: 'spacer' }), extra),
    h('div', { class: 'tcol-hint' }, hint),
    h('div', { class: 'tlist' }, items.length ? items : h('div', { class: 'empty' }, 'Nothing here')));

  const view_ = h('div', { class: 'tasks' },
    col('unplanned', 'Unplanned', unplanned.length, 'No date yet. Plan one, or tick it off when it’s done.',
      null,
      [h('div', { class: 'tadd' }, input, catDots(() => newTaskCat, (id) => { newTaskCat = id; }), h('button', { class: 'primary', onclick: add }, 'Add')),
        ...unplanned.map((t) => row(t, 'unplanned'))]),
    col('planned', 'Planned', planned.length, 'Shown as task bars on your calendar.', null, planned.map((t) => row(t, 'planned'))),
    col('done', 'Completed', done.length, 'Untick to bring a task back.',
      done.length ? h('button', {
        class: 'small', onclick: () => {
          if (!confirm(`Delete all ${done.length} completed task(s)?`)) return;
          data.tasks = tasks().filter((x) => !(x.done && done.includes(x)));
          save(); render();
        },
      }, 'Clear') : null,
      done.map((t) => row(t, 'done'))));
  $('#view').replaceChildren(view_);
}

function openTaskEditor(src) {
  const existing = src && tasks().includes(src) ? src : null;
  const f = {
    title: existing ? existing.title : '',
    category: existing ? existing.category : (newTaskCat || data.settings.lastCategory || (data.categories[0] || {}).id || ''),
    date: existing ? existing.date || '' : '',
    done: existing ? !!existing.done : false,
    notes: existing ? existing.notes || '' : '',
  };
  openDialog((dlg) => {
    const titleIn = h('input', { type: 'text', value: f.title, placeholder: 'Task name' });
    const swatches = h('div', { class: 'swatches' });
    const paintSw = () => swatches.replaceChildren(...data.categories.map((c) =>
      h('span', { class: 'swatch' + (f.category === c.id ? ' sel' : ''), onclick: () => { f.category = c.id; paintSw(); } },
        h('span', { class: 'dot', style: `background:${c.color}` }), c.name)));
    paintSw();
    const dateBtn = h('button');
    const paintDate = () => { dateBtn.textContent = f.date ? `📅 ${fmtShort(f.date)}` : '📅 Not planned. Pick a date'; };
    paintDate();
    dateBtn.onclick = () => pickDate({ title: 'Pick a date', current: f.date, exclude: existing, onPick: (d) => { f.date = d; paintDate(); } });
    const doneIn = h('input', { type: 'checkbox', id: 'tdone' });
    doneIn.checked = f.done;
    const notesIn = h('textarea', { placeholder: 'Notes (optional)' });
    notesIn.value = f.notes;

    const doSave = () => {
      const vals = { title: titleIn.value.trim() || '(untitled)', category: f.category, date: f.date, notes: notesIn.value };
      if (existing) {
        Object.assign(existing, vals);
        if (doneIn.checked !== !!existing.done) { existing.done = doneIn.checked; existing.doneAt = doneIn.checked ? today() : ''; }
      } else {
        tasks().push({ id: crypto.randomUUID(), ...vals, done: doneIn.checked, doneAt: doneIn.checked ? today() : '', created: new Date().toISOString() });
      }
      data.settings.lastCategory = f.category;
      save(); closeDialog(); render();
    };
    titleIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) doSave(); });

    dlg.append(h('h2', {}, existing ? 'Edit task' : 'New task'),
      h('div', { class: 'row' }, titleIn),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Category'), swatches),
      h('div', { class: 'row' }, h('label', { class: 'l' }, 'Date'), dateBtn),
      h('div', { class: 'row' }, h('label', { class: 'l' }, ''), h('label', { for: 'tdone', style: 'display:flex;gap:6px;align-items:center' }, doneIn, 'Completed')),
      h('div', { class: 'row' }, notesIn),
      h('div', { class: 'btns' },
        existing ? h('button', { class: 'danger', onclick: () => { data.tasks = tasks().filter((x) => x !== existing); save(); closeDialog(); render(); } }, 'Delete') : null,
        h('span', { class: 'spacer' }),
        h('button', { onclick: closeDialog }, 'Cancel'),
        h('button', { class: 'primary', onclick: doSave }, 'Save')));
  });
}

/* ---------------- sharing ---------------- */

function periodName() {
  if (view === 'week') {
    const s0 = weekStartOf(cursor);
    return `week of ${fmtShort(s0)} ${parse(s0).getFullYear()}`;
  }
  const d = parse(cursor);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
const fileSafe = (t) => t.replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-');
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

// Render a clean version of the current view, take a picture of it, then put things back.
async function snapshot(busy, action) {
  hold(1);
  closeDialog();
  const root = document.documentElement;
  const oldHour = root.style.getPropertyValue('--hour');
  const oldMemo = scrollMemo;
  busyMode = busy;
  document.body.classList.add('snap');
  render();
  if (view === 'week') {
    // Fit the day (from the "scroll to" hour until midnight) into the picture.
    const sc = $('.week-scroll');
    const from = data.settings.dayStartHour ?? 7;
    root.style.setProperty('--hour', `${Math.max(18, sc.clientHeight / (24 - from))}px`);
    scrollMemo = null;
    render();
  }
  await nextFrame();
  await new Promise((r) => setTimeout(r, 60));
  const r = $('#panel').getBoundingClientRect();
  let result = null;
  try { result = await action({ x: r.left, y: r.top, width: r.width, height: r.height }); } catch (err) { console.error(err); }
  busyMode = false;
  document.body.classList.remove('snap');
  if (oldHour) root.style.setProperty('--hour', oldHour); else root.style.removeProperty('--hour');
  scrollMemo = oldMemo;
  render();
  hold(-1);
  return result;
}

// Calendar file (.ics) that Google Calendar, Outlook and Apple Calendar can import.
function buildIcs(busy) {
  const esc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => '\\' + m);
  const ymdC = (s) => s.replace(/-/g, '');
  const dt = (date, time) => `${ymdC(date)}T${time.replace(':', '')}00`;
  // Lines longer than 75 bytes are split, as the calendar file format requires.
  const enc = new TextEncoder();
  const fold = (line) => {
    const out = [];
    let cur = '', bytes = 0;
    for (const ch of line) {
      const n = enc.encode(ch).length;
      if (bytes + n > 73) { out.push(cur); cur = ' '; bytes = 1; }
      cur += ch;
      bytes += n;
    }
    out.push(cur);
    return out.join('\r\n');
  };
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Hover Calendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${busy ? 'Busy times' : 'Hover Calendar'}`];
  for (const ev of visibleEvents()) {
    const r = ev.repeat || { freq: 'none' };
    // Start on the first real occurrence.
    let first = ev.date;
    if (r.freq !== 'none') {
      for (let i = 0; i < 800 && !occursOn(ev, first); i++) first = addDays(first, 1);
      if (!occursOn(ev, first)) continue;
    }
    const n = Math.max(1, Number(r.interval) || 1);
    let rule = '';
    if (r.freq === 'daily') rule = `FREQ=DAILY;INTERVAL=${n}`;
    else if (r.freq === 'weekdays') rule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    else if (r.freq === 'weekly') rule = `FREQ=WEEKLY;INTERVAL=${n};WKST=MO;BYDAY=${(r.days && r.days.length ? r.days : [weekday(ev.date)]).map((d) => BYDAY[d]).join(',')}`;
    else if (r.freq === 'monthly') rule = `FREQ=MONTHLY;INTERVAL=${n};BYMONTHDAY=${parse(ev.date).getDate()}`;
    else if (r.freq === 'yearly') rule = `FREQ=YEARLY;INTERVAL=${n}`;
    if (rule && r.until) rule += ev.allDay ? `;UNTIL=${ymdC(r.until)}` : `;UNTIL=${ymdC(r.until)}T235959`;
    const ev_ = ['BEGIN:VEVENT', `UID:${ev.id}@hovercalendar`, `DTSTAMP:${now}`, `SUMMARY:${esc(busy ? 'Busy' : ev.title)}`];
    if (ev.allDay) {
      ev_.push(`DTSTART;VALUE=DATE:${ymdC(first)}`, `DTEND;VALUE=DATE:${ymdC(addDays(first, 1))}`);
    } else {
      const end = toMin(ev.end) > toMin(ev.start) ? ev.end : minToTime(toMin(ev.start) + 60);
      ev_.push(`DTSTART:${dt(first, ev.start)}`, `DTEND:${dt(first, end)}`);
    }
    if (rule) ev_.push(`RRULE:${rule}`);
    for (const x of ev.exdates || []) ev_.push(ev.allDay ? `EXDATE;VALUE=DATE:${ymdC(x)}` : `EXDATE:${dt(x, ev.start)}`);
    if (!busy) {
      ev_.push(`CATEGORIES:${esc(cat(ev.category).name)}`);
      const notes = parseNotes(ev.notes).map((l) => (l.check ? '☐ ' : '') + l.text).join('\n').trim();
      if (notes) ev_.push(`DESCRIPTION:${esc(notes)}`);
    }
    ev_.push('END:VEVENT');
    lines.push(...ev_);
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function openShare() {
  if (view === 'tasks') { view = 'week'; render(); }
  openDialog((dlg) => {
    const busy = h('input', { type: 'checkbox', id: 'busy' });
    const status = h('div', { class: 'hint', style: 'margin:8px 0 0' });
    const what = view === 'week' ? 'this week' : 'this month';
    const big = (icon, title, sub, onclick) => h('button', { class: 'share-opt', onclick },
      h('span', { class: 'si' }, icon), h('span', {}, h('b', {}, title), h('small', {}, sub)));
    dlg.append(h('h2', {}, `Share ${what}`),
      h('div', { class: 'hint', style: 'margin:-6px 0 12px' }, periodName()),
      h('div', { class: 'choice' },
        IS_WEB ? null : big('📋', 'Copy as a picture', 'Then paste it into WhatsApp, Messages, email…', async () => {
          await snapshot(busy.checked, (rect) => window.cal.copyPicture(rect));
          toast(`Picture copied. Paste it anywhere with ${window.cal.isMac ? '⌘V' : 'Ctrl+V'}.`);
        }),
        IS_WEB ? null : big('🖼', 'Save as a picture…', 'A PNG image you can send or print', async () => {
          const file = await snapshot(busy.checked, (rect) => window.cal.savePicture(rect, `Calendar ${fileSafe(periodName())}.png`));
          if (file) toast('Picture saved.');
        }),
        big('📅', 'Save as a calendar file (.ics)…', 'People open it to add your events to Google, Outlook or Apple Calendar. Includes repeats.', async () => {
          closeDialog();
          hold(1);
          try {
            const file = await window.cal.saveText(buildIcs(busy.checked), busy.checked ? 'Busy-times.ics' : 'My-calendar.ics', 'Calendar file', 'ics');
            if (file) toast('Calendar file saved.');
          } finally { hold(-1); }
        })),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('label', { for: 'busy', style: 'display:flex;gap:6px;align-items:center' }, busy, 'Only show when I’m busy (hide event names, notes and tasks)')),
      status,
      h('div', { class: 'btns' }, h('span', { class: 'spacer' }), h('button', { onclick: closeDialog }, 'Close')));
  });
}

function toast(msg) {
  const t = h('div', { class: 'toast' }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('out'), 2200);
  setTimeout(() => t.remove(), 2700);
}

/* ---------------- wiring ---------------- */

function step(dir) {
  if (view === 'week') cursor = addDays(cursor, 7 * dir);
  else {
    const d = parse(cursor);
    cursor = ymd(new Date(d.getFullYear(), d.getMonth() + dir, 1));
  }
  render();
}

$('#prevBtn').onclick = () => step(-1);
$('#nextBtn').onclick = () => step(1);
$('#todayBtn').onclick = () => { cursor = today(); scrollMemo = null; render(); };
for (const b of document.querySelectorAll('#viewSeg button')) b.onclick = () => { view = b.dataset.view; render(); };
$('#newBtn').onclick = () => view === 'tasks' ? openTaskEditor(null) : openEditor({ date: view === 'week' && weekStartOf(cursor) !== weekStartOf(today()) ? weekStartOf(cursor) : today() });
$('#catBtn').onclick = openCategories;
$('#shareBtn').onclick = openShare;
$('#themeBtn').onclick = openThemes;
$('#settingsBtn').onclick = openSettings;
$('#pinBtn').onclick = () => window.cal.setPinned(!pinned);
$('#hideBtn').onclick = () => window.cal.collapse();
$('.tab-date').onclick = () => window.cal.expand();

// Drag the tab by its dotted strip. The main process moves the window with the cursor.
const grip = $('#grip');
let dragging = false;
grip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragging = true;
  grip.setPointerCapture(e.pointerId);
  window.cal.dragStart();
});
const endDrag = () => { if (dragging) { dragging = false; window.cal.dragEnd(); } };
grip.addEventListener('pointerup', endDrag);
grip.addEventListener('lostpointercapture', endDrag);
window.addEventListener('blur', endDrag);

document.addEventListener('keydown', (e) => {
  const layers = document.querySelectorAll('.layer');
  if (layers.length) {
    if (e.key === 'Escape') layers[layers.length - 1].close();
    return;
  }
  if (!$('#backdrop').hidden) {
    if (e.key === 'Escape') closeDialog();
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // Ctrl+Enter = Save in any dialog.
      e.preventDefault();
      const btn = $('#dialog .btns .primary');
      if (btn) btn.click();
    }
    return;
  }
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Escape') window.cal.collapse();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
  else if (e.key === 't') $('#todayBtn').click();
  else if (e.key === 'w') { view = 'week'; render(); }
  else if (e.key === 'm') { view = 'month'; render(); }
  else if (e.key === 'k') { view = 'tasks'; render(); }
  else if (e.key === 'n') $('#newBtn').click();
});

function applyMode(m) {
  document.body.classList.toggle('collapsed', m.mode === 'collapsed');
  document.body.classList.toggle('edge-left', m.anchor === 'left');
  document.body.classList.toggle('edge-right', m.anchor !== 'left');
  // The panel keeps its full size while the window slides open around it.
  $('#panel').style.width = m.panel.w + 'px';
  $('#panel').style.height = m.panel.h + 'px';
  pinned = m.pinned;
}
let lastMode = null;
window.cal.onMode((m) => {
  lastMode = m;
  applyMode(m);
  if (data) {
    $('#pinBtn').classList.toggle('on', pinned);
    if (m.mode === 'expanded') render();
  }
});
window.cal.onSettings((s) => { data.settings = { ...data.settings, ...s }; render(); });

// Keep the "now" line and today's tab fresh.
setInterval(() => { if (data) { renderTab(); if (view === 'week' && document.body.classList.contains('collapsed') === false) render(); } }, 60 * 1000);

window.cal.onReplaced(({ doc, rev: r }) => applyRemote(doc, r));

(async () => {
  const loaded = await window.cal.load();
  data = loaded.doc;
  rev = loaded.rev;
  if (!Array.isArray(data.tasks)) data.tasks = [];
  lastSaved = Sync.clone(data);
  applyTheme();
  render();
})();
