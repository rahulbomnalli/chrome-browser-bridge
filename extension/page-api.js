async function inPageFetchMany(options) {
  const { requests, timeoutMs = 20000, maxResponseChars = 10000 } = options;
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 20) {
    throw new Error('page_fetch_many requires 1 to 20 requests');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new Error('Invalid page fetch timeout');
  }
  if (!Number.isInteger(maxResponseChars) || maxResponseChars < 256 || maxResponseChars > 50000) {
    throw new Error('maxResponseChars must be an integer between 256 and 50000');
  }
  for (const request of requests) {
    if (!request || typeof request.url !== 'string' || !request.url.trim()) {
      throw new Error('Each page fetch request requires a URL');
    }
    if (request.headers !== undefined && (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers))) {
      throw new Error('Request headers must be an object');
    }
  }

  const results = await Promise.all(requests.map(async (request, index) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await window.fetch(request.url, {
        method: request.method || 'GET',
        headers: request.headers || {},
        body: request.body === undefined || request.body === null
          ? undefined
          : (typeof request.body === 'object' ? JSON.stringify(request.body) : request.body),
        credentials: 'include',
        signal: controller.signal
      });
      const text = await response.text();
      const truncated = text.length > maxResponseChars;
      let data = text.slice(0, maxResponseChars);
      let isJson = false;
      if (!truncated) {
        try {
          data = JSON.parse(text);
          isJson = true;
        } catch {}
      }
      return {
        name: request.name || String(index + 1),
        url: request.url,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        isJson,
        truncated,
        data
      };
    } catch (error) {
      return {
        name: request.name || String(index + 1),
        url: request.url,
        ok: false,
        error: error.name === 'AbortError' ? `Request timed out after ${timeoutMs}ms` : (error.message || String(error))
      };
    } finally {
      clearTimeout(timer);
    }
  }));
  return { ok: results.every(result => result.ok), results };
}

async function inPageFetchSequence(options) {
  const { requests, timeoutMs = 20000, maxResponseChars = 10000 } = options;
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 20) {
    throw new Error('page_fetch_sequence requires 1 to 20 requests');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000) {
    throw new Error('Invalid page fetch timeout');
  }
  if (!Number.isInteger(maxResponseChars) || maxResponseChars < 256 || maxResponseChars > 50000) {
    throw new Error('maxResponseChars must be an integer between 256 and 50000');
  }

  const names = new Set();
  for (const request of requests) {
    if (!request || typeof request.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(request.name) ||
        ['__proto__', 'constructor', 'prototype'].includes(request.name) || names.has(request.name)) {
      throw new Error('Each API sequence request requires a unique safe name');
    }
    if (typeof request.url !== 'string' || !request.url.trim()) throw new Error('Each API sequence request requires a URL');
    if (request.headers !== undefined && (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers))) {
      throw new Error('Request headers must be an object');
    }
    names.add(request.name);
  }

  const results = Object.create(null);
  const completed = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  function expand(value) {
    if (typeof value === 'string') return value.replace(/\{\{results\.([A-Za-z][A-Za-z0-9_]*)(?:\.([A-Za-z0-9_.]+))?\}\}/g, (_match, name, path) => {
      if (!Object.prototype.hasOwnProperty.call(results, name)) {
        throw new Error(`API sequence reference must point to an earlier response: ${name}`);
      }
      let resolved = results[name];
      for (const key of (path || '').split('.').filter(Boolean)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key) ||
            resolved == null || !Object.prototype.hasOwnProperty.call(resolved, key)) {
          throw new Error(`Unresolved API response value: ${name}.${path}`);
        }
        resolved = resolved[key];
      }
      if (resolved === null || typeof resolved === 'object') return JSON.stringify(resolved);
      return String(resolved);
    });
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)]));
    }
    return value;
  }

  try {
    for (const request of requests) {
      let current;
      try {
        current = expand(request);
      } catch (error) {
        return { ok: false, completed: completed.length, failedRequest: request.name, results: completed, error: error.message || String(error) };
      }
      let response;
      try {
        response = await window.fetch(current.url, {
          method: current.method || 'GET',
          headers: current.headers || {},
          body: current.body === undefined || current.body === null
            ? undefined
            : (typeof current.body === 'object' ? JSON.stringify(current.body) : current.body),
          credentials: 'include',
          signal: controller.signal
        });
      } catch (error) {
        const message = error.name === 'AbortError' ? `API sequence timed out after ${timeoutMs}ms` : (error.message || String(error));
        return { ok: false, completed: completed.length, failedRequest: request.name, results: completed, error: message };
      }
      let text;
      try {
        text = await response.text();
      } catch (error) {
        const message = error.name === 'AbortError' ? `API sequence timed out after ${timeoutMs}ms` : (error.message || String(error));
        return { ok: false, completed: completed.length, failedRequest: request.name, results: completed, error: message };
      }
      const truncated = text.length > maxResponseChars;
      let data = text.slice(0, maxResponseChars);
      let isJson = false;
      if (!truncated) {
        try {
          data = JSON.parse(text);
          isJson = true;
        } catch {}
      }
      const item = {
        name: request.name,
        url: current.url,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        isJson,
        truncated,
        data
      };
      completed.push(item);
      if (!response.ok) {
        return { ok: false, completed: completed.length, failedRequest: request.name, results: completed, error: `HTTP ${response.status} ${response.statusText}` };
      }
      results[request.name] = data;
    }
    return { ok: true, completed: completed.length, results: completed };
  } finally {
    clearTimeout(timer);
  }
}

function inPageRunScript(options) {
  const { code, args = {}, maxOutputChars = 20000 } = options;
  if (typeof code !== 'string' || !code.trim() || code.length > 100000) {
    throw new Error('JavaScript code must contain 1 to 100000 characters');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Script args must be an object');
  if (!Number.isInteger(maxOutputChars) || maxOutputChars < 256 || maxOutputChars > 50000) {
    throw new Error('maxOutputChars must be an integer between 256 and 50000');
  }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('args', `"use strict";\n${code}`);
  return Promise.resolve(execute(args)).then(value => {
    const serialized = JSON.stringify(value === undefined ? null : value);
    if (serialized.length > maxOutputChars) {
      return {
        ok: true,
        truncated: true,
        originalChars: serialized.length,
        preview: serialized.slice(0, maxOutputChars)
      };
    }
    return { ok: true, result: JSON.parse(serialized) };
  });
}

function inPageObservedResources() {
  const entries = performance.getEntriesByType('resource');
  return entries.slice(-500).filter(entry =>
    ['xmlhttprequest', 'fetch'].includes(entry.initiatorType) ||
    /\/api(?:\/|[?#]|$)|graphql|\/rpc(?:\/|[?#]|$)/i.test(entry.name)
  ).map(entry => ({
    type: 'request',
    url: entry.name,
    resourceType: entry.initiatorType,
    status: entry.responseStatus || undefined,
    timestamp: performance.timeOrigin + entry.startTime
  }));
}

if (typeof module !== 'undefined') module.exports = { inPageFetchMany, inPageFetchSequence, inPageRunScript, inPageObservedResources };
