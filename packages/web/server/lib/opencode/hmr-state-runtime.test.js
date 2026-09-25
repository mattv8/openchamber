import { describe, expect, it } from 'vitest';

import { createHmrStateRuntime } from './hmr-state-runtime.js';

const createRuntime = (env = {}) => createHmrStateRuntime({
  globalThisLike: {},
  os: { homedir: () => '/Users/example' },
  processLike: { env },
  stateKey: '__testHmrState',
});

describe('hmr state runtime', () => {
  it('uses configured OpenCode cwd when provided', () => {
    const runtime = createRuntime({ OPENCHAMBER_OPENCODE_CWD: '/tmp/openchamber-data' });

    expect(runtime.getOrCreateHmrState().openCodeWorkingDirectory).toBe('/tmp/openchamber-data');
  });

  it('falls back to home directory without configured OpenCode cwd', () => {
    const runtime = createRuntime();

    expect(runtime.getOrCreateHmrState().openCodeWorkingDirectory).toBe('/Users/example');
  });

  it('preserves shared-service ownership across HMR', () => {
    const runtime = createRuntime();
    const state = runtime.getOrCreateHmrState();
    runtime.syncStateFromRuntime(state, { openCodeProcess: null, openCodePort: 45678, openCodeBaseUrl: 'http://127.0.0.1:45678', isSharedOpenCode: true });

    expect(runtime.restoreRuntimeFromState({ hmrState: state, userProvidedOpenCodePassword: null })).toMatchObject({
      isSharedOpenCode: true,
      openCodeProcess: null,
      openCodePort: 45678,
    });
  });
});
