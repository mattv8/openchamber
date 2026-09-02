import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useTerminalStore } from '@/stores/useTerminalStore';

let effectiveDirectory = '/repo';
const openContextPreviewCalls: Array<[string, string]> = [];
const createSessionCalls: Array<{ cwd: string }> = [];
const ensureDirectoryCalls: string[] = [];
const openContextPreview = (directory: string, url: string) => {
  openContextPreviewCalls.push([directory, url]);
};
const createSession = async ({ cwd }: { cwd: string }) => {
  createSessionCalls.push({ cwd });
  return { sessionId: 'unused', cols: 80, rows: 24, status: 'running' as const };
};

const sessionUiState = {
  currentSessionId: 'session-1',
  newSessionDraft: null,
};

const useSessionUIStoreMock = <T,>(selector: (state: typeof sessionUiState) => T): T => selector(sessionUiState);

const uiState = {
  terminalFontSize: 14,
  terminalShell: 'zsh',
  terminalLoginShells: ['zsh'],
  showTerminalQuickKeysOnDesktop: false,
  openContextPreview,
};

const useUiStoreMock = Object.assign(
  <T,>(selector: (state: typeof uiState) => T): T => selector(uiState),
  { getState: () => uiState },
);

mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: useSessionUIStoreMock }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => effectiveDirectory }));
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({
    runtime: { platform: 'web' },
    terminal: {
      createSession,
      sendInput: async () => undefined,
      resize: async () => undefined,
      close: async () => undefined,
      updateAppearance: async () => undefined,
      connect: () => ({ close: () => undefined }),
    },
  }),
}));
mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({
    currentTheme: {
      metadata: { variant: 'dark' },
      colors: {
        surface: {
          background: '#000',
          muted: '#111',
          elevatedForeground: '#fff',
        },
        syntax: {
          base: { foreground: '#fff' },
          function: '#7dd3fc',
          keyword: '#c084fc',
          type: '#67e8f9',
          comment: '#6b7280',
        },
        interactive: {
          cursor: '#fff',
          selection: '#334155',
          selectionForeground: '#fff',
        },
        status: {
          error: '#f87171',
          success: '#4ade80',
          warning: '#fbbf24',
        },
      },
    },
  }),
}));
mock.module('@/hooks/useFontPreferences', () => ({ useFontPreferences: () => ({ monoFont: 'geist-mono' }) }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false, isTablet: false, hasTouchOnlyPointer: false }) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: useUiStoreMock }));
mock.module('@/stores/useInlineCommentDraftStore', () => ({ useInlineCommentDraftStore: () => ({ addDraft: () => undefined }) }));
mock.module('@/components/terminal/TerminalViewport', () => ({
  TerminalViewport: React.forwardRef(function TerminalViewportMock(
    { sessionKey, chunks, isVisible }: { sessionKey: string; chunks: unknown[]; isVisible: boolean },
    ref: React.ForwardedRef<{ focus: () => void; fit: () => void; getSelection: () => null }>,
  ) {
    React.useImperativeHandle(ref, () => ({
      focus: () => undefined,
      fit: () => undefined,
      getSelection: () => null,
    }), []);

    return React.createElement('div', {
      'data-terminal-viewport': 'true',
      'data-session-key': sessionKey,
      'data-visible': String(isVisible),
      'data-chunk-count': String(chunks.length),
    });
  }),
}));
mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }),
}));
mock.module('@/components/ui/sortable-tabs-strip', () => ({
  SortableTabsStrip: ({ items }: { items: Array<{ id: string; label: string; icon?: React.ReactNode }> }) => React.createElement(
    'div',
    { 'data-tabs-strip': 'terminal' },
    items.map((item) => React.createElement(
      'div',
      { key: item.id, 'data-tab-id': item.id },
      item.icon,
      React.createElement('span', { 'data-tab-label': item.id }, item.label),
    )),
  ),
}));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const { TerminalView } = await import('./TerminalView');

const ensureDirectorySpy = (directory: string) => {
  ensureDirectoryCalls.push(directory);
  useTerminalStore.setState((state) => {
    if (state.sessions.get(directory)) return state;

    const tab = {
      id: `spy-tab-${directory}`,
      terminalSessionId: null,
      lifecycle: 'idle' as const,
      purpose: { type: 'terminal' as const },
      label: 'Terminal',
      iconKey: null,
      isConnecting: false,
      createdAt: Date.now(),
      previewUrl: null,
      previewAutoOpened: false,
      previewUrlLocked: false,
    };

    const sessions = new Map(state.sessions);
    sessions.set(directory, { tabs: [tab], activeTabId: tab.id });
    return { sessions };
  });
};

describe('TerminalView project action tab indicator', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    effectiveDirectory = '/repo';
    openContextPreviewCalls.length = 0;
    createSessionCalls.length = 0;
    ensureDirectoryCalls.length = 0;
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      KeyboardEvent: windowInstance.KeyboardEvent,
      MouseEvent: windowInstance.MouseEvent,
      ResizeObserver: class {
        observe() {}
        disconnect() {}
      },
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    useTerminalStore.getState().clearAll();
    useTerminalStore.setState({ ensureDirectory: ensureDirectorySpy });
    useTerminalStore.getState().ensureDirectory('/repo');

    const interactiveTabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo', interactiveTabId, 'Interactive');

    const runningActionTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabLabel('/repo', runningActionTabId, 'Build');
    useTerminalStore.getState().setTabIconKey('/repo', runningActionTabId, 'build');
    useTerminalStore.getState().setTabPurpose('/repo', runningActionTabId, { type: 'project-action', actionId: 'build', executionId: 'exec-running' });
    useTerminalStore.getState().setTabLifecycle('/repo', runningActionTabId, 'running');

    const exitedActionTabId = useTerminalStore.getState().createTab('/repo');
    useTerminalStore.getState().setTabLabel('/repo', exitedActionTabId, 'Deploy');
    useTerminalStore.getState().setTabIconKey('/repo', exitedActionTabId, 'play');
    useTerminalStore.getState().setTabPurpose('/repo', exitedActionTabId, { type: 'project-action', actionId: 'deploy', executionId: 'exec-exited' });
    useTerminalStore.getState().setTabLifecycle('/repo', exitedActionTabId, 'exited');
    ensureDirectoryCalls.length = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useTerminalStore.getState().clearAll();
  });

  test('shows a spinner only for active project-action tabs and keeps terminal or action icons elsewhere', async () => {
    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: false }));
    });

    const tabs = Array.from(host.querySelectorAll('[data-tab-id]'));
    expect(tabs).toHaveLength(3);

    const interactiveTab = tabs.find((tab) => tab.querySelector('[data-tab-label]')?.textContent === 'Interactive');
    const runningActionTab = tabs.find((tab) => tab.querySelector('[data-tab-label]')?.textContent === 'Build');
    const exitedActionTab = tabs.find((tab) => tab.querySelector('[data-tab-label]')?.textContent === 'Deploy');

    expect(interactiveTab?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('terminal');
    expect(runningActionTab?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('loader-4');
    expect(runningActionTab?.querySelector('[data-icon]')?.className).toContain('animate-spin');
    expect(runningActionTab?.querySelector('[data-icon]')?.className).toContain('motion-reduce:animate-none');
    expect(runningActionTab?.querySelector('[data-icon]')?.className).toContain('text-muted-foreground');
    expect(exitedActionTab?.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('play');
    expect(host.querySelectorAll('[data-icon="loader-4"]').length).toBe(1);
  });

  test('uses the explicit terminal directory for terminal tabs and session creation while preview ownership stays on the host directory', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');
    const worktreeTabId = useTerminalStore.getState().getDirectoryState('/repo-worktree')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo-worktree', worktreeTabId, 'Worktree Terminal');

    const repoTabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo', repoTabId, 'Repo Terminal');
    useTerminalStore.getState().setTabPreviewUrl('/repo', repoTabId, 'https://preview.example.test');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/repo' }));
    });

    const tabLabels = Array.from(host.querySelectorAll('[data-tab-label]')).map((node) => node.textContent);
    expect(tabLabels).toContain('Repo Terminal');
    expect(tabLabels).not.toContain('Worktree Terminal');
    expect(createSessionCalls.length).toBe(1);
    expect(createSessionCalls[0]?.cwd).toBe('/repo');

    const previewButton = host.querySelector<HTMLElement>('[title="terminalView.preview.openTitle"]');
    expect(previewButton).not.toBeNull();
    previewButton?.click();
    expect(openContextPreviewCalls).toEqual([['/repo-worktree', 'https://preview.example.test']]);
  });

  test('keeps the existing context-directory behavior when no explicit terminal directory is provided', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');
    const worktreeTabId = useTerminalStore.getState().getDirectoryState('/repo-worktree')!.tabs[0]!.id;
    useTerminalStore.getState().setTabLabel('/repo-worktree', worktreeTabId, 'Worktree Terminal');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true }));
    });

    const tabLabels = Array.from(host.querySelectorAll('[data-tab-label]')).map((node) => node.textContent);
    expect(tabLabels).toContain('Worktree Terminal');
    expect(createSessionCalls.length).toBe(1);
    expect(createSessionCalls[0]?.cwd).toBe('/repo-worktree');
  });

  test('treats an explicit terminal target with no terminal state as an inert reveal', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/missing-repo' }));
    });

    expect(ensureDirectoryCalls).not.toContain('/missing-repo');
    expect(createSessionCalls.length).toBe(0);
    expect(host.querySelector('[data-tabs-strip="terminal"]')).toBeNull();
    expect(host.querySelector('[data-terminal-viewport="true"]')?.getAttribute('data-chunk-count')).toBe('0');
  });

  test('includes the terminal directory in the viewport identity key', async () => {
    effectiveDirectory = '/repo-worktree';
    useTerminalStore.getState().ensureDirectory('/repo-worktree');

    useTerminalStore.setState((state) => {
      const repoTab = state.sessions.get('/repo')!.tabs[0]!;
      const sessions = new Map(state.sessions);
      sessions.set('/repo-worktree', {
        tabs: [{ ...repoTab, label: 'Mirrored Terminal' }],
        activeTabId: repoTab.id,
      });
      return { sessions };
    });

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true }));
    });
    const contextKey = host.querySelector('[data-terminal-viewport="true"]')!.getAttribute('data-session-key');

    await act(async () => {
      root.render(React.createElement(TerminalView, { visible: true, directory: '/repo' }));
    });
    const targetKey = host.querySelector('[data-terminal-viewport="true"]')!.getAttribute('data-session-key');

    expect(contextKey).not.toBe(targetKey);
    expect(contextKey).toContain('/repo-worktree');
    expect(targetKey).toContain('/repo');
  });
});
