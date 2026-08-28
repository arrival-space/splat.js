// Minimal static file server for the prototype: node serve.mjs [port]
// Also accepts POST /scratch/<name>.json — writes the body to scratch/<name>.json
// (used by automation to get results out of the browser without the clipboard).
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, basename } from 'node:path';

const root = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const port = Number(process.argv[2]) || 8734;
const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ply': 'application/octet-stream',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.method === 'POST' && p.startsWith('/scratch/')) {
      const name = basename(p);
      if (!/^[\w.-]+\.(json|webp|sog|ply)$/.test(name)) throw new Error('bad name');
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await mkdir(join(root, 'scratch'), { recursive: true });
      await writeFile(join(root, 'scratch', name), Buffer.concat(chunks));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(root, p));
    if (!file.startsWith(normalize(root))) throw new Error('bad path');
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': mime[extname(file).toLowerCase()] || 'application/octet-stream',
      // cross-origin reads (e.g. the Brush web demo streaming a dataset zip
      // from this server) — localhost is a secure context, so https pages
      // may fetch it, but only with CORS opt-in
      'access-control-allow-origin': '*',
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => console.log(`serving ${root} on http://localhost:${port}/`));
