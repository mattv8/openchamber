import { connectSharedOpenCode, scrubSharedServiceEnv } from '../../web/server/lib/opencode/shared-service.js';

type SharedOpenCodeLaunch = { binary: string; args: string[] };

type SharedOpenCodeConnectionOptions = {
  launch: SharedOpenCodeLaunch;
  env: NodeJS.ProcessEnv;
  cwd?: string;
};

/** Extension-local connection state for a CLI-owned OpenCode service. */
export class SharedOpenCodeConnection {
  private url: string | null = null;
  private password: string | null = null;

  constructor(private readonly options: SharedOpenCodeConnectionOptions) {}

  async connect(signal?: AbortSignal, { allowStart = true }: { allowStart?: boolean } = {}): Promise<void> {
    const service = await connectSharedOpenCode({ ...this.options, env: scrubSharedServiceEnv(this.options.env), signal, allowStart });
    this.url = service.url;
    this.password = service.password;
  }

  disconnect(): void {
    this.url = null;
    this.password = null;
  }

  getUrl(): string | null {
    return this.url;
  }

  getPassword(): string | null {
    return this.password;
  }
}
