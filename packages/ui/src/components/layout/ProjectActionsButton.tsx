import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { extractAnnouncedUrls, extractProjectActionUrl } from '@/lib/terminalPreview';
import { setAnnouncedDevServers } from '@/lib/browser/announcedServers';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import {
  getProjectActionsState,
  type OpenChamberProjectAction,
  type ProjectRef,
} from '@/lib/openchamberConfig';
import {
  normalizeProjectActionDirectory,
  PROJECT_ACTION_ICONS,
  PROJECT_ACTIONS_UPDATED_EVENT,
  resolveProjectActionDesktopForwardUrl,
  toProjectActionRunKey,
} from '@/lib/projectActions';
import { detectDevServerCommand, readPackageJsonScripts } from '@/lib/detectDevServer';
import {
  createProjectActionTerminalSession,
  normalizeProjectActionCommand,
  reconcileTerminalSessionAuthority,
  stopProjectActionTerminalSession,
} from '@/lib/projectActionTerminal';
import type { TerminalTab } from '@/stores/useTerminalStore';

type UrlWatchEntry = {
  lastSeenChunkId: number | null;
  openedUrl: boolean;
  tail: string;
  openInPreview: boolean;
  /** Addresses announced so far by an auto-discovery run, in announcement order. */
  announced: string[];
  /** Set once the panel is showing these candidates and wants later ones too. */
  offering: boolean;
};

interface ProjectActionsButtonProps {
  projectRef: ProjectRef | null;
  directory: string;
  className?: string;
  compact?: boolean;
  allowMobile?: boolean;
}

const AUTO_DISCOVER_ACTION_ID = '__openchamber_auto_discover_preview__';
const AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS = 15_000;
/**
 * How long to keep listening after the first server announces itself. A project
 * that starts several at once staggers them by a second or two, and opening the
 * first to speak would just be a race.
 */
const AUTO_DISCOVER_SETTLE_MS = 3_000;

const resolveProjectActionIconName = (action: Pick<OpenChamberProjectAction, 'id' | 'icon'>): IconName => {
  if (action.id === AUTO_DISCOVER_ACTION_ID) {
    return 'scan-2';
  }
  const matchedIcon = PROJECT_ACTION_ICONS.find((entry) => entry.key === action.icon);
  return matchedIcon?.Icon ?? 'play';
};

const normalizeManualOpenUrl = (value: string | undefined): string | null => {
  const raw = (value || '').trim();
  if (!raw) {
    return null;
  }

  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};


export const ProjectActionsButton = ({
  projectRef,
  directory,
  className,
  compact = false,
  allowMobile = false,
}: ProjectActionsButtonProps) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { terminal, runtime } = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const isDesktopShellApp = React.useMemo(() => isDesktopShell(), []);
  const desktopSshInstances = useDesktopSshStore((state) => state.instances);
  const loadDesktopSsh = useDesktopSshStore((state) => state.load);

  const terminalShell = useUIStore((state) => state.terminalShell);
  const terminalLoginShell = useUIStore((state) => state.terminalLoginShells.includes(state.terminalShell));
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsProjectsSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);
  const openContextPreview = useUIStore((state) => state.openContextPreview);

  const ensureDirectory = useTerminalStore((state) => state.ensureDirectory);
  const reconcileServerSessions = useTerminalStore((state) => state.reconcileServerSessions);
  const setTabLabel = useTerminalStore((state) => state.setTabLabel);
  const setTabIconKey = useTerminalStore((state) => state.setTabIconKey);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const setConnecting = useTerminalStore((state) => state.setConnecting);
  const setTabSessionId = useTerminalStore((state) => state.setTabSessionId);
  const setTabPurpose = useTerminalStore((state) => state.setTabPurpose);
  const allocateActionExecution = useTerminalStore((state) => state.allocateActionExecution);
  const setTabLifecycle = useTerminalStore((state) => state.setTabLifecycle);
  const setTabPreviewUrl = useTerminalStore((state) => state.setTabPreviewUrl);
  const matchesActionExecution = useTerminalStore((state) => state.matchesActionExecution);

  const [actions, setActions] = React.useState<OpenChamberProjectAction[]>([]);
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const urlWatchByRunKeyRef = React.useRef<Record<string, UrlWatchEntry>>({});
  const streamCleanupByRunKeyRef = React.useRef<Record<string, () => void>>({});
  const previewWaitTimeoutByRunKeyRef = React.useRef<Record<string, number>>({});
  const startingRunKeysRef = React.useRef<Set<string>>(new Set());
  const loadRequestIdRef = React.useRef(0);
  const [waitingForPreviewByExecution, setWaitingForPreviewByExecution] = React.useState<Record<string, true>>({});

  const projectId = projectRef?.id ?? null;
  const projectPath = projectRef?.path ?? '';

  const stableProjectRef = React.useMemo(() => {
    if (!projectId) {
      return null;
    }
    return { id: projectId, path: projectPath };
  }, [projectId, projectPath]);

  React.useEffect(() => {
    if (!isDesktopShellApp) {
      return;
    }
    void loadDesktopSsh().catch(() => undefined);
  }, [isDesktopShellApp, loadDesktopSsh]);

  const openExternal = React.useCallback(async (url: string) => {
    await openExternalUrl(url);
  }, []);

  const loadActions = React.useCallback(async () => {
    if (!stableProjectRef) {
      return;
    }

    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;

    setIsLoading(true);
    try {
      const state = await getProjectActionsState(stableProjectRef);
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      const filtered = state.actions;
      setActions(filtered);
      setSelectedActionId((current) => {
        if (current === AUTO_DISCOVER_ACTION_ID) {
          return current;
        }
        if (current && filtered.some((entry) => entry.id === current)) {
          return current;
        }
        return null;
      });
    } catch {
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      // Keep last known actions while next project loads or transient fetch fails.
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [stableProjectRef]);

  const normalizedDirectory = React.useMemo(() => {
    return normalizeProjectActionDirectory(directory || stableProjectRef?.path || '');
  }, [directory, stableProjectRef?.path]);

  const directoryTerminalState = useTerminalStore((state) => (
    normalizedDirectory ? state.sessions.get(normalizedDirectory) : undefined
  ));

  const executionKey = React.useCallback((actionId: string, executionId: string) => (
    `${normalizedDirectory}::${actionId}::${executionId}`
  ), [normalizedDirectory]);

  const getActionTab = React.useCallback((actionId: string, state = useTerminalStore.getState()): TerminalTab | null => {
    if (!normalizedDirectory) return null;
    return state.getDirectoryState(normalizedDirectory)?.tabs.find((tab) => (
      tab.purpose.type === 'project-action' && tab.purpose.actionId === actionId
    )) ?? null;
  }, [normalizedDirectory]);

  const projectActionRuns = React.useMemo(() => {
    const runs: Record<string, { directory: string; actionId: string; tabId: string; sessionId: string; executionId: string; status: 'running' | 'waiting-for-preview' | 'stopping' }> = {};
    for (const tab of directoryTerminalState?.tabs ?? []) {
      if (tab.purpose.type !== 'project-action' || !tab.purpose.executionId || !tab.terminalSessionId) continue;
      if (tab.lifecycle === 'idle' || tab.lifecycle === 'exited') continue;
      const runKey = toProjectActionRunKey(normalizedDirectory, tab.purpose.actionId);
      const execKey = executionKey(tab.purpose.actionId, tab.purpose.executionId);
      runs[runKey] = {
        directory: normalizedDirectory,
        actionId: tab.purpose.actionId,
        tabId: tab.id,
        sessionId: tab.terminalSessionId,
        executionId: tab.purpose.executionId,
        status: tab.lifecycle === 'stopping'
          ? 'stopping'
          : waitingForPreviewByExecution[execKey]
            ? 'waiting-for-preview'
            : 'running',
      };
    }
    return runs;
  }, [directoryTerminalState?.tabs, executionKey, normalizedDirectory, waitingForPreviewByExecution]);

  const clearExecutionUi = React.useCallback((actionId: string, executionId: string) => {
    const key = executionKey(actionId, executionId);
    delete urlWatchByRunKeyRef.current[key];
    streamCleanupByRunKeyRef.current[key]?.();
    delete streamCleanupByRunKeyRef.current[key];
    const browserWindow = globalThis.window;
    if (browserWindow) {
      browserWindow.clearTimeout(previewWaitTimeoutByRunKeyRef.current[key]);
    }
    delete previewWaitTimeoutByRunKeyRef.current[key];
    setWaitingForPreviewByExecution((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, [executionKey]);

  const selectedAction = React.useMemo(() => {
    if (!selectedActionId) {
      return null;
    }
    return actions.find((entry) => entry.id === selectedActionId) ?? null;
  }, [actions, selectedActionId]);

  const autoDiscoverAction = React.useMemo<OpenChamberProjectAction>(() => ({
    id: AUTO_DISCOVER_ACTION_ID,
    name: t('projectActions.actions.autoDiscover'),
    command: '',
    icon: 'scan-2',
    autoOpenUrl: true,
  }), [t]);

  const canUseAutoDiscover = !isMobile;
  const displayActions = React.useMemo(
    () => canUseAutoDiscover ? [autoDiscoverAction, ...actions] : actions,
    [actions, autoDiscoverAction, canUseAutoDiscover]
  );

  React.useEffect(() => {
    void loadActions();
  }, [loadActions]);

  React.useEffect(() => {
    if (!normalizedDirectory || !terminal.listSessions) {
      return;
    }
    let cancelled = false;
    void reconcileTerminalSessionAuthority(terminal, normalizedDirectory).then((sessions) => {
      if (cancelled || !sessions) return;
      reconcileServerSessions(normalizedDirectory, sessions);
    });
    return () => {
      cancelled = true;
    };
  }, [normalizedDirectory, reconcileServerSessions, terminal]);

  React.useEffect(() => {
    if (!normalizedDirectory) {
      return;
    }
    for (const tab of directoryTerminalState?.tabs ?? []) {
      if (tab.purpose.type !== 'project-action') continue;
      const actionId = tab.purpose.actionId;
      const action = displayActions.find((entry) => entry.id === actionId);
      const nextLabel = action?.name ?? actionId;
      const nextIcon = action?.icon || 'play';
      if (tab.label !== nextLabel) {
        setTabLabel(normalizedDirectory, tab.id, nextLabel);
      }
      if (tab.iconKey !== nextIcon) {
        setTabIconKey(normalizedDirectory, tab.id, nextIcon);
      }
    }
  }, [directoryTerminalState?.tabs, displayActions, normalizedDirectory, setTabIconKey, setTabLabel]);

  React.useEffect(() => {
    const browserWindow = globalThis.window;
    if (!browserWindow) {
      return;
    }

    const handler = (event: Event) => {
      // SAFETY: this event name is only dispatched by our own project-actions update helper with this detail payload.
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!projectId) {
        return;
      }
      if (detail?.projectId && detail.projectId !== projectId) {
        return;
      }
      void loadActions();
    };

    browserWindow.addEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    return () => {
      browserWindow.removeEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    };
  }, [loadActions, projectId]);

  React.useEffect(() => {
    if (!selectedActionId) {
      return;
    }
    if (selectedActionId === AUTO_DISCOVER_ACTION_ID && canUseAutoDiscover) {
      return;
    }
    if (!actions.some((entry) => entry.id === selectedActionId)) {
      setSelectedActionId(null);
    }
  }, [actions, canUseAutoDiscover, selectedActionId]);

  React.useEffect(() => {
    /**
     * Decides what an auto-discovery run found, once its servers have had a
     * moment to announce themselves. One address is opened; several are offered
     * in the browser panel, because choosing between them would be a guess
     * dressed up as a feature.
     */
    const settleAutoDiscovery = (runKey: string) => {
      delete previewWaitTimeoutByRunKeyRef.current[runKey];
      const watch = urlWatchByRunKeyRef.current[runKey];
      if (!watch || watch.openedUrl) return;

      const run = projectActionRuns[runKey];
      if (!run) return;

      const candidates = watch.announced;
      if (candidates.length === 0) return;
      watch.openedUrl = true;
      setWaitingForPreviewByExecution((current) => {
        const key = executionKey(run.actionId, run.executionId);
        if (!current[key]) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });

      if (candidates.length === 1) {
        setAnnouncedDevServers(run.directory, []);
        setTabPreviewUrl(run.directory, run.tabId, candidates[0], { locked: false, autoOpened: true });
        openContextPreview(run.directory, candidates[0]);
        return;
      }

      watch.offering = true;
      setAnnouncedDevServers(run.directory, candidates);
      useUIStore.getState().openContextSurface(run.directory, 'browser');
      toast.info(t('projectActions.toast.multipleServers'));
    };

    const monitorRuns = () => {
      const terminalStore = useTerminalStore.getState();
      const terminalSessions = terminalStore.sessions;
      const currentRuns = projectActionRuns;
      for (const [runKey, entry] of Object.entries(currentRuns)) {
        const directoryState = terminalSessions.get(entry.directory);
        const tab = directoryState?.tabs.find((item) => item.id === entry.tabId);
        if (!tab || tab.terminalSessionId !== entry.sessionId) {
          clearExecutionUi(entry.actionId, entry.executionId);
          continue;
        }

        const watch = urlWatchByRunKeyRef.current[runKey] ?? { lastSeenChunkId: null, openedUrl: false, tail: '', openInPreview: false, announced: [], offering: false };
        urlWatchByRunKeyRef.current[runKey] = watch;
        const action = displayActions.find((item) => item.id === entry.actionId);
        const bufferChunks = terminalStore.getBuffer(entry.directory, entry.tabId).chunks;
        if (!action || bufferChunks.length === 0) continue;

        const nextChunks = bufferChunks.filter((chunk) => watch.lastSeenChunkId === null || chunk.id > watch.lastSeenChunkId);
        if (nextChunks.length === 0) continue;

        const combined = nextChunks.map((chunk) => chunk.data).join('');
        const textForScan = `${watch.tail}${combined}`;
        // Auto-discovery inferred the command; it must not also infer the
        // address. It collects what the servers announce and decides once they
        // have had a moment to all speak up.
        // Keep listening after the panel starts offering candidates: servers in
        // one project can be seconds apart, and a list that froze at whoever was
        // ready first would quietly omit the rest.
        if (watch.openInPreview && (!watch.openedUrl || watch.offering)) {
          const announced = extractAnnouncedUrls(textForScan);
          const before = watch.announced.length;
          for (const url of announced) {
            if (!watch.announced.includes(url)) watch.announced.push(url);
          }
          const added = watch.announced.length - before;

          if (watch.offering && added > 0) {
            setAnnouncedDevServers(entry.directory, watch.announced);
          } else if (!watch.openedUrl && before === 0 && watch.announced.length > 0) {
            window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
            previewWaitTimeoutByRunKeyRef.current[runKey] = window.setTimeout(
              () => settleAutoDiscovery(runKey),
              AUTO_DISCOVER_SETTLE_MS,
            );
          }
        }

        const maybeUrl = !watch.openedUrl && action.autoOpenUrl === true && !watch.openInPreview
          ? extractProjectActionUrl(textForScan)
          : null;
        const lastChunkId = nextChunks[nextChunks.length - 1]?.id ?? watch.lastSeenChunkId;

        watch.lastSeenChunkId = lastChunkId;
        watch.tail = textForScan.slice(-512);

        if (maybeUrl) {
          watch.openedUrl = true;
          if (watch.openInPreview) {
            const run = currentRuns[runKey];
            if (run) {
              setTabPreviewUrl(run.directory, run.tabId, maybeUrl, { locked: false, autoOpened: false, expectedExecutionId: run.executionId });
              if (run.status === 'waiting-for-preview') {
                setWaitingForPreviewByExecution((current) => {
                  const executionStateKey = executionKey(run.actionId, run.executionId);
                  if (!current[executionStateKey]) return current;
                  const next = { ...current };
                  delete next[executionStateKey];
                  return next;
                });
              }
              window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
              delete previewWaitTimeoutByRunKeyRef.current[runKey];
              openContextPreview(run.directory, maybeUrl);
            }
          } else {
            void openExternal(maybeUrl);
            toast.success(t('projectActions.toast.openedUrlFromOutput'));
          }
        }
        urlWatchByRunKeyRef.current[runKey] = watch;
      }

      for (const runKey of Object.keys(urlWatchByRunKeyRef.current)) {
        if (!currentRuns[runKey]) {
          delete urlWatchByRunKeyRef.current[runKey];
          window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
          delete previewWaitTimeoutByRunKeyRef.current[runKey];
        }
      }
    };

    monitorRuns();
    return useTerminalStore.subscribe((state, previousState) => {
      if (state.sessions !== previousState.sessions || state.buffers !== previousState.buffers) monitorRuns();
    });
  }, [clearExecutionUi, displayActions, executionKey, openContextPreview, openExternal, projectActionRuns, setTabPreviewUrl, t]);

  React.useEffect(() => {
    for (const tab of directoryTerminalState?.tabs ?? []) {
      if (tab.purpose.type !== 'project-action' || !tab.purpose.executionId || !tab.terminalSessionId) continue;
      if (tab.lifecycle !== 'running') continue;
      const actionId = tab.purpose.actionId;
      const currentExecutionId = tab.purpose.executionId;
      const streamKey = executionKey(actionId, currentExecutionId);
      if (streamCleanupByRunKeyRef.current[streamKey]) continue;
      const subscription = terminal.connect(tab.terminalSessionId, {
        onEvent: (event) => {
          if (!matchesActionExecution(normalizedDirectory, tab.id, currentExecutionId)) return;
          if (event.type === 'snapshot') {
            useTerminalStore.getState().replaceBuffer(normalizedDirectory, tab.id, event.data ?? '', event.sequence ?? 0);
            if (event.status === 'running') {
              useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tab.id, 'running', { expectedExecutionId: currentExecutionId });
            }
            if (event.status === 'exited') {
              useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tab.id, 'exited', { expectedExecutionId: currentExecutionId });
              useTerminalStore.getState().setTabPurpose(normalizedDirectory, tab.id, { type: 'project-action', actionId, executionId: null });
              clearExecutionUi(actionId, currentExecutionId);
            }
          }
          const output = event.type === 'data' ? (event.data ?? '') : '';
          if (output) {
            useTerminalStore.getState().appendToBuffer(normalizedDirectory, tab.id, output, event.sequence, event.replayData);
          }
          if (event.type === 'exit') {
            useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tab.id, 'exited', { expectedExecutionId: currentExecutionId });
            useTerminalStore.getState().setTabPurpose(normalizedDirectory, tab.id, { type: 'project-action', actionId, executionId: null });
            clearExecutionUi(actionId, currentExecutionId);
          }
        },
        onError: (_error, fatal) => {
          if (!fatal || !matchesActionExecution(normalizedDirectory, tab.id, currentExecutionId)) return;
          useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tab.id, 'exited', { expectedExecutionId: currentExecutionId });
          useTerminalStore.getState().setTabSessionId(normalizedDirectory, tab.id, null, { expectedExecutionId: currentExecutionId });
          useTerminalStore.getState().setTabPurpose(normalizedDirectory, tab.id, { type: 'project-action', actionId, executionId: null });
          clearExecutionUi(actionId, currentExecutionId);
        },
      });
      streamCleanupByRunKeyRef.current[streamKey] = subscription.close;
    }
  }, [clearExecutionUi, directoryTerminalState?.tabs, executionKey, matchesActionExecution, normalizedDirectory, terminal]);

  const getOrCreateActionTab = React.useCallback(async (action: OpenChamberProjectAction, options: { revealTerminal?: boolean } = {}) => {
    if (!normalizedDirectory) {
      throw new Error(t('projectActions.error.noActiveDirectory'));
    }

    const key = toProjectActionRunKey(normalizedDirectory, action.id);
    ensureDirectory(normalizedDirectory);

    const currentStore = useTerminalStore.getState();
    const existingTab = getActionTab(action.id, currentStore);
    const tabId = existingTab?.id ?? currentStore.createTab(normalizedDirectory);

    setTabLabel(normalizedDirectory, tabId, action.name);
    setTabIconKey(normalizedDirectory, tabId, action.icon || 'play');
    if (!existingTab) {
      setTabPurpose(normalizedDirectory, tabId, { type: 'project-action', actionId: action.id, executionId: null });
    }
    setActiveTab(normalizedDirectory, tabId);
    if (options.revealTerminal !== false) {
      useUIStore.getState().openContextPanelTab(normalizedDirectory, { mode: 'terminal' });
    }

    const stateAfterTab = useTerminalStore.getState().getDirectoryState(normalizedDirectory);
    const tab = stateAfterTab?.tabs.find((entry) => entry.id === tabId);
    return {
      key,
      tabId,
      sessionId: tab?.terminalSessionId ?? null,
      executionId: tab?.purpose.type === 'project-action' ? tab.purpose.executionId : null,
    };
  }, [
    ensureDirectory,
    getActionTab,
    normalizedDirectory,
    setActiveTab,
    setTabIconKey,
    setTabLabel,
    setTabPurpose,
    t,
  ]);

  const runAction = React.useCallback(async (action: OpenChamberProjectAction) => {
    if (runtime.isVSCode || (!allowMobile && isMobile)) {
      return;
    }

    if (!normalizedDirectory) {
      toast.error(t('projectActions.error.noActiveDirectoryForAction'));
      return;
    }

    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const existingRun = projectActionRuns[runKey];
    if (existingRun && existingRun.status === 'running') {
      return;
    }
    if (startingRunKeysRef.current.has(runKey)) return;
    startingRunKeysRef.current.add(runKey);

    try {
      const discovered = action.id === AUTO_DISCOVER_ACTION_ID
        ? await (async (): Promise<OpenChamberProjectAction> => {
          const [actionsState, scripts] = await Promise.all([
            getProjectActionsState({ id: stableProjectRef?.id ?? '', path: normalizedDirectory }),
            readPackageJsonScripts(normalizedDirectory),
          ]);
          const devServer = await detectDevServerCommand(normalizedDirectory, actionsState.actions, scripts);
          if (!devServer) {
            throw new Error(t('contextPanel.preview.noDevServer'));
          }
          return {
            id: AUTO_DISCOVER_ACTION_ID,
            name: t('projectActions.actions.autoDiscover'),
            command: devServer.command,
            icon: 'scan-2',
            autoOpenUrl: true,
            openUrl: devServer.previewUrlHint || '',
          };
        })()
        : action;

      const hasCustomOpenUrl = discovered.autoOpenUrl === true && (discovered.openUrl || '').trim().length > 0;
      const revealTerminal = !hasCustomOpenUrl && action.id !== AUTO_DISCOVER_ACTION_ID;
      const { key, tabId, sessionId } = await getOrCreateActionTab(discovered, { revealTerminal });
      const normalizedCommand = normalizeProjectActionCommand(discovered.command);
      if (!normalizedCommand) {
        throw new Error(t('projectActions.error.failedToRunAction'));
      }

      const hasDesktopForwardSelection = discovered.autoOpenUrl === true
        && isDesktopShellApp
        && (discovered.desktopOpenSshForward || '').trim().length > 0;
      const manualOpenUrl = discovered.autoOpenUrl ? normalizeManualOpenUrl(discovered.openUrl) : null;
      const desktopForwardUrl = discovered.autoOpenUrl && isDesktopShellApp
        ? resolveProjectActionDesktopForwardUrl(discovered.desktopOpenSshForward, desktopSshInstances)
        : null;

      if (terminal.listSessions) {
        const currentTab = getActionTab(discovered.id);
        if (currentTab?.purpose.type === 'project-action' && currentTab.purpose.executionId === null) {
          const sessions = await reconcileTerminalSessionAuthority(terminal, normalizedDirectory);
          if (sessions) {
            reconcileServerSessions(normalizedDirectory, sessions);
          }
        }
      }

      const priorTab = getActionTab(discovered.id);
      const priorExecutionId = priorTab?.purpose.type === 'project-action' ? priorTab.purpose.executionId : null;
      if (priorExecutionId) {
        clearExecutionUi(discovered.id, priorExecutionId);
      }

      const requestedExecutionId = allocateActionExecution(normalizedDirectory, tabId, discovered.id);
      if (!requestedExecutionId) {
        throw new Error(t('projectActions.error.failedToCreateTerminalSession'));
      }

      setConnecting(normalizedDirectory, tabId, true, { expectedExecutionId: requestedExecutionId });
      let activeSessionId: string | null = null;
      let adoptedExecutionId = requestedExecutionId;
      try {
        const created = await createProjectActionTerminalSession({
          terminal,
          previousSessionId: sessionId,
          createOptions: {
            cwd: normalizedDirectory,
            sessionId: tabId,
            shell: terminalShell,
            loginShell: terminalLoginShell,
            themeMode: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
            terminalBackground: currentTheme.colors.surface.background,
            terminalForeground: currentTheme.colors.syntax.base.foreground,
          },
          command: normalizedCommand,
          isRunStillExpected: () => matchesActionExecution(normalizedDirectory, tabId, requestedExecutionId),
          purpose: { type: 'project-action', actionId: discovered.id, executionId: requestedExecutionId },
        });
        if (!matchesActionExecution(normalizedDirectory, tabId, requestedExecutionId)) {
          await terminal.close(created.sessionId).catch(() => undefined);
          return;
        }
        adoptedExecutionId = created.purpose?.type === 'project-action' ? created.purpose.executionId : requestedExecutionId;
        setTabPurpose(normalizedDirectory, tabId, { type: 'project-action', actionId: discovered.id, executionId: adoptedExecutionId });
        activeSessionId = created.sessionId;
        setTabSessionId(normalizedDirectory, tabId, activeSessionId, { expectedExecutionId: adoptedExecutionId });
        setTabLifecycle(normalizedDirectory, tabId, 'running', { expectedExecutionId: adoptedExecutionId });
      } finally {
        setConnecting(normalizedDirectory, tabId, false, { expectedExecutionId: adoptedExecutionId });
      }

      if (!activeSessionId) {
        throw new Error(t('projectActions.error.failedToCreateTerminalSession'));
      }

      if (!matchesActionExecution(normalizedDirectory, tabId, adoptedExecutionId)) {
        try {
          await terminal.close(activeSessionId);
        } catch {
          // noop
        }
        return;
      }

      const executionStateKey = executionKey(discovered.id, adoptedExecutionId);
      setConnecting(normalizedDirectory, tabId, true, { expectedExecutionId: adoptedExecutionId });
      const subscription = terminal.connect(
          activeSessionId,
          { onEvent: (event) => {
            if (event.type === 'snapshot') {
              useTerminalStore.getState().replaceBuffer(normalizedDirectory, tabId, event.data ?? '', event.sequence ?? 0);
              useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false, { expectedExecutionId: adoptedExecutionId });
              if (event.purpose?.type === 'project-action') {
                useTerminalStore.getState().setTabPurpose(normalizedDirectory, tabId, { type: 'project-action', actionId: event.purpose.actionId, executionId: event.purpose.executionId });
              }
              if (event.status === 'running') {
                useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tabId, 'running', { expectedExecutionId: adoptedExecutionId });
              }
              if (event.status === 'exited') {
                useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tabId, 'exited', { expectedExecutionId: adoptedExecutionId });
                useTerminalStore.getState().setTabPurpose(normalizedDirectory, tabId, { type: 'project-action', actionId: discovered.id, executionId: null });
                clearExecutionUi(discovered.id, adoptedExecutionId);
              }
            }
            const output = event.type === 'data' ? (event.data ?? '') : '';
            if (output) {
              useTerminalStore.getState().appendToBuffer(normalizedDirectory, tabId, output, event.sequence, event.replayData);
            }
            if (event.type === 'exit') {
              useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tabId, 'exited', { expectedExecutionId: adoptedExecutionId });
              useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false, { expectedExecutionId: adoptedExecutionId });
              useTerminalStore.getState().setTabPurpose(normalizedDirectory, tabId, { type: 'project-action', actionId: discovered.id, executionId: null });
              clearExecutionUi(discovered.id, adoptedExecutionId);
            }
          }, onError: (_error, fatal) => {
            useTerminalStore.getState().setConnecting(normalizedDirectory, tabId, false, { expectedExecutionId: adoptedExecutionId });
            if (fatal) {
              useTerminalStore.getState().setTabLifecycle(normalizedDirectory, tabId, 'exited', { expectedExecutionId: adoptedExecutionId });
              useTerminalStore.getState().setTabSessionId(normalizedDirectory, tabId, null, { expectedExecutionId: adoptedExecutionId });
              useTerminalStore.getState().setTabPurpose(normalizedDirectory, tabId, { type: 'project-action', actionId: discovered.id, executionId: null });
              clearExecutionUi(discovered.id, adoptedExecutionId);
            }
          } },
        );
      if (!matchesActionExecution(normalizedDirectory, tabId, adoptedExecutionId)) {
        subscription.close();
        return;
      }
      streamCleanupByRunKeyRef.current[executionStateKey] = subscription.close;

      window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[executionStateKey]);
      delete previewWaitTimeoutByRunKeyRef.current[executionStateKey];
      if (discovered.id === AUTO_DISCOVER_ACTION_ID && !manualOpenUrl) {
        setWaitingForPreviewByExecution((current) => ({ ...current, [executionStateKey]: true }));
        previewWaitTimeoutByRunKeyRef.current[executionStateKey] = window.setTimeout(() => {
          setWaitingForPreviewByExecution((current) => {
            if (!current[executionStateKey]) return current;
            const next = { ...current };
            delete next[executionStateKey];
            return next;
          });
          const run = projectActionRuns[key];
          if (run) {
            useTerminalStore.getState().setActiveTab(run.directory, run.tabId);
            useUIStore.getState().openContextPanelTab(run.directory, { mode: 'terminal' });
          }
          delete previewWaitTimeoutByRunKeyRef.current[executionStateKey];
        }, AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS);
      }

      urlWatchByRunKeyRef.current[executionStateKey] = {
        lastSeenChunkId: null,
        openedUrl: Boolean(desktopForwardUrl) || Boolean(manualOpenUrl) || hasCustomOpenUrl,
        tail: '',
        openInPreview: discovered.id === AUTO_DISCOVER_ACTION_ID,
        announced: [],
        offering: false,
      };

      if (desktopForwardUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: true, expectedExecutionId: adoptedExecutionId });
        void openExternal(desktopForwardUrl);
        toast.success(t('projectActions.toast.openedForwardedUrl'));
      } else if (manualOpenUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, manualOpenUrl, { locked: true, autoOpened: true, expectedExecutionId: adoptedExecutionId });
        openContextPreview(normalizedDirectory, manualOpenUrl);
        toast.success(t('projectActions.toast.openedActionUrl'));
      } else if (hasCustomOpenUrl) {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: true, expectedExecutionId: adoptedExecutionId });
        toast.error(t('projectActions.error.invalidCustomUrlFormat'));
      } else if (hasDesktopForwardSelection) {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: true, expectedExecutionId: adoptedExecutionId });
        toast.error(t('projectActions.error.selectedDesktopSshForwardUnavailable'));
      } else {
        setTabPreviewUrl(normalizedDirectory, tabId, null, { locked: false, autoOpened: false, expectedExecutionId: adoptedExecutionId });
      }

    } catch (error) {
      const currentTab = getActionTab(action.id);
      if (currentTab?.purpose.type === 'project-action' && currentTab.purpose.executionId) {
        clearExecutionUi(action.id, currentTab.purpose.executionId);
        setTabLifecycle(normalizedDirectory, currentTab.id, 'exited', { expectedExecutionId: currentTab.purpose.executionId });
        setTabPurpose(normalizedDirectory, currentTab.id, { type: 'project-action', actionId: action.id, executionId: null });
      }
      if (error instanceof Error && error.message === 'PROJECT_ACTION_RUN_CANCELLED') {
        return;
      }
      if (error instanceof Error && (error.message === 'COMMAND_MODE_UNSUPPORTED' || error.message === 'PROJECT_ACTION_PURPOSE_UNSUPPORTED')) {
        toast.error(t('projectActions.error.failedToCreateTerminalSession'));
        return;
      }
      toast.error(error instanceof Error ? error.message : t('projectActions.error.failedToRunAction'));
    } finally {
      startingRunKeysRef.current.delete(runKey);
    }
  }, [
    currentTheme.colors.surface.background,
    currentTheme.colors.syntax.base.foreground,
    currentTheme.metadata.variant,
    desktopSshInstances,
    getOrCreateActionTab,
    allowMobile,
    isMobile,
    isDesktopShellApp,
    normalizedDirectory,
    terminalLoginShell,
    terminalShell,
    openExternal,
    openContextPreview,
    projectActionRuns,
    runtime.isVSCode,
    matchesActionExecution,
    clearExecutionUi,
    executionKey,
    getActionTab,
    reconcileServerSessions,
    allocateActionExecution,
    setConnecting,
    setTabLifecycle,
    setTabPurpose,
    setTabPreviewUrl,
    setTabSessionId,
    stableProjectRef?.id,
    t,
    terminal,
  ]);

  const stopAction = React.useCallback(async (action: OpenChamberProjectAction) => {
    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const activeRun = projectActionRuns[runKey];
    if (!activeRun) {
      return;
    }

    await stopProjectActionTerminalSession({
      terminal,
      sessionId: activeRun.sessionId,
      isExecutionStillCurrent: () => matchesActionExecution(activeRun.directory, activeRun.tabId, activeRun.executionId),
      markStopping: () => {
        setTabLifecycle(activeRun.directory, activeRun.tabId, 'stopping', { expectedExecutionId: activeRun.executionId });
      },
      restoreRunning: () => {
        setTabLifecycle(activeRun.directory, activeRun.tabId, 'running', { expectedExecutionId: activeRun.executionId });
      },
      clearSession: () => {
        setTabSessionId(activeRun.directory, activeRun.tabId, null, { expectedExecutionId: activeRun.executionId });
      },
      finalizeExit: () => {
        setTabLifecycle(activeRun.directory, activeRun.tabId, 'exited', { expectedExecutionId: activeRun.executionId });
        setTabPurpose(activeRun.directory, activeRun.tabId, { type: 'project-action', actionId: activeRun.actionId, executionId: null });
        clearExecutionUi(activeRun.actionId, activeRun.executionId);
      },
    });
  }, [clearExecutionUi, matchesActionExecution, normalizedDirectory, projectActionRuns, setTabLifecycle, setTabPurpose, setTabSessionId, terminal]);

  const handlePrimaryClick = React.useCallback(() => {
    const action = selectedAction ?? displayActions[0];
    if (!action) {
      return;
    }
    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const runningEntry = projectActionRuns[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  }, [displayActions, normalizedDirectory, runAction, projectActionRuns, selectedAction, stopAction]);

  const handleSelectAction = React.useCallback((action: OpenChamberProjectAction, toggleStopIfRunning = false) => {
    setSelectedActionId(action.id);

    if (!toggleStopIfRunning) {
      void runAction(action);
      return;
    }

    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const runningEntry = projectActionRuns[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  }, [normalizedDirectory, runAction, projectActionRuns, stopAction]);

  const openProjectActionsSettings = React.useCallback(() => {
    if (!stableProjectRef?.id) {
      return;
    }
    setSettingsProjectsSelectedId(stableProjectRef.id);
    setSettingsPage('projects');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage, setSettingsProjectsSelectedId, stableProjectRef?.id]);

  const previewAction = selectedAction ?? displayActions[0] ?? null;
  const previewRun = previewAction ? projectActionRuns[toProjectActionRunKey(normalizedDirectory, previewAction.id)] : null;
  const selectedRunPreviewUrl = useTerminalStore((state) => {
    if (!previewRun) return null;
    return state.sessions.get(previewRun.directory)?.tabs.find((tab) => tab.id === previewRun.tabId)?.previewUrl ?? null;
  });

  if (runtime.isVSCode || (!allowMobile && isMobile) || !stableProjectRef || !normalizedDirectory) {
    return null;
  }

  const resolvedSelected = selectedAction ?? displayActions[0] ?? null;
  if (!resolvedSelected) {
    return null;
  }

  const selectedIconName = resolveProjectActionIconName(resolvedSelected);
  const selectedRunKey = toProjectActionRunKey(normalizedDirectory, resolvedSelected.id);
  const selectedRunning = projectActionRuns[selectedRunKey];
  const isStoppingSelected = selectedRunning?.status === 'stopping';
  const isWaitingForSelectedPreview = selectedRunning?.status === 'waiting-for-preview';
  const showSelectedPreviewButton = Boolean(selectedRunning && selectedRunPreviewUrl);
  const handleOpenSelectedPreview = () => {
    if (!selectedRunning || !selectedRunPreviewUrl) {
      return;
    }
    openContextPreview(selectedRunning.directory, selectedRunPreviewUrl);
  };
  const isAutoDiscoverSelected = resolvedSelected.id === AUTO_DISCOVER_ACTION_ID;

  if (compact) {
    return (
      <div className="inline-flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={isLoading || isStoppingSelected}
              className={cn(
                'app-region-no-drag inline-flex h-9 w-9 items-center justify-center rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] p-2',
                'typography-ui-label font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                'disabled:cursor-not-allowed',
                className
              )}
              onClick={handlePrimaryClick}
              aria-label={selectedRunning
                ? t('projectActions.actions.stopNamedAria', { name: resolvedSelected.name })
                : t('projectActions.actions.runNamedAria', { name: resolvedSelected.name })}
            >
              {isStoppingSelected || isWaitingForSelectedPreview
                ? <Icon name="loader-4" className="h-5 w-5 animate-spin text-[var(--status-warning)]" />
                : selectedRunning
                  ? <Icon name="stop" className="h-5 w-5 text-[var(--status-warning)]" />
                  : <Icon name={selectedIconName} className="h-5 w-5" />}
            </button>
          </TooltipTrigger>
          {isAutoDiscoverSelected ? (
            <TooltipContent sideOffset={6}>{t('projectActions.actions.autoDiscoverTooltip')}</TooltipContent>
          ) : null}
        </Tooltip>
        {showSelectedPreviewButton ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="app-region-no-drag -ml-1 inline-flex h-9 w-7 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={t('projectActions.actions.openPreview')}
                onClick={handleOpenSelectedPreview}
              >
                <Icon name="global" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('projectActions.actions.openPreview')}</TooltipContent>
          </Tooltip>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="app-region-no-drag -ml-1 inline-flex h-9 w-5 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t('projectActions.actions.chooseActionAria')}
            >
              <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 max-h-[70vh] overflow-y-auto">
            <DropdownMenuItem className="flex items-center gap-2" onClick={openProjectActionsSettings}>
              <Icon name="add" className="h-4 w-4" />
              <span className="typography-ui-label text-foreground">{t('projectActions.actions.addNewAction')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {displayActions.map((entry) => {
              const iconName = resolveProjectActionIconName(entry);
              const runKey = toProjectActionRunKey(normalizedDirectory, entry.id);
              const runState = projectActionRuns[runKey];
              const isRunning = Boolean(runState);
              const isStopping = runState?.status === 'stopping';

              return (
                <DropdownMenuItem
                  key={entry.id}
                  className="flex items-center gap-2"
                  onClick={() => {
                    handleSelectAction(entry, true);
                  }}
                >
                  <Icon name={iconName} className="h-4 w-4" />
                  <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
                  {isStopping || runState?.status === 'waiting-for-preview'
                    ? <Icon name="loader-4" className="ml-auto h-4 w-4 animate-spin text-[var(--status-warning)]" />
                    : isRunning
                      ? <Icon name="stop" className="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                      : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'app-region-no-drag inline-flex shrink-0 items-center self-center rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px]',
        'bg-[var(--surface-elevated)] overflow-hidden',
        'border border-border/60',
        compact ? 'h-9' : 'h-7',
        className
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handlePrimaryClick}
            disabled={isLoading || isStoppingSelected}
            className={cn(
              'inline-flex h-full items-center justify-center typography-ui-label font-medium text-foreground hover:bg-interactive-hover',
              compact ? 'w-9 px-0' : 'px-2.5',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed'
            )}
            aria-label={selectedRunning
              ? t('projectActions.actions.stopNamedAria', { name: resolvedSelected.name })
              : t('projectActions.actions.runNamedAria', { name: resolvedSelected.name })}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
              {isStoppingSelected || isWaitingForSelectedPreview
                ? <Icon name="loader-4" className="h-4 w-4 animate-spin text-[var(--status-warning)]" />
                : selectedRunning
                  ? <Icon name="stop" className="h-4 w-4 text-[var(--status-warning)]" />
                  : <Icon name={selectedIconName} className="h-4 w-4" />}
            </span>
          </button>
        </TooltipTrigger>
        {isAutoDiscoverSelected ? (
          <TooltipContent sideOffset={6}>{t('projectActions.actions.autoDiscoverTooltip')}</TooltipContent>
        ) : null}
      </Tooltip>

      {showSelectedPreviewButton ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleOpenSelectedPreview}
              className={cn(
                compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
                'border-l border-[var(--interactive-border)] text-foreground',
                'hover:bg-interactive-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
              aria-label={t('projectActions.actions.openPreview')}
            >
              <Icon name="global" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{t('projectActions.actions.openPreview')}</TooltipContent>
        </Tooltip>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
              'border-l border-[var(--interactive-border)] text-muted-foreground',
              'hover:bg-interactive-hover hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
            )}
            aria-label={t('projectActions.actions.chooseActionAria')}
          >
            <Icon name="arrow-down-s" className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52 max-h-[70vh] overflow-y-auto">
          <DropdownMenuItem className="flex items-center gap-2" onClick={openProjectActionsSettings}>
            <Icon name="add" className="h-4 w-4" />
            <span className="typography-ui-label text-foreground">{t('projectActions.actions.addNewAction')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {displayActions.map((entry) => {
            const iconName = resolveProjectActionIconName(entry);
            const runKey = toProjectActionRunKey(normalizedDirectory, entry.id);
            const runState = projectActionRuns[runKey];
            const isRunning = Boolean(runState);
            const isStopping = runState?.status === 'stopping';

            return (
              <DropdownMenuItem
                key={entry.id}
                className="flex items-center gap-2"
                onClick={() => {
                  handleSelectAction(entry, true);
                }}
              >
                <Icon name={iconName} className="h-4 w-4" />
                <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
                {isStopping || runState?.status === 'waiting-for-preview'
                  ? <Icon name="loader-4" className="ml-auto h-4 w-4 animate-spin text-[var(--status-warning)]" />
                  : isRunning
                    ? <Icon name="stop" className="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                    : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
