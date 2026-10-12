#!/usr/bin/env node
/**
 * Two stand-in "outside" sites for the browser suite (playwright.config.ts
 * starts this next to `next dev`), on hosts the app is NOT on — 127.0.0.1,
 * while the app is on localhost — so the lobby may frame them with
 * allow-same-origin (lib/plugin-frame-target.ts):
 *
 *   http://127.0.0.1:19599  the author's site of an external plugin UI
 *                           (`ui: { url: "http://127.0.0.1:19599/play" }`),
 *                           and an API a files-mode frame was approved to reach
 *   http://127.0.0.1:19600  another site: an impostor page, and an API a
 *                           files-mode frame asked for but was NOT approved
 *   http://127.0.0.1:19601  a site whose external UI was never approved, and
 *                           an API nobody asked for
 *
 * `/ping?id=…` answers with `Access-Control-Allow-Origin: *` and remembers the
 * id; `/hits` lists them, so a spec can prove a refused request never left
 * the browser. Plain Node, no dependencies; the frame client is served from
 * the sandbox-buzzer example's vendored copy.
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const CLIENT = join(repoRoot, 'examples', 'plugins', 'sandbox-buzzer', 'ui', 'lobbyforge-frame.js');

const file = (name, type) => ({ type, body: () => readFileSync(join(here, name)) });

function serve(port, routes) {
  const hits = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/ping') {
      hits.push(url.searchParams.get('id'));
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end('{"pong":true}');
      return;
    }
    if (url.pathname === '/hits') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
      res.end(JSON.stringify(hits));
      return;
    }
    const route = routes[url.pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-store' });
    res.end(route.body());
  });
  server.listen(port, '127.0.0.1', () => console.log(`external site on http://127.0.0.1:${port}`));
}

const health = { type: 'text/plain', body: () => 'ok' };

serve(19599, {
  '/health': health,
  '/play': file('play.html', 'text/html; charset=utf-8'),
  '/play.js': file('play.js', 'text/javascript; charset=utf-8'),
  '/lobbyforge-frame.js': { type: 'text/javascript; charset=utf-8', body: () => readFileSync(CLIENT) },
});

serve(19600, {
  '/health': health,
  '/impostor': file('impostor.html', 'text/html; charset=utf-8'),
});

serve(19601, { '/health': health });
