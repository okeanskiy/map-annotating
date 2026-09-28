// Local server: serves the editor, reads/writes <project>/map.json, and pushes
// changes made on disk (e.g. by an agent) to open browser tabs via SSE.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMap, parseMap, stringifyMap } from '../public/js/model.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAP_FILE = 'map.json';
const PREVIEW_FILE = 'preview.png';
const MAX_BODY = 50 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function hash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
}

/** Resolves `rel` inside `root`, or returns null if it escapes it. */
function safeJoin(root, rel) {
  const full = path.resolve(root, '.' + path.sep + decodeURIComponent(rel));
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

export function ensureProject(dir, options = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, MAP_FILE);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, stringifyMap(createMap(options)));
    return true;
  }
  return false;
}

export function startServer({ dir, port = 4178, host = '127.0.0.1', log = console.log } = {}) {
  const root = path.resolve(dir);
  const mapPath = path.join(root, MAP_FILE);
  ensureProject(root);

  // Last known state of map.json on disk.
  let state = readState();
  const clients = new Set();

  function readState() {
    let text;
    try {
      text = fs.readFileSync(mapPath, 'utf8');
    } catch (e) {
      return { rev: null, doc: null, errors: [`cannot read ${MAP_FILE}: ${e.message}`], warnings: [] };
    }
    const { doc, errors, warnings } = parseMap(text);
    return { rev: hash(text), doc: errors.length ? null : doc, errors, warnings };
  }

  function broadcast(payload) {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(msg);
  }

  function snapshot() {
    return { rev: state.rev, doc: state.doc, errors: state.errors, warnings: state.warnings };
  }

  // Poll the file: robust across editors and agents that write via rename.
  fs.watchFile(mapPath, { interval: 250 }, () => {
    const next = readState();
    if (next.rev === state.rev) return; // our own write, or no real change
    state = next;
    log(state.errors.length ? `${MAP_FILE} changed on disk but is invalid` : `${MAP_FILE} changed on disk`);
    broadcast({ type: 'map', ...snapshot() });
  });

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/map' && req.method === 'GET') {
      state = readState();
      return sendJson(res, 200, snapshot());
    }

    if (url.pathname === '/api/map' && req.method === 'PUT') {
      const { doc, baseRev } = JSON.parse((await readBody(req)).toString('utf8'));
      const current = readState();
      if (current.rev !== baseRev) {
        // Someone else (an agent, another tab) changed the file since this client loaded it.
        state = current;
        return sendJson(res, 409, { error: 'map.json changed on disk', ...snapshot() });
      }
      const text = stringifyMap(doc);
      const parsed = parseMap(text);
      if (parsed.errors.length) return sendJson(res, 400, { error: 'invalid map', errors: parsed.errors });
      fs.writeFileSync(mapPath, text);
      state = { rev: hash(text), doc: parsed.doc, errors: [], warnings: parsed.warnings };
      broadcast({ type: 'map', source: req.headers['x-client-id'] || null, ...snapshot() });
      return sendJson(res, 200, { rev: state.rev, warnings: state.warnings });
    }

    if (url.pathname === '/api/upload' && req.method === 'POST') {
      const requested = path.basename(url.searchParams.get('name') || '');
      const ext = path.extname(requested).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) return sendJson(res, 400, { error: 'expected an image file name' });
      // Keep names filesystem- and URL-friendly, and never overwrite an existing file.
      const stem =
        path
          .basename(requested, path.extname(requested))
          .replace(/[^A-Za-z0-9_.-]+/g, '-')
          .replace(/^[-.]+|-+$/g, '') || 'image';
      let name = `${stem}${ext}`;
      for (let n = 2; fs.existsSync(path.join(root, name)); n++) name = `${stem}-${n}${ext}`;
      const data = await readBody(req);
      fs.writeFileSync(path.join(root, name), data);
      return sendJson(res, 200, { file: name });
    }

    if (url.pathname === '/api/preview' && req.method === 'POST') {
      fs.writeFileSync(path.join(root, PREVIEW_FILE), await readBody(req));
      return sendJson(res, 200, { file: PREVIEW_FILE });
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'hello', project: root })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    sendJson(res, 404, { error: 'unknown endpoint' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname.startsWith('/project/')) {
        const file = safeJoin(root, url.pathname.slice('/project/'.length));
        return file ? sendFile(res, file) : sendJson(res, 400, { error: 'bad path' });
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = safeJoin(PUBLIC_DIR, rel);
      return file ? sendFile(res, file) : sendJson(res, 400, { error: 'bad path' });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });

  server.on('close', () => {
    fs.unwatchFile(mapPath);
    for (const c of clients) c.end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({ server, url: `http://${host}:${addr.port}`, root });
    });
  });
}
