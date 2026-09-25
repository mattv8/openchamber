import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectSharedOpenCode, scrubSharedServiceEnv } from './shared-service.js';

const fixtures = [];

const listen = (handler) => new Promise((resolve) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

const fixture = async (state) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'shared-opencode-'));
  fixtures.push(directory);
  const statePath = path.join(directory, 'state.json');
  const callsPath = path.join(directory, 'calls.json');
  const script = path.join(directory, 'opencode-fixture.cjs');
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(script, `
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.SERVICE_STATE, 'utf8'));
const command = process.argv.slice(2).join(' ');
const calls = fs.existsSync(process.env.SERVICE_CALLS) ? JSON.parse(fs.readFileSync(process.env.SERVICE_CALLS, 'utf8')) : [];
calls.push(command);
fs.writeFileSync(process.env.SERVICE_CALLS, JSON.stringify(calls));
 if (state.error || (command === 'service start' && state.startError)) { process.stderr.write(state.error || state.startError); process.exit(1); }
if (command === 'service status') process.stdout.write((calls.includes('service start') ? state.statusAfterStart : state.status || 'stopped') + '\\n');
else if (command === 'service start') process.stdout.write(state.start + '\\n');
else if (command === 'service get password') process.stdout.write(state.password + '\\n');
else process.exit(2);
`);
  return {
    directory,
    calls: async () => JSON.parse(await readFile(callsPath, 'utf8')),
    launch: { binary: process.execPath, args: [script] },
    env: { ...process.env, SERVICE_STATE: statePath, SERVICE_CALLS: callsPath },
  };
};

const serviceUrl = (server) => `http://127.0.0.1:${server.address().port}`;

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('shared OpenCode service connection', () => {
  it('reuses an incumbent service without starting it and authenticates its health probe', async () => {
    const password = 'fixture-password';
    let authorization;
    const server = await listen((request, response) => {
      authorization = request.headers.authorization;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ version: '2.0.16' }));
    });
    try {
      const url = serviceUrl(server);
      const cli = await fixture({ status: url, start: 'unused', password });
      await expect(connectSharedOpenCode({ launch: cli.launch, env: cli.env, cwd: cli.directory })).resolves.toEqual({ url, password });
      expect(await cli.calls()).toEqual(['service status', 'service get password', 'service status']);
      expect(authorization).toBe(`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
    } finally { await close(server); }
  });

  it('starts a service only when status reports stopped', async () => {
    const server = await listen((_request, response) => response.end(JSON.stringify({ version: '2.0.16' })));
    try {
      const url = serviceUrl(server);
      const cli = await fixture({ status: 'stopped', statusAfterStart: url, start: url, password: 'password' });
      await expect(connectSharedOpenCode({ launch: cli.launch, env: cli.env, cwd: cli.directory })).resolves.toMatchObject({ url });
      expect(await cli.calls()).toEqual(['service status', 'service start', 'service get password', 'service status']);
    } finally { await close(server); }
  });

  it('does not start a stopped service during discovery-only recovery', async () => {
    const cli = await fixture({ status: 'stopped', start: 'must-not-run', password: 'password' });
    await expect(connectSharedOpenCode({ launch: cli.launch, env: cli.env, cwd: cli.directory, allowStart: false }))
      .rejects.toThrow('unavailable');
    expect(await cli.calls()).toEqual(['service status']);
  });

  it('scrubs host-private service variables while preserving OpenCode configuration paths', () => {
    expect(scrubSharedServiceEnv({
      PATH: '/bin', XDG_CONFIG_HOME: '/config', OPENCODE_CONFIG: '/config/opencode.json',
      ELECTRON_RUN_AS_NODE: '1', OPENCODE_SERVER_PASSWORD: 'password', OPENCODE_SERVER_USERNAME: 'opencode',
      OPENCHAMBER_AGENT_TOOL_URL: 'http://127.0.0.1:3000', OPENCHAMBER_AGENT_TOOL_TOKEN: 'token',
    })).toEqual({ PATH: '/bin', XDG_CONFIG_HOME: '/config', OPENCODE_CONFIG: '/config/opencode.json' });
  });

  it('rejects unsupported service versions without a private-server fallback', async () => {
    const server = await listen((_request, response) => response.end(JSON.stringify({ version: '2.0.14' })));
    try {
      const url = serviceUrl(server);
      const cli = await fixture({ status: url, start: 'must-not-run', password: 'password' });
      await expect(connectSharedOpenCode({ launch: cli.launch, env: cli.env, cwd: cli.directory })).rejects.toThrow('compatible');
      expect(await cli.calls()).toEqual(['service status', 'service get password', 'service status']);
    } finally { await close(server); }
  });

  it('rejects a non-loopback service URL before reading its credentials', async () => {
    const cli = await fixture({ status: 'http://192.168.1.12:4096', start: 'must-not-run', password: 'private-password' });
    await expect(connectSharedOpenCode({ launch: cli.launch, env: cli.env, cwd: cli.directory })).rejects.toThrow('loopback');
    expect(await cli.calls()).toEqual(['service status']);
  });

  it('honors a caller abort while a CLI command is still running', async () => {
    const cli = await fixture({ status: 'stopped', start: 'unused', password: 'password' });
    const controller = new AbortController();
    controller.abort();
    await expect(connectSharedOpenCode({ launch: cli.launch, env: cli.env, cwd: cli.directory, signal: controller.signal })).rejects.toThrow(/abort/i);
  });

  it('does not expose captured CLI output when discovery fails', async () => {
    const cli = await fixture({ error: 'private-password-and-output', password: 'private-password' });
    await expect(connectSharedOpenCode({ launch: cli.launch, env: cli.env, cwd: cli.directory })).rejects.not.toThrow('private-password-and-output');
  });

  it('identifies a failed start command without exposing its output', async () => {
    const cli = await fixture({ status: 'stopped', startError: 'private-start-output', password: 'password' });
    await expect(connectSharedOpenCode({ launch: cli.launch, env: cli.env, cwd: cli.directory }))
      .rejects.toThrow('start exited with code 1');
  });
});
