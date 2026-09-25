import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SharedOpenCodeConnection } from './shared-opencode-connection';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((remove) => remove()));
});

test('disconnecting an extension client preserves the CLI-owned shared service for a later reconnect', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-shared-service-'));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const password = 'service-password';
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version: '2.0.16' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => await new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address instanceof Object);
  const url = `http://127.0.0.1:${address.port}`;
  const fixture = path.join(directory, 'opencode-service-fixture.cjs');
  await fs.writeFile(fixture, `
    const fs = require('node:fs');
    const [state, url, password, action, subaction] = process.argv.slice(2);
    if (action !== 'service') process.exit(1);
    if (subaction === 'status' && fs.existsSync(state + '.block')) setInterval(() => {}, 1000);
    if (subaction === 'status') process.stdout.write(fs.existsSync(state) ? url : 'stopped');
    if (subaction === 'start') { fs.writeFileSync(state, 'started'); process.stdout.write(url); }
    if (subaction === 'get' && process.argv[process.argv.length - 1] === 'password') process.stdout.write(password);
  `);
  const state = path.join(directory, 'service-state');
  const connection = new SharedOpenCodeConnection({
    launch: { binary: process.execPath, args: [fixture, state, url, password] },
    env: process.env,
    cwd: directory,
  });

  await connection.connect();
  assert.equal(connection.getUrl(), url);
  assert.equal(connection.getPassword(), password);
  assert.ok(await fs.stat(state));

  connection.disconnect();
  assert.equal(connection.getUrl(), null);
  assert.equal(connection.getPassword(), null);
  assert.ok(await fs.stat(state), 'disconnect must not stop the CLI-owned service');

  await connection.connect();
  assert.equal(connection.getUrl(), url);
  assert.equal(connection.getPassword(), password);
  assert.ok(requests >= 2, 'each connection must authenticate against the existing service');
});

test('aborting discovery does not revoke a previously running CLI-owned service', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-vscode-shared-service-abort-'));
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
  const password = 'service-password';
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version: '2.0.16' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => await new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address instanceof Object);
  const url = `http://127.0.0.1:${address.port}`;
  const fixture = path.join(directory, 'opencode-service-fixture.cjs');
  await fs.writeFile(fixture, `
    const fs = require('node:fs');
    const [state, url, password, action, subaction] = process.argv.slice(2);
    if (action !== 'service') process.exit(1);
    if (subaction === 'status' && fs.existsSync(state + '.block')) setInterval(() => {}, 1000);
    if (subaction === 'status') process.stdout.write(fs.existsSync(state) ? url : 'stopped');
    if (subaction === 'start') { fs.writeFileSync(state, 'started'); process.stdout.write(url); }
    if (subaction === 'get' && process.argv[process.argv.length - 1] === 'password') process.stdout.write(password);
  `);
  const state = path.join(directory, 'service-state');
  const initial = new SharedOpenCodeConnection({
    launch: { binary: process.execPath, args: [fixture, state, url, password] }, env: process.env, cwd: directory,
  });
  await initial.connect();
  initial.disconnect();
  await fs.writeFile(`${state}.block`, 'block discovery');
  const retry = new SharedOpenCodeConnection({
    launch: { binary: process.execPath, args: [fixture, state, url, password] }, env: process.env, cwd: directory,
  });
  const controller = new AbortController();
  const pending = retry.connect(controller.signal);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(retry.getUrl(), null);
  assert.equal(retry.getPassword(), null);
  assert.ok(await fs.stat(state), 'cancelling a client probe must not stop the service');
});
