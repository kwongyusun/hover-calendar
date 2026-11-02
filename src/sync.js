// Sync helpers shared by the PC app, the phone web app and the widget.
// Every event, task and category carries `_u` (when it last changed, in ms). Deleted items
// leave a tombstone in `_deleted` so the deletion spreads to other devices. Merging two copies
// keeps the newest version of each item, so edits made on different devices don't overwrite
// each other unless they touch the very same item.
(function (root) {
  const COLLECTIONS = ['events', 'tasks', 'categories'];
  const LOCAL_SETTINGS = ['tabX', 'tabY']; // where the tab sits is per device, never synced
  const TOMBSTONE_DAYS = 90;

  const strip = (item) => {
    const { _u, ...rest } = item;
    return JSON.stringify(rest);
  };
  const sharedSettings = (s) => {
    const out = { ...(s || {}) };
    for (const k of LOCAL_SETTINGS) delete out[k];
    return out;
  };

  // Compare the new copy with the last saved one and date-stamp whatever changed.
  // Works in place (same objects stay in use), and returns `next`.
  function stamp(prev, next, now = Date.now()) {
    prev = prev || {};
    next._deleted = { ...(prev._deleted || {}), ...(next._deleted || {}) };
    for (const key of COLLECTIONS) {
      const before = new Map((prev[key] || []).map((x) => [x.id, x]));
      const list = next[key] || (next[key] = []);
      for (const item of list) {
        const old = before.get(item.id);
        before.delete(item.id);
        if (old && strip(old) === strip(item)) item._u = old._u || item._u || now;
        else item._u = now;
        delete next._deleted[`${key}:${item.id}`];
      }
      for (const id of before.keys()) next._deleted[`${key}:${id}`] = now;
    }
    const sPrev = JSON.stringify(sharedSettings(prev.settings));
    const sNext = JSON.stringify(sharedSettings(next.settings));
    next._settingsU = sPrev === sNext ? prev._settingsU || next._settingsU || now : now;
    // Forget very old deletions.
    const cutoff = now - TOMBSTONE_DAYS * 864e5;
    for (const [k, t] of Object.entries(next._deleted)) if (t < cutoff) delete next._deleted[k];
    return next;
  }

  // Merge this device's copy with the copy from the cloud.
  function merge(local, remote) {
    if (!remote) return local;
    if (!local) return remote;
    const deleted = { ...(remote._deleted || {}) };
    for (const [k, t] of Object.entries(local._deleted || {})) deleted[k] = Math.max(deleted[k] || 0, t);
    const out = { ...remote, ...local, _deleted: deleted };
    for (const key of COLLECTIONS) {
      const r = new Map((remote[key] || []).map((x) => [x.id, x]));
      const merged = [];
      const seen = new Set();
      const keep = (item) => {
        const gone = deleted[`${key}:${item.id}`];
        return !(gone && gone >= (item._u || 0));
      };
      for (const item of local[key] || []) {
        const other = r.get(item.id);
        const pick = other && (other._u || 0) > (item._u || 0) ? other : item;
        seen.add(item.id);
        if (keep(pick)) merged.push(pick);
      }
      for (const item of remote[key] || []) {
        if (!seen.has(item.id) && keep(item)) merged.push(item);
      }
      out[key] = merged;
    }
    const remoteNewer = (remote._settingsU || 0) > (local._settingsU || 0);
    const base = remoteNewer ? sharedSettings(remote.settings) : sharedSettings(local.settings);
    out.settings = { ...base };
    for (const k of LOCAL_SETTINGS) if (local.settings && local.settings[k] !== undefined) out.settings[k] = local.settings[k];
    out._settingsU = Math.max(local._settingsU || 0, remote._settingsU || 0);
    return out;
  }

  // What gets uploaded: everything except device-only settings.
  function forCloud(doc) {
    return { ...doc, settings: sharedSettings(doc.settings) };
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const clone = (x) => JSON.parse(JSON.stringify(x));

  const api = { stamp, merge, forCloud, same, clone, COLLECTIONS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Sync = api;
})(typeof window !== 'undefined' ? window : globalThis);
