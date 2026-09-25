import { execFile } from 'node:child_process';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { isSupportedOpenCodeVersion, readOpenCodeInfo } from './compatibility.js';

const execute = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const START_COMMAND_TIMEOUT_MS = 125_000;
const HEALTH_TIMEOUT_MS = 5_000;
const DISCOVERY_ATTEMPTS = 2;

const isLoopbackHostname = (hostname) => {
  const normalized = hostname.replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '::1'
    || (isIP(normalized) === 4 && normalized.startsWith('127.'));
};

const serviceUrl = (value) => {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('The OpenCode service reported an invalid URL.'); }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || !isLoopbackHostname(parsed.hostname)) {
    throw new Error('The OpenCode service is not a supported loopback HTTP connection.');
  }
  return value;
};

const combinedSignal = (signal, timeout) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);

/** Remove host-process values that must not become service-wide configuration. */
export const scrubSharedServiceEnv = (env) => {
  const sharedEnv = { ...env };
  delete sharedEnv.ELECTRON_RUN_AS_NODE;
  delete sharedEnv.OPENCODE_SERVER_PASSWORD;
  delete sharedEnv.OPENCODE_SERVER_USERNAME;
  delete sharedEnv.OPENCHAMBER_AGENT_TOOL_URL;
  delete sharedEnv.OPENCHAMBER_AGENT_TOOL_TOKEN;
  return sharedEnv;
};

const runServiceCommand = async (launch, env, cwd, signal, args) => {
  const subcommand = args.join(' ');
  const timeout = args[0] === 'start' ? START_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
  try {
    const { stdout } = await execute(launch.binary, [...launch.args, 'service', ...args], {
      cwd,
      env: scrubSharedServiceEnv(env),
      encoding: 'utf8',
      maxBuffer: 16 * 1024,
      signal: combinedSignal(signal, timeout),
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    if (signal?.aborted) throw new Error('OpenCode shared service discovery was aborted.');
    const kind = error?.name === 'AbortError' || error?.name === 'TimeoutError'
      ? 'timed out'
      : (Number.isInteger(error?.code) ? `exited with code ${error.code}` : 'failed');
    throw new Error(`OpenCode shared service ${subcommand} ${kind}.`);
  }
};

const checkServiceHealth = async (url, password, signal) => {
  let response;
  try {
    response = await fetch(new URL('/api/info', url), {
      headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
      redirect: 'error',
      signal: combinedSignal(signal, HEALTH_TIMEOUT_MS),
    });
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw new Error('OpenCode shared service discovery was aborted.');
    throw new Error('The OpenCode shared service did not respond to its health check.');
  }
  const info = await readOpenCodeInfo(response);
  if (!info || !isSupportedOpenCodeVersion(info.version)) {
    throw new Error('The OpenCode shared service is not compatible with this OpenChamber version.');
  }
};

/** Connect to the OpenCode CLI-owned local service without taking its lifecycle ownership. */
export const connectSharedOpenCode = async ({ launch, env, cwd, signal, allowStart = true }) => {
  for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
    const status = await runServiceCommand(launch, env, cwd, signal, ['status']);
    if (status === 'stopped' && !allowStart) {
      throw new Error('The OpenCode shared service is unavailable.');
    }
    const url = status === 'stopped'
      ? serviceUrl(await runServiceCommand(launch, env, cwd, signal, ['start']))
      : serviceUrl(status);
    const password = await runServiceCommand(launch, env, cwd, signal, ['get', 'password']);
    if (!password) throw new Error('Could not connect to the OpenCode shared service.');
    const confirmedUrl = await runServiceCommand(launch, env, cwd, signal, ['status']);
    if (confirmedUrl !== url) continue;
    await checkServiceHealth(url, password, signal);
    return { url, password };
  }
  throw new Error('The OpenCode shared service changed while it was being discovered.');
};
