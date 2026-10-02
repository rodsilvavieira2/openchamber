import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { createAgentProcessManager } from '../agent-process-manager.js';

const UNLIKELY_PID = 2_147_483_000;

const makeFakeChild = () => {
  const child = new EventEmitter();
  child.pid = UNLIKELY_PID;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    queueMicrotask(() => child.emit('exit', 0, 'SIGTERM'));
    return true;
  });
  queueMicrotask(() => child.emit('spawn'));
  return child;
};

const makeRegistry = () => ({
  registerManagedProcess: vi.fn(async () => {}),
  unregisterManagedProcess: vi.fn(async () => {}),
  reapOrphanedProcesses: vi.fn(async () => ({ inspected: 0, reaped: 0 })),
});

describe('createAgentProcessManager', () => {
  it('spawns with the ACP-safe options and records the process', async () => {
    const child = makeFakeChild();
    const spawnImpl = vi.fn(() => child);
    const registry = makeRegistry();
    const manager = createAgentProcessManager({ spawnImpl, registry, platform: 'linux' });

    const handle = await manager.start({ command: 'mock-acp', args: ['--stdio'], cwd: '/tmp/work' });

    expect(spawnImpl).toHaveBeenCalledWith(
      'mock-acp',
      ['--stdio'],
      expect.objectContaining({ cwd: '/tmp/work', detached: true, windowsHide: true }),
    );
    expect(handle.pid).toBe(UNLIKELY_PID);
    expect(manager.pidCount).toBe(1);
    expect(registry.registerManagedProcess).toHaveBeenCalledWith(
      expect.objectContaining({ pid: UNLIKELY_PID, command: 'mock-acp --stdio' }),
    );
  });

  it('rejects when the executable cannot be spawned', async () => {
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    const error = Object.assign(new Error('spawn mock ENOENT'), { code: 'ENOENT' });
    queueMicrotask(() => child.emit('error', error));
    const manager = createAgentProcessManager({
      spawnImpl: () => child,
      registry: makeRegistry(),
      platform: 'linux',
    });

    await expect(manager.start({ command: 'mock' })).rejects.toThrow('ENOENT');
  });

  it('treats stderr as diagnostics only', async () => {
    const child = makeFakeChild();
    const log = vi.fn();
    const manager = createAgentProcessManager({
      spawnImpl: () => child,
      registry: makeRegistry(),
      platform: 'linux',
      log,
    });

    const handle = await manager.start({ command: 'mock-acp' });
    child.stderr.emit('data', Buffer.from('starting up\n'));

    expect(log).toHaveBeenCalledWith('[agent.acp.process] starting up');
    expect(handle.stderrTail).toContain('starting up');
  });

  it('terminates the process and drops the registry entry', async () => {
    const child = makeFakeChild();
    const registry = makeRegistry();
    const manager = createAgentProcessManager({
      spawnImpl: () => child,
      registry,
      platform: 'linux',
    });

    const handle = await manager.start({ command: 'mock-acp' });
    await manager.stop(handle);

    expect(child.kill).toHaveBeenCalled();
    expect(registry.unregisterManagedProcess).toHaveBeenCalledWith(UNLIKELY_PID);
    expect(manager.pidCount).toBe(0);
  });

  it('delegates orphan reaping to the registry', async () => {
    const registry = makeRegistry();
    const manager = createAgentProcessManager({ registry, platform: 'linux' });

    await manager.reapOrphaned({ log: () => {} });

    expect(registry.reapOrphanedProcesses).toHaveBeenCalledTimes(1);
  });
});
