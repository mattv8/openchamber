import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SharedOpenCodeHealthMonitor } from './shared-opencode-health-monitor';

test('checks one active shared endpoint every thirty seconds without CLI recovery while healthy', async () => {
  const callbacks: Array<() => void> = [];
  let healthChecks = 0;
  let recoveries = 0;
  const monitor = new SharedOpenCodeHealthMonitor({
    getEndpoint: () => ({ url: 'http://127.0.0.1:4096', password: 'password' }),
    checkHealth: async () => { healthChecks += 1; return true; },
    recover: async () => { recoveries += 1; },
    setInterval: (callback) => { callbacks.push(callback); return callbacks.length; },
    clearInterval: () => {},
  });

  monitor.start();
  for (const callback of callbacks) await callback();
  for (const callback of callbacks) await callback();

  assert.equal(healthChecks, 2, 'two 30-second intervals make at most two HTTP checks per minute');
  assert.equal(recoveries, 0, 'a healthy endpoint must not execute CLI discovery');
});

test('serializes discovery after a failed health check and aborts it on stop', async () => {
  let callback: (() => void) | undefined;
  let recoveries = 0;
  let aborted = false;
  let releaseRecovery: (() => void) | undefined;
  const monitor = new SharedOpenCodeHealthMonitor({
    getEndpoint: () => ({ url: 'http://127.0.0.1:4096', password: 'password' }),
    checkHealth: async () => false,
    recover: async (signal) => {
      recoveries += 1;
      await new Promise<void>((resolve) => { releaseRecovery = resolve; });
      aborted = signal.aborted;
    },
    setInterval: (next) => { callback = next; return 1; },
    clearInterval: () => {},
  });

  monitor.start();
  callback?.();
  callback?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(recoveries, 1, 'an in-flight recovery blocks a second CLI discovery');
  monitor.stop();
  releaseRecovery?.();
  await Promise.resolve();
  assert.equal(aborted, true, 'stop aborts a recovery before it can publish a reconnect');
});
