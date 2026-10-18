// Per-install bearer authentication token management for Chrome Browser Bridge
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const TOKEN_DIR = path.join(os.homedir(), '.chrome-browser-bridge');
const TOKEN_PATH = path.join(TOKEN_DIR, 'token');

let cachedToken = null;

function getAuthToken() {
  if (process.env.BRIDGE_AUTH_TOKEN) {
    return process.env.BRIDGE_AUTH_TOKEN.trim();
  }
  if (cachedToken) return cachedToken;

  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const content = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
      if (content.length >= 32) {
        cachedToken = content;
        return cachedToken;
      }
    }
  } catch (err) {
    // Fall through to generation if unreadable
  }

  // Generate unguessable per-install cryptographic token
  const generated = crypto.randomBytes(32).toString('hex');
  try {
    if (!fs.existsSync(TOKEN_DIR)) {
      fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(TOKEN_PATH, generated, { mode: 0o600, encoding: 'utf8' });
    cachedToken = generated;
  } catch (writeErr) {
    // If filesystem write fails, keep token in-memory for the current process
    cachedToken = generated;
  }

  return cachedToken;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const expected = getAuthToken();
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);
  if (tokenBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(tokenBuf, expectedBuf);
}

module.exports = { getAuthToken, verifyToken, TOKEN_PATH };
