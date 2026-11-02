// Tiny Supabase client used by the PC app, the phone app and the widget.
// It signs in with email + password, keeps the session fresh, and reads/writes the one
// row in the `calendars` table that belongs to the signed-in person.
(function (root) {
  function decodeJwt(token) {
    try {
      const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      const json = typeof atob === 'function'
        ? decodeURIComponent(escape(atob(part)))
        : Buffer.from(part, 'base64').toString('utf8');
      return JSON.parse(json);
    } catch {
      return {};
    }
  }

  class Cloud {
    // session: { access_token, refresh_token, expires_at (seconds), user_id, email }
    constructor({ url, key, session, onSession }) {
      this.url = String(url || '').replace(/\/+$/, '');
      this.key = key;
      this.session = session || null;
      this.onSession = onSession || (() => {});
    }

    headers(extra = {}) {
      const h = { apikey: this.key, 'Content-Type': 'application/json', ...extra };
      if (this.session) h.Authorization = `Bearer ${this.session.access_token}`;
      return h;
    }

    async auth(grant, body) {
      const res = await fetch(`${this.url}/auth/v1/token?grant_type=${grant}`, {
        method: 'POST',
        headers: { apikey: this.key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = json.error_description || json.msg || json.message || json.error || `Sign-in failed (${res.status})`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      const claims = decodeJwt(json.access_token);
      this.session = {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: json.expires_at || Math.floor(Date.now() / 1000) + (json.expires_in || 3600),
        user_id: (json.user && json.user.id) || claims.sub,
        email: (json.user && json.user.email) || claims.email || body.email || (this.session && this.session.email) || '',
      };
      this.onSession(this.session);
      return this.session;
    }

    signIn(email, password) {
      return this.auth('password', { email, password });
    }

    async ensure() {
      if (!this.session) throw Object.assign(new Error('Not signed in'), { status: 401 });
      if (this.session.expires_at - 60 < Date.now() / 1000) {
        await this.auth('refresh_token', { refresh_token: this.session.refresh_token });
      }
    }

    signOut() {
      this.session = null;
      this.onSession(null);
    }

    // Returns { data, updated_at } or null if nothing has been uploaded yet.
    async pull() {
      await this.ensure();
      const res = await fetch(`${this.url}/rest/v1/calendars?select=data,updated_at&user_id=eq.${this.session.user_id}`, { headers: this.headers() });
      if (res.status === 401) { await this.auth('refresh_token', { refresh_token: this.session.refresh_token }); return this.pull(); }
      if (!res.ok) throw new Error(`Couldn't download your calendar (${res.status})`);
      const rows = await res.json();
      return rows[0] || null;
    }

    async push(doc) {
      await this.ensure();
      const res = await fetch(`${this.url}/rest/v1/calendars`, {
        method: 'POST',
        headers: this.headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ user_id: this.session.user_id, data: doc, updated_at: new Date().toISOString() }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`Couldn't upload your calendar (${res.status}) ${t.slice(0, 200)}`);
      }
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { Cloud, decodeJwt };
  else root.Cloud = Cloud;
})(typeof window !== 'undefined' ? window : globalThis);
