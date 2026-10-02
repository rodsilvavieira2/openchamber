export function registerManagedProcess(entry: {
  pid?: number;
  ownerPid?: number;
  port?: number | null;
  binary?: string | null;
  command?: string | null;
  runtime?: string;
}): Promise<void>;

export function unregisterManagedProcess(pid?: number): Promise<void>;

export function reapOrphanedProcesses(options?: {
  log?: (message: string) => void;
}): Promise<{ inspected: number; reaped: number }>;

export function createManagedProcessRegistry(options?: {
  fs?: unknown;
  execFileAsync?: (...args: unknown[]) => Promise<{ stdout?: string; stderr?: string }>;
  registryDir?: string;
  identifyCommand?: (command: string, entry: { port?: number | null; command?: string | null }) => boolean;
}): {
  registerManagedProcess: (entry: {
    pid?: number;
    ownerPid?: number;
    port?: number | null;
    binary?: string | null;
    command?: string | null;
    runtime?: string;
  }) => Promise<void>;
  unregisterManagedProcess: (pid?: number) => Promise<void>;
  reapOrphanedProcesses: (options?: {
    log?: (message: string) => void;
  }) => Promise<{ inspected: number; reaped: number }>;
};
