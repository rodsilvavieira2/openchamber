// ACP agent process manager.
//
// Owns the lifetime of a spawned ACP agent process: spawn, stdio wiring,
// registry/orphan-reap, and teardown. It deliberately does NOT speak the ACP
// protocol itself — `acp-connection.js` wraps the child's stdio with the
// official SDK. stdout is the protocol channel; stderr is diagnostics only and
// is never parsed as protocol.
//
// Spawning is only ever done in a host that has a real child_process: the
// OpenChamber web server (web and Electron-in-process) or the VS Code extension
// host. Never in a browser, webview, or on mobile.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createManagedProcessRegistry } from '../opencode/managed-process-registry.js';

const ACP_REGISTRY_DIR_ENV = 'OPENCHAMBER_ACP_PROCESS_REGISTRY';
const MAX_STDERR_TAIL = 8 * 1024;

const resolveAcpRegistryDir = () => {
  const override = process.env[ACP_REGISTRY_DIR_ENV];
  if (override && override.trim()) return override.trim();
  return path.join(os.homedir(), '.config', 'openchamber', 'managed-acp-agents');
};

// Match a live process to a registry entry without ever killing an unrelated
// process: accept the recorded command's basename, or any distinctive
// (non-flag, >=4 char) token from the recorded spawn line, which covers npx/npm
// wrappers whose visible process is the wrapped binary.
const acpIdentifyCommand = (command, entry) => {
  if (typeof command !== 'string') return false;
  const marker = typeof entry?.command === 'string' ? entry.command : '';
  if (!marker) return false;
  const lower = command.toLowerCase();
  const tokens = marker
    .split(/\s+/)
    .map((token) => path.basename(token).toLowerCase())
    .filter((token) => token.length >= 4 && !token.startsWith('-'));
  return tokens.some((token) => lower.includes(token));
};

/** The registry the ACP process manager records its children in. */
const createAcpRegistry = ({ fs, execFileAsync } = {}) =>
  createManagedProcessRegistry({
    fs,
    execFileAsync,
    registryDir: resolveAcpRegistryDir(),
    identifyCommand: acpIdentifyCommand,
  });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForSpawn = (child) =>
  new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

const signalTree = (child, pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch {
    // Process group may already be gone (or the child was not detached).
  }
  try {
    child.kill(signal);
  } catch {
    // Child may already be gone.
  }
};

/**
 * Build an ACP process manager. All side effects are injectable for tests.
 */
export const createAgentProcessManager = ({
  spawnImpl = spawn,
  registry = createAcpRegistry(),
  platform = process.platform,
  log = () => {},
  ownerPid = process.pid,
} = {}) => {
  const processes = new Map();

  /**
   * Spawn one ACP agent and record it for orphan reaping. Resolves to a handle
   * once the OS reports the process spawned; a missing executable rejects with
   * the spawn error (surfaced as `AGENT_START_FAILED`).
   */
  const start = async (launch = {}) => {
    const { command, args = [], cwd, env } = launch;
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('ACP agent process requires a command.');
    }

    const child = spawnImpl(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: platform !== 'win32',
      windowsHide: true,
    });

    await waitForSpawn(child);

    const handle = {
      pid: child.pid,
      command,
      child,
      stderrTail: '',
      exited: new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    };

    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      handle.stderrTail = (handle.stderrTail + text).slice(-MAX_STDERR_TAIL);
      log(`[agent.acp.process] ${text.trimEnd()}`);
    });
    child.once('exit', (code, signal) => {
      processes.delete(handle.pid);
      log(`[agent.acp.process] exited pid=${handle.pid} code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    });

    processes.set(handle.pid, handle);
    await registry.registerManagedProcess({
      pid: child.pid,
      ownerPid,
      command: [command, ...args].join(' '),
      runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
    });
    return handle;
  };

  /**
   * Terminate a process (its group on POSIX) and drop its registry entry only
   * after the process is confirmed gone. A process that ignores SIGTERM is
   * force-killed after `timeoutMs`.
   */
  const stop = async (handle, { timeoutMs = 2500 } = {}) => {
    if (!handle || !Number.isInteger(handle.pid)) return;
    const { child, pid } = handle;
    if (!hasExited(child)) {
      signalTree(child, pid, 'SIGTERM');
      const settled = await Promise.race([handle.exited.then(() => true), delay(timeoutMs).then(() => false)]);
      if (!settled && !hasExited(child)) {
        signalTree(child, pid, 'SIGKILL');
        await Promise.race([handle.exited, delay(500)]);
      }
    }
    await registry.unregisterManagedProcess(pid);
    processes.delete(pid);
  };

  const stopAll = async () => {
    for (const handle of [...processes.values()]) {
      await stop(handle);
    }
  };

  /** Reap ACP processes WE spawned that were left orphaned by a hard crash. */
  const reapOrphaned = (options) => registry.reapOrphanedProcesses(options);

  return {
    start,
    stop,
    stopAll,
    reapOrphaned,
    get pidCount() {
      return processes.size;
    },
  };
};
