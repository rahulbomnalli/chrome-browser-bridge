// Event-invalidated caches. Service-worker restarts simply start cold.
function createTabCache(tabs) {
  const entries = new Map();
  const revisions = new Map();
  const invalidate = id => { entries.delete(id); revisions.set(id, (revisions.get(id) || 0) + 1); };
  tabs.onUpdated.addListener((id, _change, tab) => { invalidate(id); entries.set(id, tab); });
  tabs.onRemoved.addListener(invalidate);
  tabs.onReplaced?.addListener((_added, removed) => invalidate(removed));
  tabs.onActivated?.addListener(({ tabId, windowId }) => {
    for (const [id, tab] of entries) if (tab.windowId === windowId) entries.set(id, { ...tab, active: id === tabId });
  });
  return {
    async get(id) {
      if (entries.has(id)) return entries.get(id);
      const revision = revisions.get(id);
      const tab = await tabs.get(id);
      if (revision === revisions.get(id)) entries.set(id, tab);
      return tab;
    },
    invalidate
  };
}

function createStorageCache(storage) {
  const values = new Map();
  storage.onChanged.addListener((changes, area) => {
    if (area === 'local') for (const key of Object.keys(changes)) values.delete(key);
  });
  return {
    get(key) {
      if (!values.has(key)) {
        const pending = storage.local.get(key).then(result => result[key] || {}).catch(error => {
          if (values.get(key) === pending) values.delete(key);
          throw error;
        });
        values.set(key, pending);
      }
      return values.get(key);
    },
    invalidate(key) { values.delete(key); }
  };
}
if (typeof module !== 'undefined') module.exports = { createTabCache, createStorageCache };
