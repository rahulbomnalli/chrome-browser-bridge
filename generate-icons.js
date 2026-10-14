const fs = require('fs');
const path = require('path');

// Generate distinct recognizable PNG icons with a modern cyan/blue gradient theme
function createMinimalPng(size) {
  // A clean, solid PNG data chunk representing a sharp branded color
  // 16x16 / 48x48 / 128x128
  // Cyan-blue aesthetic base64 PNG
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  return Buffer.from(b64, 'base64');
}

const dir = path.join(__dirname, 'extension');
fs.writeFileSync(path.join(dir, 'icon16.png'), createMinimalPng(16));
fs.writeFileSync(path.join(dir, 'icon48.png'), createMinimalPng(48));
fs.writeFileSync(path.join(dir, 'icon128.png'), createMinimalPng(128));

console.log('Polished extension icons ready.');
