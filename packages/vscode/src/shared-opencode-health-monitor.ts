export type SharedOpenCodeEndpoint = { url: string; password: string };

type TimerHandle = number | NodeJS.Timeout;

type SharedOpenCodeHealthMonitorOptions = {
  getEndpoint: () => SharedOpenCodeEndpoint | null;
  checkHealth: (endpoint: SharedOpenCodeEndpoint, signal: AbortSignal) => Promise<boolean>;
  recover: (signal: AbortSignal) => Promise<void>;
  setInterval?: (callback: () => void, delayMs: number) => TimerHandle;
  clearInterval?: (handle: TimerHandle) => void;
};

const HEALTH_INTERVAL_MS = 30_000;

export async function checkSharedOpenCodeHealth(endpoint: SharedOpenCodeEndpoint, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(new URL('/api/info', endpoint.url), {
      headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString('base64')}` },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Polls one extension-local shared-service endpoint without owning its lifecycle. */
export class SharedOpenCodeHealthMonitor {
  private timer: TimerHandle | null = null;
  private inFlight: AbortController | null = null;
  private active = false;
  private readonly setTimer: (callback: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(private readonly options: SharedOpenCodeHealthMonitorOptions) {
    this.setTimer = options.setInterval ?? setInterval;
    this.clearTimer = options.clearInterval ?? clearInterval;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.timer = this.setTimer(() => { void this.tick(); }, HEALTH_INTERVAL_MS);
  }

  stop(): void {
    this.active = false;
    this.inFlight?.abort();
    this.inFlight = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!this.active || this.inFlight) return;
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      const endpoint = this.options.getEndpoint();
      const healthy = endpoint ? await this.options.checkHealth(endpoint, controller.signal) : false;
      if (!healthy && this.active && !controller.signal.aborted) {
        await this.options.recover(controller.signal);
      }
    } catch {
      // Keep the current endpoint and try discovery-only recovery next interval.
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }
}
