const http = require('http');

function post(action, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ action, params });
    const req = http.request('http://127.0.0.1:8765/action', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const setRes = await post('set_memory', {
    key: 'linkedin_connect_pattern',
    value: {
      site: 'linkedin.com',
      fastPath: 'search-custom-invite URL direct navigation or anchor click',
      avoidErrors: [
        'Connect is an <a> tag pointing to /preload/search-custom-invite, NOT a <button>',
        'Do not click nested span elements directly',
        'Auto-click Send without a note in modal'
      ],
      optimizedSelector: 'a[href*="search-custom-invite"]',
      updatedAt: Date.now()
    }
  });
  console.log('Set Memory Result:', setRes);

  const getRes = await post('get_memory', { key: 'linkedin_connect_pattern' });
  console.log('Get Memory Result:', JSON.stringify(getRes, null, 2));
})();
