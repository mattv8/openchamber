import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

type SessionRecord = { directory: string };
type SessionUIStoreState = {
  currentSessionId: string | null;
  availableWorktreesByProject: Map<string, never[]>;
  worktreeMetadata: Map<string, { path: string }>;
  newSessionDraft: null | {
    open: boolean;
    bootstrapPendingDirectory?: string | null;
    directoryOverride?: string | null;
  };
  directoryBySessionId: Map<string, string>;
  getDirectoryForSession: (sessionId: string) => string | null;
};

const projectStoreState = {
  projects: [
    { id: 'project-a', path: '/workspace/project-a', label: 'Project A' },
    { id: 'project-b', path: '/workspace/project-b', label: 'Project B' },
  ],
  activeProjectId: 'project-a',
};

const sessionUIStoreState: SessionUIStoreState = {
  currentSessionId: null,
  availableWorktreesByProject: new Map<string, never[]>(),
  worktreeMetadata: new Map<string, { path: string }>(),
  newSessionDraft: null,
  directoryBySessionId: new Map<string, string>(),
  getDirectoryForSession(sessionId: string) {
    return sessionUIStoreState.directoryBySessionId.get(sessionId) ?? null;
  },
};

const liveSessionsByDirectory = new Map<string, SessionRecord>();
const useSessionCalls: Array<[string | null | undefined, string | undefined]> = [];

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: <T,>(selector: (state: typeof projectStoreState) => T): T => selector(projectStoreState),
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(selector: (state: typeof sessionUIStoreState) => T): T => selector(sessionUIStoreState),
}));

mock.module('@/sync/sync-context', () => ({
  useSession: mock((sessionId?: string | null, directory?: string) => {
    useSessionCalls.push([sessionId, directory]);
    if (!directory) {
      return null;
    }
    return liveSessionsByDirectory.get(directory) ?? null;
  }),
}));

const { resolveProjectActionsOwner, useProjectActionsContext } = await import('./useProjectActionsContext');

const projects = [
  { id: 'openchamber', path: '/workspace/openchamber', label: 'OpenChamber' },
];

const HookHarness: React.FC<{ onValue: (value: ReturnType<typeof useProjectActionsContext>) => void }> = ({ onValue }) => {
  const value = useProjectActionsContext();
  React.useEffect(() => {
    onValue(value);
  }, [onValue, value]);
  return null;
};

describe('resolveProjectActionsOwner', () => {
  test('resolves a worktree directory to its owning parent project', () => {
    const owner = resolveProjectActionsOwner({
      projects,
      worktreesByProject: new Map([
        ['/workspace/openchamber', [{
          path: '/workspace/openchamber-feature',
          projectDirectory: '/workspace/openchamber',
          branch: 'feature',
          label: 'feature',
        }]],
      ]),
      directory: '/workspace/openchamber-feature',
      activeProjectId: null,
    });

    expect(owner).toEqual(projects[0]);
  });

  test('resolves a directory under the project path to that project', () => {
    const owner = resolveProjectActionsOwner({
      projects,
      worktreesByProject: new Map(),
      directory: '/workspace/openchamber/packages/ui',
      activeProjectId: null,
    });

    expect(owner).toEqual(projects[0]);
  });

  test('falls back to the active project when the directory does not resolve', () => {
    const owner = resolveProjectActionsOwner({
      projects,
      worktreesByProject: new Map(),
      directory: '/some/other/project',
      activeProjectId: 'openchamber',
    });

    expect(owner).toEqual(projects[0]);
  });

  test('falls back to the active project when the directory is empty or null', () => {
    expect(resolveProjectActionsOwner({
      projects,
      worktreesByProject: new Map(),
      directory: '',
      activeProjectId: 'openchamber',
    })).toEqual(projects[0]);

    expect(resolveProjectActionsOwner({
      projects,
      worktreesByProject: new Map(),
      directory: null,
      activeProjectId: 'openchamber',
    })).toEqual(projects[0]);
  });

  test('returns null when the directory does not resolve and the active project is unknown', () => {
    const owner = resolveProjectActionsOwner({
      projects,
      worktreesByProject: new Map(),
      directory: '/some/other/project',
      activeProjectId: 'missing-project',
    });

    expect(owner).toBeNull();
  });
});

describe('useProjectActionsContext', () => {
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
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    projectStoreState.projects = [
      { id: 'project-a', path: '/workspace/project-a', label: 'Project A' },
      { id: 'project-b', path: '/workspace/project-b', label: 'Project B' },
    ];
    projectStoreState.activeProjectId = 'project-a';
    sessionUIStoreState.currentSessionId = null;
    sessionUIStoreState.availableWorktreesByProject = new Map();
    sessionUIStoreState.worktreeMetadata = new Map();
    sessionUIStoreState.newSessionDraft = null;
    sessionUIStoreState.directoryBySessionId = new Map();
    liveSessionsByDirectory.clear();
    useSessionCalls.length = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  test('uses the canonical session-directory resolver when the live lookup misses a Recent session selection', async () => {
    sessionUIStoreState.currentSessionId = 'ses-recent';
    sessionUIStoreState.directoryBySessionId = new Map([
      ['ses-recent', '/workspace/project-b'],
    ]);

    let value: ReturnType<typeof useProjectActionsContext> = null;

    await act(async () => {
      root.render(React.createElement(HookHarness, { onValue: (nextValue) => { value = nextValue; } }));
    });

    expect(useSessionCalls).toEqual([['ses-recent', '/workspace/project-b']]);
    expect(value).toEqual({
      projectRef: { id: 'project-b', path: '/workspace/project-b' },
      directory: '/workspace/project-b',
    });
  });

  test('prefers the live session directory when the scoped child-store record is available', async () => {
    sessionUIStoreState.currentSessionId = 'ses-live';
    sessionUIStoreState.directoryBySessionId = new Map([
      ['ses-live', '/workspace/project-b'],
    ]);
    liveSessionsByDirectory.set('/workspace/project-b', {
      directory: '/workspace/project-b/sub',
    });

    let value: ReturnType<typeof useProjectActionsContext> = null;

    await act(async () => {
      root.render(React.createElement(HookHarness, { onValue: (nextValue) => { value = nextValue; } }));
    });

    expect(useSessionCalls).toEqual([['ses-live', '/workspace/project-b']]);
    expect(value).toEqual({
      projectRef: { id: 'project-b', path: '/workspace/project-b' },
      directory: '/workspace/project-b/sub',
    });
  });

  test('follows a mid-lifecycle switch to a Recent session in another project', async () => {
    sessionUIStoreState.currentSessionId = 'ses-project-a';
    sessionUIStoreState.directoryBySessionId = new Map([
      ['ses-project-a', '/workspace/project-a'],
      ['ses-recent', '/workspace/project-b'],
    ]);
    liveSessionsByDirectory.set('/workspace/project-a', {
      directory: '/workspace/project-a',
    });

    let value: ReturnType<typeof useProjectActionsContext> = null;
    const render = () => act(async () => {
      root.render(React.createElement(HookHarness, { onValue: (nextValue) => { value = nextValue; } }));
    });

    await render();
    expect(value).toEqual({
      projectRef: { id: 'project-a', path: '/workspace/project-a' },
      directory: '/workspace/project-a',
    });

    // The user picks a Recent-section session from project B; the mocked store
    // is not reactive, so re-render to simulate the zustand notify.
    sessionUIStoreState.currentSessionId = 'ses-recent';
    await render();

    expect(useSessionCalls.at(-1)).toEqual(['ses-recent', '/workspace/project-b']);
    expect(value).toEqual({
      projectRef: { id: 'project-b', path: '/workspace/project-b' },
      directory: '/workspace/project-b',
    });
  });
});
