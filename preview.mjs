import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const types = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.xml':'application/xml; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8'};
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let target = path.resolve(root, '.' + pathname);
    if (target !== path.resolve(root) && !target.startsWith(root)) { res.writeHead(403).end(); return; }
    if (pathname.endsWith('/')) target = path.join(target, 'index.html');
    let content;
    try { content = await readFile(target); }
    catch {
      if (!path.extname(target)) {
        try { content = await readFile(path.join(target, 'index.html')); target += '/index.html'; }
        catch { res.writeHead(404, {'Content-Type':'text/html; charset=utf-8'}).end(await readFile(path.join(root,'404.html'))); return; }
      } else { res.writeHead(404).end('Not found'); return; }
    }
    res.writeHead(200, {'Content-Type':types[path.extname(target)] || 'application/octet-stream'}).end(content);
  } catch { res.writeHead(400).end('Bad request'); }
});
server.on('error', e => { console.error(e.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Local preview: http://127.0.0.1:${port}`));
