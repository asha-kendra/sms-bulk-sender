const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = 8792;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let filePath = path.join(root, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(port, () => console.log(`Serving ${root} on http://localhost:${port}`));
