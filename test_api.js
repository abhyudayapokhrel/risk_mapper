const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/demo-earthquake',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => console.log('Response:', data));
});

req.on('error', (e) => console.error('Error:', e.message));
req.write(JSON.stringify({ magnitude: 6.5 }));
req.end();
