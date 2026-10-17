const SAFE_API_HEADERS = new Set(['accept', 'content-type', 'x-requested-with']);

function buildObservedApiCatalog(options) {
  const { entries, filter, limit = 30 } = options;
  if (!Array.isArray(entries)) throw new Error('API catalog entries must be an array');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('API catalog limit must be an integer between 1 and 100');
  }
  const query = typeof filter === 'string' ? filter.trim().toLowerCase() : '';
  const latest = new Map();

  for (const entry of entries) {
    if (entry.type !== 'request' || typeof entry.url !== 'string') continue;
    const resourceType = String(entry.resourceType || '').toLowerCase();
    const apiLike = ['xhr', 'fetch'].includes(resourceType) ||
      /\/api(?:\/|[?#]|$)|graphql|\/rpc(?:\/|[?#]|$)/i.test(entry.url) ||
      /application\/(?:[^;]+\+)?json/i.test(entry.mimeType || '');
    if (!apiLike) continue;

    let url;
    try {
      url = new URL(entry.url);
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      url.username = '';
      url.password = '';
      for (const key of url.searchParams.keys()) {
        if (/token|auth|key|secret|password|pass|session|cookie|code|signature|credential/i.test(key)) {
          url.searchParams.set(key, '[redacted]');
        }
      }
    } catch {
      continue;
    }
    const safeUrl = url.toString();
    const method = String(entry.method || 'GET').toUpperCase();
    if (query && !`${method} ${safeUrl} ${entry.mimeType || ''} ${entry.status || ''}`.toLowerCase().includes(query)) continue;

    const headers = {};
    for (const [key, value] of Object.entries(entry.headers || {})) {
      const normalized = key.toLowerCase();
      if (SAFE_API_HEADERS.has(normalized) && typeof value === 'string') headers[normalized] = value.slice(0, 200);
    }
    const key = `${method} ${safeUrl}`;
    latest.set(key, {
      method,
      url: safeUrl,
      status: entry.status,
      mimeType: entry.mimeType || null,
      resourceType: entry.resourceType || null,
      headers: Object.keys(headers).length ? headers : undefined,
      timestamp: entry.timestamp
    });
  }

  const requests = [...latest.values()].sort((a, b) => b.timestamp - a.timestamp);
  return { total: requests.length, count: Math.min(requests.length, limit), requests: requests.slice(0, limit) };
}

if (typeof module !== 'undefined') module.exports = { buildObservedApiCatalog };
