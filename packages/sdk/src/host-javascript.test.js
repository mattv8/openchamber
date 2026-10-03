import { expect, test } from 'bun:test';
import { connectHost } from './host.ts';

// Exercise a JavaScript consumer directly, without casting invalid options into TS types.
test('JavaScript storage callers cannot silently fall back after misspelling a scope', async () => {
  const posted = [];
  const host = connectHost({ target: {
    addEventListener() {},
    removeEventListener() {},
    parent: { postMessage(message) { posted.push(message); } },
  } });
  const invalid = { scope: 'devcie' };
  try {
    await expect(host.storage.get('saved', invalid)).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(host.storage.set('saved', true, invalid)).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(host.storage.delete('saved', invalid)).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(host.storage.keys(invalid)).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    expect(posted.map(message => message.type)).toEqual(['hello']);
  } finally { host.dispose(); }
});
