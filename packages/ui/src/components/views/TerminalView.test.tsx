import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useTerminalStore } from '@/stores/useTerminalStore';

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
  openContextPreview: () => undefined,
};

const useUiStoreMock = Object.assign(
  <T,>(selector: (state: typeof uiState) => T): T => selector(uiState),
  { getState: () => uiState },
);

mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: useSessionUIStoreMock }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
mock.module('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({
    runtime: { platform: 'web' },
    terminal: {
      createSession: async () => ({ sessionId: 'unused', cols: 80, rows: 24, status: 'running' as const }),
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
mock.module('@/components/terminal/TerminalViewport', () => ({ TerminalViewport: () => null }));
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

describe('TerminalView project action tab indicator', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
});
