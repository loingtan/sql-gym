import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { loadContent, TRACKS } from './content.js';
import * as db from './runner.js';

const PUBLIC = new URL('./public/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const routes = {
  'GET /api/content': () => ({ tracks: TRACKS, units: loadContent().units }),
  'GET /api/schema': () => db.schemaInfo(),
  'GET /api/progress': () => db.getProgress(),
  'POST /api/progress': ({ id }) => {
    if (!/^quiz:[\w-]+$/.test(id)) throw new Error('Only quiz results are posted directly');
    return db.savePass(id).then(() => ({ ok: true }));
  },
  'DELETE /api/progress': () => db.resetProgress().then(() => ({ ok: true })),
  'POST /api/run': async ({ id, setup, query }) => {
    const ex = loadContent().exercises.get(id);
    if (!ex) throw new Error(`No exercise ${id}`);
    const r = await db.runExercise(ex, { setup, query });
    if (r.passed) await db.savePass(id, r.ms ?? null, r.speedup ?? null);
    return r;
  },
  'POST /api/console': ({ schema, sql, explain }) => db.runConsole(schema, sql, explain),
};

async function body(req) {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : {};
}

const send = (res, status, type, data) => res.writeHead(status, { 'content-type': type }).end(data);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (route) return send(res, 200, 'application/json', JSON.stringify(await route(await body(req))));
    const path = normalize(join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!path.startsWith(PUBLIC)) return send(res, 403, 'text/plain', 'Forbidden');
    send(res, 200, TYPES[extname(path)] ?? 'application/octet-stream', await readFile(path));
  } catch (e) {
    if (e.code === 'ENOENT') return send(res, 404, 'text/plain', 'Not found');
    send(res, 500, 'application/json', JSON.stringify({ error: e.message }));
  }
}).listen(process.env.PORT ?? 3000, () => console.log(`Query Gym on http://localhost:${process.env.PORT ?? 3000}`));
