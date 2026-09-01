import type { CreateTerminalOptions, TerminalAPI, TerminalServerSession, TerminalSession, TerminalSessionPurpose } from './api/types';

type ProjectActionTerminalCreateOptions = Omit<Extract<CreateTerminalOptions, { mode: 'command' }>, 'mode' | 'command'>;

type CreateProjectActionTerminalSessionOptions = {
  terminal: TerminalAPI;
  previousSessionId: string | null;
  createOptions: ProjectActionTerminalCreateOptions;
  command: string;
  isRunStillExpected: () => boolean;
  purpose: Extract<TerminalSessionPurpose, { type: 'project-action' }>;
};

type StopProjectActionTerminalSessionOptions = {
  terminal: TerminalAPI;
  sessionId: string;
  isExecutionStillCurrent: () => boolean;
  markStopping: () => void;
  restoreRunning: () => void;
  clearSession: () => void;
  finalizeExit: () => void;
  timeoutMs?: number;
};

const COMMAND_MODE_UNSUPPORTED_ERROR = 'COMMAND_MODE_UNSUPPORTED';
const PROJECT_ACTION_RUN_CANCELLED_ERROR = 'PROJECT_ACTION_RUN_CANCELLED';
const PROJECT_ACTION_PURPOSE_UNSUPPORTED_ERROR = 'PROJECT_ACTION_PURPOSE_UNSUPPORTED';

const createProjectActionTerminalError = (message: string): Error => new Error(message);

const closeTerminalSession = async (terminal: TerminalAPI, sessionId: string): Promise<void> => {
  try {
    await terminal.close(sessionId);
  } catch {
    // noop
  }
};

const rejectCreatedSession = async (terminal: TerminalAPI, sessionId: string, errorMessage: string): Promise<never> => {
  await closeTerminalSession(terminal, sessionId);
  throw createProjectActionTerminalError(errorMessage);
};

export const normalizeProjectActionCommand = (command: string): string => {
  const normalizedNewlines = command.trim().replace(/\r\n|\r/g, '\n');
  let next = '';
  for (let index = 0; index < normalizedNewlines.length; index += 1) {
    const code = normalizedNewlines.charCodeAt(index);
    const isControl = (code >= 0 && code <= 8)
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127;
    if (!isControl) {
      next += normalizedNewlines[index];
    }
  }
  return next;
};

const isCommandTerminalSession = (session: TerminalSession): boolean => session.mode === 'command';
const isProjectActionTerminalPurpose = (
  purpose: TerminalSessionPurpose | undefined,
): purpose is Extract<TerminalSessionPurpose, { type: 'project-action' }> => purpose?.type === 'project-action';

const isMatchingProjectActionPurpose = (
  purpose: TerminalSessionPurpose | undefined,
  actionId: string,
): purpose is Extract<TerminalSessionPurpose, { type: 'project-action' }> => (
  isProjectActionTerminalPurpose(purpose)
  && purpose.actionId === actionId
  && purpose.executionId.trim().length > 0
);

const reconcileFlights = new Map<string, Promise<TerminalServerSession[] | null>>();

export const createProjectActionTerminalSession = async ({
  terminal,
  previousSessionId,
  createOptions,
  command,
  isRunStillExpected,
  purpose,
}: CreateProjectActionTerminalSessionOptions): Promise<TerminalSession> => {
  if (previousSessionId) {
    await closeTerminalSession(terminal, previousSessionId);
  }

  const created = await terminal.createSession({
    ...createOptions,
    mode: 'command',
    command: normalizeProjectActionCommand(command),
    purpose,
  });

  if (!isCommandTerminalSession(created)) {
    await rejectCreatedSession(terminal, created.sessionId, COMMAND_MODE_UNSUPPORTED_ERROR);
  }

  if (!isMatchingProjectActionPurpose(created.purpose, purpose.actionId)) {
    await rejectCreatedSession(terminal, created.sessionId, PROJECT_ACTION_PURPOSE_UNSUPPORTED_ERROR);
  }

  if (!isRunStillExpected()) {
    await rejectCreatedSession(terminal, created.sessionId, PROJECT_ACTION_RUN_CANCELLED_ERROR);
  }

  return created;
};

export const waitForTerminalExit = (
  terminal: TerminalAPI,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> => new Promise((resolve) => {
  let settled = false;
  let subscription: { close: () => void } | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const finish = (exited: boolean) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    subscription?.close();
    resolve(exited);
  };
  subscription = terminal.connect(sessionId, {
    onEvent: (event) => {
      if (event.type === 'exit' || (event.type === 'snapshot' && event.status === 'exited')) finish(true);
    },
    onError: (_error, fatal) => { if (fatal) finish(true); },
  });
  if (settled) subscription.close();
  else timeout = setTimeout(() => finish(false), timeoutMs);
});

export const stopProjectActionTerminalSession = async ({
  terminal,
  sessionId,
  isExecutionStillCurrent,
  markStopping,
  restoreRunning,
  clearSession,
  finalizeExit,
  timeoutMs = 1000,
}: StopProjectActionTerminalSessionOptions): Promise<void> => {
  markStopping();

  const exitPromise = waitForTerminalExit(terminal, sessionId, timeoutMs);

  try {
    if (isExecutionStillCurrent()) {
      await terminal.sendInput(sessionId, '\x03');
    }
  } catch {
    // noop
  }

  const exitObserved = await exitPromise;
  if (!isExecutionStillCurrent()) {
    return;
  }

  if (!exitObserved) {
    let terminationFailed = false;
    if (terminal.forceKill) {
      try {
        if (isExecutionStillCurrent()) {
          await terminal.forceKill({ sessionId });
        }
      } catch {
        terminationFailed = true;
      }
    } else {
      try {
        if (isExecutionStillCurrent()) {
          await terminal.close(sessionId);
        }
      } catch {
        terminationFailed = true;
      }
    }

    if (!isExecutionStillCurrent()) {
      return;
    }
    if (terminationFailed) {
      restoreRunning();
      return;
    }
    clearSession();
  }

  if (!isExecutionStillCurrent()) {
    return;
  }
  finalizeExit();
};

export const reconcileTerminalSessionAuthority = (
  terminal: TerminalAPI,
  directory: string,
): Promise<TerminalServerSession[] | null> => {
  if (!terminal.listSessions) {
    return Promise.resolve(null);
  }

  const key = `${directory}\u0000list`;
  const existing = reconcileFlights.get(key);
  if (existing) {
    return existing;
  }

  const flight = terminal.listSessions(directory)
    .then((sessions) => sessions)
    .catch(() => null)
    .finally(() => {
      if (reconcileFlights.get(key) === flight) {
        reconcileFlights.delete(key);
      }
    });
  reconcileFlights.set(key, flight);
  return flight;
};
