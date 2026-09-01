import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import type { CreateTerminalOptions, TerminalHandlers, TerminalStreamEvent } from '@/lib/api/types';
import { useTerminalStore } from '@/stores/useTerminalStore';
import type { OpenChamberProjectAction } from '@/lib/openchamberConfig';

const toastCalls = {
  error: new Array<string>(),
  info: new Array<string>(),
  success: new Array<string>(),
} satisfies { error: string[]; info: string[]; success: string[] };

const openContextPreviewCalls: Array<{ directory: string; url: string }> = [];
const openExternalCalls: string[] = [];
const detectedDevServer: MockedDetectedDevServer = { command: null, previewUrlHint: null };
const mockedDeviceInfo = { isMobile: false, isTablet: false, hasTouchOnlyPointer: false };

const uiState = {
  terminalShell: 'zsh',
  terminalLoginShells: ['zsh'],
  setSettingsPage: () => undefined,
  setSettingsDialogOpen: () => undefined,
  setSettingsProjectsSelectedId: () => undefined,
  openContextPreview: (directory: string, url: string) => {
    openContextPreviewCalls.push({ directory, url });
  },
  openContextPanelTab: () => undefined,
  openContextSurface: () => undefined,
};

const useUiStoreMock = Object.assign(
  <T,>(selector: (state: typeof uiState) => T): T => selector(uiState),
  { getState: () => uiState },
);

const desktopSshState = { instances: [], load: async () => undefined };
const useDesktopSshStoreMock = <T,>(selector: (state: typeof desktopSshState) => T): T => selector(desktopSshState);

type SubscriptionRecord = {
  sessionId: string;
  handlers: TerminalHandlers;
  closed: number;
};

interface MockedActionsState {
  actions: OpenChamberProjectAction[];
}

interface MockedDetectedDevServer {
  command: string | null;
  previewUrlHint: string | null;
}

const createCalls: CreateTerminalOptions[] = [];
const sendCalls: string[] = [];
const forceKillCalls: string[] = [];
const closeCalls: string[] = [];
const subscriptions: SubscriptionRecord[] = [];
let sessionCounter = 0;
const mockedActionsState: MockedActionsState = {
  actions: [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build' }],
};

const emitToSession = (sessionId: string, event: TerminalStreamEvent) => {
  subscriptions
    .filter((entry) => entry.sessionId === sessionId && entry.closed === 0)
    .forEach((entry) => entry.handlers.onEvent(event));
};

const terminal = {
  listSessions: async () => [],
  createSession: async (options: CreateTerminalOptions) => {
    createCalls.push(options);
    sessionCounter += 1;
    return {
      sessionId: `session-${sessionCounter}`,
      cols: 80,
      rows: 24,
      status: 'running' as const,
      mode: 'command' as const,
      purpose: options.purpose,
    };
  },
  connect: (sessionId: string, handlers: SubscriptionRecord['handlers']) => {
    const record: SubscriptionRecord = { sessionId, handlers, closed: 0 };
    subscriptions.push(record);
    return {
      close: () => {
        record.closed += 1;
      },
    };
  },
  sendInput: async (sessionId: string, input: string) => {
    sendCalls.push(`${sessionId}:${input}`);
    queueMicrotask(() => {
      emitToSession(sessionId, { type: 'exit', sequence: 1, exitCode: 0, signal: null });
    });
  },
  resize: async () => undefined,
  updateAppearance: async () => undefined,
  close: async (sessionId: string) => {
    closeCalls.push(sessionId);
  },
  restartSession: async () => { throw new Error('not used'); },
  forceKill: async ({ sessionId }: { sessionId?: string }) => {
    forceKillCalls.push(sessionId ?? '');
  },
};

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DropdownMenuItem: ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) => React.createElement('button', { type: 'button', onClick, className }, children),
  DropdownMenuSeparator: () => React.createElement('hr'),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));
mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string) => { toastCalls.error.push(message); },
    info: (message: string) => { toastCalls.info.push(message); },
    success: (message: string) => { toastCalls.success.push(message); },
  },
}));
mock.module('@/components/icon/Icon', () => ({ Icon: ({ name, className }: { name: string; className?: string }) => React.createElement('span', { 'data-icon': name, className }) }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ terminal, runtime: { isVSCode: false, platform: 'web' } }) }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => mockedDeviceInfo }));
mock.module('@/lib/desktop', () => ({ isDesktopShell: () => false }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: useUiStoreMock }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'dark' }, colors: { surface: { background: '#000' }, syntax: { base: { foreground: '#fff' } } } } }) }));
mock.module('@/stores/useDesktopSshStore', () => ({ useDesktopSshStore: useDesktopSshStoreMock }));
mock.module('@/lib/url', () => ({ openExternalUrl: async (url: string) => { openExternalCalls.push(url); } }));
mock.module('@/lib/openchamberConfig', () => ({
  getProjectActionsState: async () => mockedActionsState,
}));
mock.module('@/lib/browser/announcedServers', () => ({ setAnnouncedDevServers: () => undefined }));
mock.module('@/lib/detectDevServer', () => ({
  detectDevServerCommand: async () => (
    detectedDevServer.command
      ? { command: detectedDevServer.command, previewUrlHint: detectedDevServer.previewUrlHint ?? undefined }
      : null
  ),
  readPackageJsonScripts: async () => ({}),
}));

const { ProjectActionsButton } = await import('./ProjectActionsButton');

describe('ProjectActionsButton lifecycle', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      Node: windowInstance.Node,
      Element: windowInstance.Element,
      HTMLElement: windowInstance.HTMLElement,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    useTerminalStore.getState().clearAll();
    createCalls.length = 0;
    sendCalls.length = 0;
    forceKillCalls.length = 0;
    closeCalls.length = 0;
    subscriptions.length = 0;
    toastCalls.error.length = 0;
    toastCalls.info.length = 0;
    toastCalls.success.length = 0;
    openContextPreviewCalls.length = 0;
    openExternalCalls.length = 0;
    detectedDevServer.command = null;
    detectedDevServer.previewUrlHint = null;
    mockedDeviceInfo.isMobile = true;
    sessionCounter = 0;
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build' }];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  const renderButton = async ({
    projectPath = '/repo',
    directory = '/repo',
  }: { projectPath?: string; directory?: string } = {}) => {
    await act(async () => {
      root.render(
        React.createElement(I18nProvider, null,
          React.createElement(ProjectActionsButton, {
            projectRef: { id: 'project-1', path: projectPath },
            directory,
            allowMobile: true,
          }),
        ),
      );
    });
    await act(async () => { await Promise.resolve(); });
  };

  test('runs, stops, and reruns on the same action tab while cleaning old subscriptions once', async () => {
    await renderButton();

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    const firstTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(firstTab?.terminalSessionId).toBe('session-1');
    expect(firstTab?.purpose.type).toBe('project-action');
    const firstExecution = firstTab?.purpose.type === 'project-action' ? firstTab.purpose.executionId : null;
    expect(firstExecution).not.toBeNull();

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    const stoppedTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(stoppedTab?.lifecycle).toBe('exited');
    expect(stoppedTab?.purpose).toEqual({ type: 'project-action', actionId: 'build', executionId: null });

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    const rerunTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => tab.purpose.type === 'project-action');
    expect(rerunTab?.id).toBe(firstTab?.id);
    expect(rerunTab?.terminalSessionId).toBe('session-2');
    expect(rerunTab?.lifecycle).toBe('running');
    const secondExecution = rerunTab?.purpose.type === 'project-action' ? rerunTab.purpose.executionId : null;
    expect(secondExecution).not.toBeNull();
    expect(secondExecution).not.toBe(firstExecution);

    expect(createCalls).toHaveLength(2);
    expect(sendCalls).toEqual(['session-1:\x03']);
    expect(forceKillCalls).toEqual([]);
    expect(closeCalls).toEqual(['session-1']);
    expect(subscriptions.map((entry) => entry.closed)).toEqual([1, 1, 0]);
  });

  test('default action runs in the parent checkout and stores its tab there', async () => {
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.cwd).toBe('/repo');
    expect(useTerminalStore.getState().getDirectoryState('/repo')?.tabs.some((tab) => tab.purpose.type === 'project-action' && tab.purpose.actionId === 'build')).toBe(true);
    expect(useTerminalStore.getState().getDirectoryState('/repo-worktree')?.tabs.some((tab) => tab.purpose.type === 'project-action') ?? false).toBe(false);
  });

  test('worktree action runs in the current worktree and stores its tab there', async () => {
    mockedActionsState.actions = [{ id: 'build', name: 'Build', command: 'echo hello', icon: 'build', runIn: 'worktree' }];
    await renderButton({ projectPath: '/repo', directory: '/repo-worktree' });

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.cwd).toBe('/repo-worktree');
    expect(useTerminalStore.getState().getDirectoryState('/repo-worktree')?.tabs.some((tab) => tab.purpose.type === 'project-action' && tab.purpose.actionId === 'build')).toBe(true);
    expect(useTerminalStore.getState().getDirectoryState('/repo')?.tabs.some((tab) => tab.purpose.type === 'project-action') ?? false).toBe(false);
  });

  test('auto-discover without a preview hint settles on an announced localhost URL in context preview only', async () => {
    mockedDeviceInfo.isMobile = false;
    detectedDevServer.command = 'bun run dev';
    await renderButton();

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    const autoDiscoverTab = useTerminalStore.getState().getDirectoryState('/repo')?.tabs.find((tab) => (
      tab.purpose.type === 'project-action' && tab.purpose.actionId === '__openchamber_auto_discover_preview__'
    ));
    expect(autoDiscoverTab?.terminalSessionId).toBe('session-1');

    await act(async () => {
      emitToSession('session-1', {
        type: 'data',
        data: 'Ready at http://127.0.0.1:4321\n',
        sequence: 1,
        replayData: undefined,
      });
      await new Promise((resolve) => setTimeout(resolve, 3_100));
    });

    expect(openContextPreviewCalls).toEqual([{ directory: '/repo', url: 'http://127.0.0.1:4321' }]);
    expect(openExternalCalls).toEqual([]);
  });

  test('manual action URL does not open a second output-derived URL', async () => {
    mockedActionsState.actions = [{
      id: 'build',
      name: 'Build',
      command: 'echo hello',
      icon: 'build',
      autoOpenUrl: true,
      openUrl: '127.0.0.1:3000',
    }];
    await renderButton();

    const primaryButton = host.querySelector('button');
    if (!primaryButton) {
      throw new Error('expected primary button');
    }

    await act(async () => {
      primaryButton.dispatchEvent(new Event('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(openContextPreviewCalls).toEqual([{ directory: '/repo', url: 'http://127.0.0.1:3000/' }]);
    expect(openExternalCalls).toEqual([]);

    await act(async () => {
      emitToSession('session-1', {
        type: 'data',
        data: 'Server listening at http://127.0.0.1:4000\n',
        sequence: 1,
        replayData: undefined,
      });
      await Promise.resolve();
    });

    expect(openContextPreviewCalls).toEqual([{ directory: '/repo', url: 'http://127.0.0.1:3000/' }]);
    expect(openExternalCalls).toEqual([]);
  });
});
