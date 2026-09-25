export function connectSharedOpenCode(options: {
  launch: { binary: string; args: string[] };
  env: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  allowStart?: boolean;
}): Promise<{ url: string; password: string }>;

export function scrubSharedServiceEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
