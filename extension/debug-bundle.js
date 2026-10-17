function buildDebugBundle(options) {
  const { networkEntries, consoleEntries, filter, level, limit = 20 } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('Debug bundle limit must be an integer between 1 and 50');
  }
  const normalizedFilter = typeof filter === 'string' && filter ? filter.toLowerCase() : null;
  const normalizedLevel = typeof level === 'string' && level ? level.toLowerCase() : null;
  const network = normalizedFilter
    ? networkEntries.filter(entry =>
      (entry.url && entry.url.toLowerCase().includes(normalizedFilter)) ||
      (entry.method && entry.method.toLowerCase().includes(normalizedFilter)))
    : networkEntries;
  const consoleLogs = consoleEntries.filter(entry =>
    (!normalizedLevel || entry.level?.toLowerCase() === normalizedLevel) &&
    (!normalizedFilter || entry.text?.toLowerCase().includes(normalizedFilter)));

  return {
    network: {
      total: networkEntries.length,
      count: Math.min(network.length, limit),
      logs: network.slice(-limit).map(entry => ({
        reqId: entry.requestId,
        t: entry.timestamp,
        m: entry.method,
        url: entry.url ? (entry.url.length > 120 ? `${entry.url.slice(0, 117)}...` : entry.url) : null,
        status: entry.status,
        type: entry.mimeType || entry.type
      }))
    },
    console: {
      total: consoleEntries.length,
      count: Math.min(consoleLogs.length, limit),
      logs: consoleLogs.slice(-limit).map(entry => ({
        lvl: entry.level,
        txt: entry.text ? (entry.text.length > 150 ? `${entry.text.slice(0, 147)}...` : entry.text) : '',
        cnt: entry.count || 1,
        loc: entry.stack ? entry.stack.split('\n')[0] : (entry.url ? `${entry.url}:${entry.lineNumber || entry.line || ''}` : null)
      }))
    }
  };
}

if (typeof module !== 'undefined') module.exports = { buildDebugBundle };
