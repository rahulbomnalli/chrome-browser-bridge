async function executeCdpBatch(options, { sendCommand }) {
  const { commands, maxResultChars = 8000 } = options;
  if (!Array.isArray(commands) || commands.length < 1 || commands.length > 20) {
    throw new Error('cdp_batch requires 1 to 20 commands');
  }
  if (!Number.isInteger(maxResultChars) || maxResultChars < 256 || maxResultChars > 20000) {
    throw new Error('maxResultChars must be an integer between 256 and 20000');
  }
  for (const command of commands) {
    if (!command || typeof command.method !== 'string' ||
        !/^[A-Z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(command.method)) {
      throw new Error('Each CDP command requires a domain.method name');
    }
    if (command.params !== undefined &&
        (!command.params || typeof command.params !== 'object' || Array.isArray(command.params))) {
      throw new Error('CDP command params must be an object');
    }
  }

  const started = performance.now();
  if (options.parallel === true) {
    // Explicitly independent commands only. All commands are dispatched, including
    // those after a failure; callers must not use this mode for dependent mutations.
    const settled = await Promise.allSettled(commands.map(command => sendCommand(command.method, command.params || {})));
    const results = settled.map((entry, index) => {
      if (entry.status === 'rejected') return { method: commands[index].method, ok: false, error: entry.reason?.message || String(entry.reason) };
      const result = entry.value ?? null;
      const serialized = JSON.stringify(result);
      return { method: commands[index].method, ok: true, result: serialized.length > maxResultChars ? { truncated: true, preview: serialized.slice(0, maxResultChars), originalChars: serialized.length } : result };
    });
    return { ok: results.every(result => result.ok), parallel: true, completed: results.filter(result => result.ok).length, results, durationMs: performance.now() - started };
  }
  const results = [];
  for (let index = 0; index < commands.length; index++) {
    const command = commands[index];
    try {
      const value = await sendCommand(command.method, command.params || {});
      const serialized = JSON.stringify(value === undefined ? null : value);
      results.push({
        method: command.method,
        ok: true,
        result: serialized.length > maxResultChars
          ? { truncated: true, preview: serialized.slice(0, maxResultChars), originalChars: serialized.length }
          : (value === undefined ? null : value)
      });
    } catch (error) {
      return {
        ok: false,
        completed: results.length,
        failedStep: index,
        results,
        error: error.message || String(error),
        durationMs: performance.now() - started
      };
    }
  }
  return { ok: true, completed: results.length, results, durationMs: performance.now() - started };
}

if (typeof module !== 'undefined') module.exports = { executeCdpBatch };
