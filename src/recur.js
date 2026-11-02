// Date and recurrence helpers. Dates are local 'YYYY-MM-DD' strings, times are 'HH:MM'.
(function (root) {
  const pad = (n) => String(n).padStart(2, '0');

  function ymd(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function parse(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(s, n) {
    const d = parse(s);
    d.setDate(d.getDate() + n);
    return ymd(d);
  }
  // Whole-day number, safe across daylight-saving changes.
  function dayNum(s) {
    const [y, m, d] = s.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 864e5);
  }
  function weekday(s) {
    return parse(s).getDay(); // 0 = Sunday
  }
  // Monday-based week number, used for "every N weeks".
  function weekNum(s) {
    return Math.floor((dayNum(s) + 3) / 7);
  }
  function toMin(t) {
    if (!t) return 0;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }

  function occursOn(ev, s) {
    if (s < ev.date) return false;
    const r = ev.repeat || { freq: 'none' };
    if (r.until && s > r.until) return false;
    if (ev.exdates && ev.exdates.includes(s)) return false;
    const n = Math.max(1, Number(r.interval) || 1);
    switch (r.freq) {
      case 'daily':
        return (dayNum(s) - dayNum(ev.date)) % n === 0;
      case 'weekdays': {
        const wd = weekday(s);
        return wd >= 1 && wd <= 5;
      }
      case 'weekly': {
        const days = r.days && r.days.length ? r.days : [weekday(ev.date)];
        if (!days.includes(weekday(s))) return false;
        return (weekNum(s) - weekNum(ev.date)) % n === 0;
      }
      case 'monthly': {
        const a = parse(ev.date), b = parse(s);
        if (a.getDate() !== b.getDate()) return false;
        const months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
        return months % n === 0;
      }
      case 'yearly': {
        const a = parse(ev.date), b = parse(s);
        if (a.getDate() !== b.getDate() || a.getMonth() !== b.getMonth()) return false;
        return (b.getFullYear() - a.getFullYear()) % n === 0;
      }
      default:
        return s === ev.date;
    }
  }

  // All occurrences of all events between from..to (inclusive), as {ev, date}.
  function occurrences(events, from, to) {
    const out = [];
    for (let s = from; s <= to; s = addDays(s, 1)) {
      for (const ev of events) {
        if (occursOn(ev, s)) out.push({ ev, date: s });
      }
    }
    return out;
  }

  // Lay out overlapping timed events side by side. Adds col / cols to each item.
  function layoutDay(items) {
    const sorted = items
      .map((it) => ({ ...it, s: toMin(it.ev.start), e: Math.max(toMin(it.ev.end), toMin(it.ev.start) + 15) }))
      .sort((a, b) => a.s - b.s || b.e - a.e);
    let cluster = [];
    let colEnds = [];
    let clusterEnd = -1;
    const flush = () => {
      for (const it of cluster) it.cols = colEnds.length;
      cluster = [];
      colEnds = [];
    };
    for (const it of sorted) {
      if (it.s >= clusterEnd && cluster.length) flush();
      let col = colEnds.findIndex((end) => end <= it.s);
      if (col === -1) { col = colEnds.length; colEnds.push(it.e); } else colEnds[col] = it.e;
      it.col = col;
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, it.e);
    }
    flush();
    return sorted;
  }

  const api = { pad, ymd, parse, addDays, dayNum, weekday, toMin, occursOn, occurrences, layoutDay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Recur = api;
})(typeof window !== 'undefined' ? window : globalThis);
