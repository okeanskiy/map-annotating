import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';

async function withServer(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapdoc-'));
  const { server, url } = await startServer({ dir, port: 0, log: () => {} });
  try {
    await fn({ dir, url });
  } finally {
    await new Promise((r) => server.close(r));
    server.closeAllConnections?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const put = (url, body) =>
  fetch(`${url}/api/map`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('creates map.json and saves edits', () =>
  withServer(async ({ dir, url }) => {
    const { doc, rev } = await (await fetch(`${url}/api/map`)).json();
    assert.equal(doc.format, 'map-annotation/1');
    doc.features.push({ id: 'spawn', type: 'point', points: [[10, 10]] });
    const res = await put(url, { doc, baseRev: rev });
    assert.equal(res.status, 200);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'map.json'), 'utf8'));
    assert.equal(disk.features[0].id, 'spawn');
  }));

test('rejects stale writes after an outside edit (409) and invalid docs (400)', () =>
  withServer(async ({ dir, url }) => {
    const { doc, rev } = await (await fetch(`${url}/api/map`)).json();
    const file = path.join(dir, 'map.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Untitled map', 'Agent renamed'));
    const stale = await put(url, { doc, baseRev: rev });
    assert.equal(stale.status, 409);
    const body = await stale.json();
    assert.equal(body.doc.name, 'Agent renamed');

    const bad = await put(url, {
      doc: { ...body.doc, features: [{ id: 'x', type: 'area', points: [] }] },
      baseRev: body.rev,
    });
    assert.equal(bad.status, 400);
  }));

test('refuses to serve files outside the project folder', () =>
  withServer(async ({ url }) => {
    const res = await fetch(`${url}/project/..%2F..%2Fetc%2Fpasswd`);
    assert.notEqual(res.status, 200);
  }));
