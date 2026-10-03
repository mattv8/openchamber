import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { OpenCode } from '@opencode/client';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { SyncProvider } from '@/sync/sync-context';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusExtensionSection } from './WorkStatusExtensionSection';
import { PresenceContext } from './presenceContext';

test('a status frame keeps subscriptions and storage alive while project changes retire only its controls', async () => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const guestWindow = new Window();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event, MessageEvent: dom.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let resolveStorage: ((response: Response) => void) | null = null;
  const storageResponse = new Promise<Response>((resolve) => { resolveStorage = resolve; });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target.includes('/api/guests/git-graph/storage')) return storageResponse;
    if (target.includes('/auth/url-token')) return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
    if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (target.includes('/session/active')) return Response.json({ data: {} });
    if (new URL(target).pathname.endsWith('/shell')) return Response.json({ location: { directory: null }, data: [] });
    if (target.includes('/location')) return Response.json({ directory: '/visible', project: { id: 'project', directory: '/visible', canonical: '/visible' } });
    if (target.includes('/fs/home')) return Response.json({ home: '/home/test' });
    if (target.includes('/config')) return Response.json([]);
    if (target.includes('/project')) return Response.json([]);
    if (target.includes('/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
    return Response.json({ data: [], cursor: {} });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/shell')) return Response.json({ location: { directory: null }, data: [] });
    if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    const body = path.endsWith('/location')
      ? { directory: '/visible', project: { id: 'project', directory: '/visible', canonical: '/visible' } }
      : path.endsWith('/session/active') ? {} : { data: [] };
    return Response.json(body);
  } });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const guest: InstalledGuest = {
    id: 'git-graph', name: 'Git graph', icon: 'git-commit', statusEntry: 'status/index.html', statusTitle: 'Recent commits', statusHeight: 140,
    storageId: '11111111-1111-4111-8111-111111111111', origins: ['https://first.example'],
    capabilities: { requested: ['sessions', 'origins'], granted: ['sessions', 'origins'] },
  };
  const previousRuntimeUrlResolver = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://sync.test' });
  opencodeClient.reconnectToRuntimeBaseUrl();
  const runtimeKey = getRuntimeKey();
  const previousProjects = useProjectsStore.getState();
  useProjectsStore.setState({
    hasServerSnapshot: true,
    serverSnapshotFailed: false,
    projects: [{ id: 'visible', path: '/visible', label: 'Visible', addedAt: 1 }],
    activeProjectId: 'visible',
  });
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([guest], runtimeKey);
  useUIStore.setState({ workStatusExpandedSections: {} });
  const contentWindowDescriptor = Object.getOwnPropertyDescriptor(dom.HTMLIFrameElement.prototype, 'contentWindow');
  const indexedDBDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: {} });
  Object.defineProperty(dom.HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get: () => guestWindow,
  });
  const messages: HostMessage[] = [];
  const post = spyOn(guestWindow, 'postMessage').mockImplementation((data) => { messages.push(hostMessageSchema.parse(data)); });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const renderSection = (directory: string) => (
    <I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory={directory}><WorkStatusExtensionSection guest={guest} directory={directory} /></SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider>
  );
  try {
    await act(async () => root.render(renderSection('/visible')));
    for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (!frame) throw new Error('Status frame did not mount');
    expect(container.textContent).toContain('Recent commits');
    expect(frame.src.includes('/api/guests/git-graph/status/index.html')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const box = frame.parentElement;
    if (!box) throw new Error('Frame box missing');
    expect(box.style.height).toBe('140px');

    const source = frame.contentWindow;
    if (!source) throw new Error('Guest window is missing');
    expect(source).toBe(guestWindow);
    const send = (message: GuestMessage) => window.dispatchEvent(new MessageEvent('message', { source, data: message }));
    const projectSnapshots = () => messages.flatMap((message) => (
      message.type === 'workspace' && message.payload.subscriptionId === 'projects' && message.payload.snapshot.kind === 'projects'
        ? [message.payload.snapshot]
        : []
    ));
    await act(async () => { send({ channel: 'openchamber.sdk', v: 1, type: 'hello' }); });
    expect(messages.find((message) => message.type === 'ready')).toMatchObject({
      payload: {
        surface: 'status', item: null,
        features: { deviceStorage: true, statusControls: true },
        theme: { tokens: { syntaxKeyword: theme.colors.syntax.base.keyword, syntaxString: theme.colors.syntax.base.string } },
      },
    });

    await act(async () => {
      send({ channel: 'openchamber.sdk', v: 1, type: 'workspace-subscribe', id: 'subscribe-1', payload: { subscriptionId: 'projects', query: { kind: 'projects' } } });
      await Promise.resolve();
    });
    expect(projectSnapshots().at(-1)?.projects.map((project) => project.id)).toEqual(['visible']);
    await act(async () => {
      useProjectsStore.setState({ projects: [
        { id: 'visible', path: '/visible', label: 'Visible', addedAt: 1 },
        { id: 'before', path: '/before', label: 'Before', addedAt: 2 },
      ] });
      await Promise.resolve();
    });
    expect(projectSnapshots().at(-1)?.projects.map((project) => project.id)).toEqual(['visible', 'before']);

    const controls: GuestMessage = {
      channel: 'openchamber.sdk', v: 1, type: 'status-controls', id: 'controls-1',
      payload: { controls: [{ kind: 'button', id: 'refresh', label: 'Refresh' }] },
    };
    await act(async () => { send(controls); await Promise.resolve(); });
    expect(container.querySelector('[data-work-status-control="refresh"]')).not.toBeNull();

    await act(async () => {
      send({ channel: 'openchamber.sdk', v: 1, type: 'storage', id: 'storage-1', payload: { op: 'keys' } });
      await Promise.resolve();
    });
    expect(messages.some((message) => message.type === 'result' && message.id === 'storage-1')).toBe(false);

    await act(async () => root.render(renderSection('/other')));
    expect(container.querySelector('iframe')).toBe(frame);
    expect(container.querySelector('[data-work-status-control="refresh"]')).toBeNull();

    await act(async () => {
      useProjectsStore.setState({ projects: [
        { id: 'visible', path: '/visible', label: 'Visible', addedAt: 1 },
        { id: 'before', path: '/before', label: 'Before', addedAt: 2 },
        { id: 'after', path: '/after', label: 'After', addedAt: 3 },
      ] });
      await Promise.resolve();
    });
    expect(projectSnapshots().at(-1)?.projects.map((project) => project.id)).toEqual(['visible', 'before', 'after']);

    await act(async () => {
      resolveStorage?.(Response.json({ storage: true, op: 'keys', keys: ['saved'] }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(messages.find((message) => message.type === 'result' && message.id === 'storage-1')).toMatchObject({
      ok: true,
      payload: { storage: true, op: 'keys', keys: ['saved'] },
    });

    await act(async () => { send({ ...controls, id: 'controls-2' }); await Promise.resolve(); });
    expect(container.querySelector('[data-work-status-control="refresh"]')).not.toBeNull();

    await act(async () => { send({ channel: 'openchamber.sdk', v: 1, type: 'resize', id: 'h-1', payload: { height: 96 } }); });
    expect(box.style.height).toBe('96px');
    await act(async () => { send({ channel: 'openchamber.sdk', v: 1, type: 'resize', id: 'h-2', payload: { height: 2000 } }); });
    expect(box.style.height).toBe('320px');
    expect(messages.some((message) => message.type === 'result' && message.id === 'h-2' && message.ok)).toBe(true);
    // Status-only: the catalog has no panel entry, and that must not tear the section down.
    expect(container.querySelector('iframe')).not.toBeNull();

    const header = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!header) throw new Error('Section header missing');
    await act(async () => header.click());
    expect(container.querySelector('iframe')).toBeNull();
    // Reopening starts at the height the page last asked for, not the manifest default.
    await act(async () => header.click());
    expect(container.querySelector('iframe')?.parentElement?.style.height).toBe('320px');

    // Changing either installation identity or approved origins replaces the
    // frame, so stale header bindings cannot address the new installation.
    let previousFrame = container.querySelector('iframe');
    const approvedOriginsGuest = { ...guest, origins: ['https://second.example'] };
    for (const nextGuest of [approvedOriginsGuest, {
      ...approvedOriginsGuest, storageId: '22222222-2222-4222-8222-222222222222',
    }]) {
      await act(async () => {
        useGuestsStore.getState().replaceCatalog([nextGuest], runtimeKey);
        await Promise.resolve();
      });
      for (let attempt = 0; attempt < 100 && container.querySelector('iframe') === previousFrame; attempt++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      const replacementFrame = container.querySelector('iframe');
      expect(replacementFrame).not.toBeNull();
      expect(replacementFrame).not.toBe(previousFrame);
      expect(container.querySelector('[data-work-status-control="refresh"]')).toBeNull();
      previousFrame = replacementFrame;
    }
  } finally {
    await act(async () => root.unmount());
    post.mockRestore();
    fetch.mockRestore();
    useProjectsStore.setState(previousProjects, true);
    if (contentWindowDescriptor) Object.defineProperty(dom.HTMLIFrameElement.prototype, 'contentWindow', contentWindowDescriptor);
    else Reflect.deleteProperty(dom.HTMLIFrameElement.prototype, 'contentWindow');
    if (indexedDBDescriptor) Object.defineProperty(globalThis, 'indexedDB', indexedDBDescriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
    setRuntimeUrlResolver(previousRuntimeUrlResolver);
    opencodeClient.reconnectToRuntimeBaseUrl();
    useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a project-required status section reports absent without the actual Work Status directory', async () => {
  const dom = new Window({ url: 'http://guest.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const guest: InstalledGuest = {
    id: 'project-status', name: 'Project status', icon: 'git-commit', statusEntry: 'status/index.html', statusRequiresProject: true,
    capabilities: { requested: [], granted: [] },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const presence: Array<[string, boolean]> = [];
  try {
    for (const directory of [null, '']) {
      await act(async () => root.render(<I18nProvider><ThemeSystemContext.Provider value={themeContext}>
        <PresenceContext.Provider value={(id, present) => presence.push([id, present])}>
          <WorkStatusExtensionSection guest={guest} directory={directory} />
        </PresenceContext.Provider>
      </ThemeSystemContext.Provider></I18nProvider>));
      expect(container.querySelector('[data-guest-status-body]')).toBeNull();
    }
    expect(presence.some(([, present]) => !present)).toBe(true);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
