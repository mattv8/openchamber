import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { createOpenCodeAuthStateRuntime } from './auth-state-runtime.js';

it('uses the shared service username without overwriting external-server credentials', () => {
  const process = { env: { OPENCODE_SERVER_USERNAME: 'external-user' } };
  const state = { password: null, source: null };
  const runtime = createOpenCodeAuthStateRuntime({
    crypto,
    process,
    getAuthPassword: () => state.password,
    setAuthPassword: (password) => { state.password = password; },
    getAuthSource: () => state.source,
    setAuthSource: (source) => { state.source = source; },
    getUserProvidedPassword: () => 'external-password',
    syncToHmrState: () => {},
  });

  runtime.setOpenCodeAuthState('shared-password', 'shared');
  expect(runtime.getOpenCodeAuthHeaders()).toEqual({
    Authorization: `Basic ${Buffer.from('opencode:shared-password').toString('base64')}`,
  });
  expect(process.env.OPENCODE_SERVER_USERNAME).toBe('external-user');

  runtime.setOpenCodeAuthState('external-password', 'user-env');
  expect(runtime.getOpenCodeAuthHeaders()).toEqual({
    Authorization: `Basic ${Buffer.from('external-user:external-password').toString('base64')}`,
  });
});
