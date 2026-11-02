/* global Cloud, Sync */
// Runs the calendar in a phone browser: keeps a copy on the phone (works offline) and syncs it
// with your Supabase project. Stands in for the PC app's window.cal bridge.
(function () {
  const CFG = window.HC_CONFIG || {};
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const clone = (x) => JSON.parse(JSON.stringify(x));

  const cloud = new Cloud({ url: CFG.url, key: CFG.key, session: store.get('hc-session'), onSession: (s) => (s ? store.set('hc-session', s) : store.del('hc-session')) });
  let doc = store.get('hc-data');
  let rev = 1;
  let onReplaced = null;
  let syncing = false, again = false, timer = null;
  let state = { status: cloud.session ? 'ok' : 'signed-out', at: 0, error: '' };

  function defaults() {
    return {
      version: 2,
      settings: { weekStart: 1, hour12: false, dayStartHour: 7, monthFrom: 6, monthTo: 24, theme: 'auto' },
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

  function keep() { store.set('hc-data', doc); }

  function replaced() {
    rev++;
    if (onReplaced) onReplaced({ doc: clone(doc), rev });
  }

  async function syncNow() {
    if (!cloud.session || !navigator.onLine) return;
    if (syncing) { again = true; return; }
    syncing = true;
    state = { ...state, status: 'syncing' };
    try {
      const row = await cloud.pull();
      const remote = row && row.data;
      const merged = Sync.merge(doc, remote);
      if (!Sync.same(merged, doc)) { doc = merged; keep(); replaced(); }
      if (!remote || !Sync.same(Sync.forCloud(doc), remote)) await cloud.push(Sync.forCloud(doc));
      state = { status: 'ok', at: Date.now(), error: '' };
    } catch (err) {
      if ((err.status === 400 || err.status === 401) && /refresh|token|jwt|session/i.test(err.message)) {
        cloud.signOut();
        state = { status: 'signed-out', at: 0, error: 'Please sign in again.' };
        location.reload();
      } else {
        state = { ...state, status: 'error', error: err.message || String(err) };
      }
    } finally {
      syncing = false;
      if (again) { again = false; schedule(300); }
    }
  }
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(syncNow, ms); }

  // Sign-in screen shown the first time.
  function login() {
    return new Promise((resolve) => {
      const email = Object.assign(document.createElement('input'), { type: 'email', placeholder: 'Email', autocomplete: 'username' });
      const pw = Object.assign(document.createElement('input'), { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
      const btn = Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Sign in' });
      const msg = Object.assign(document.createElement('div'), { className: 'login-msg' });
      const box = document.createElement('div');
      box.className = 'login';
      const card = document.createElement('div');
      card.className = 'login-card';
      card.innerHTML = '<img src="icon-192.png" alt=""><h2>Hover Calendar</h2><p>Sign in with the email and password you set up in Supabase.</p>';
      card.append(email, pw, btn, msg);
      box.append(card);
      document.body.append(box);
      if (!CFG.url || !CFG.key) { msg.textContent = 'This copy of the app has not been connected to a Supabase project yet.'; btn.disabled = true; }
      const go = async () => {
        msg.textContent = 'Signing in…';
        btn.disabled = true;
        try {
          await cloud.signIn(email.value.trim(), pw.value);
          box.remove();
          resolve();
        } catch (err) {
          msg.textContent = err.message || 'Could not sign in.';
          btn.disabled = false;
        }
      };
      btn.onclick = go;
      pw.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    });
  }

  async function shareFile(text, name) {
    const file = new File([text], name, { type: 'text/calendar' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return name; } catch { return null; }
    }
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    return name;
  }

  const noop = () => {};
  window.cal = {
    isWeb: true,
    async load() {
      if (!cloud.session) await login();
      if (!doc) {
        try { const row = await cloud.pull(); doc = row && row.data; } catch { /* offline: start empty */ }
      }
      if (!doc) doc = Sync.stamp(null, defaults());
      keep();
      setTimeout(syncNow, 200);
      return { doc: clone(doc), rev };
    },
    save(d, baseRev) {
      if (baseRev === rev) doc = clone(d);
      else { doc = Sync.merge(clone(d), doc); replaced(); }
      keep();
      schedule(800);
    },
    holdOpen: noop, setPinned: noop, expand: noop, collapse: noop, dragStart: noop, dragEnd: noop, resetTab: noop, setLogin: noop, quit: noop,
    saveText: (text, name) => shareFile(text, name),
    onReplaced(fn) { onReplaced = fn; },
    onSyncState: noop,
    syncState: async () => ({ ...state, email: cloud.session && cloud.session.email }),
    syncConnect: async () => ({ ok: false, error: 'Not available here' }),
    async syncDisconnect() { cloud.signOut(); store.del('hc-data'); location.reload(); },
    syncNow: () => schedule(0),
    onMode(fn) {
      const send = () => fn({ mode: 'expanded', anchor: 'left', panel: { w: window.innerWidth, h: window.innerHeight }, pinned: false });
      setTimeout(send, 0);
      window.addEventListener('resize', send);
    },
    onSettings: noop,
  };

  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(0); });
  window.addEventListener('online', () => schedule(0));
  setInterval(() => { if (!document.hidden) syncNow(); }, 30 * 1000);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(noop);
})();
