import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createAcpEventSource } from '../acp-event-source.js';
import { createAgentProcessManager } from '../agent-process-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'mock-agent.mjs');

const noopRegistry = {
  registerManagedProcess: async () => {},
  unregisterManagedProcess: async () => {},
  reapOrphanedProcesses: async () => ({ inspected: 0, reaped: 0 }),
};

const collectHub = () => {
  const payloads = [];
  return {
    payloads,
    injectEvent: ({ payload }) => payloads.push(payload),
  };
};

const waitFor = async (predicate, timeoutMs = 5000) => {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('ACP event source', () => {
  const manager = createAgentProcessManager({ registry: noopRegistry });
  const sources = [];

  afterEach(async () => {
    for (const source of sources) await source.stop();
    sources.length = 0;
  });

  const startSource = async (hub, directory = '/work') => {
    const source = createAcpEventSource({ hub, directory, agentId: 'mock' });
    sources.push(source);
    await source.start({ command: process.execPath, args: [FIXTURE] });
    return source;
  };

  it('publishes a full turn as wire payloads the sync layer understands', async () => {
    const hub = collectHub();
    const source = await startSource(hub);
    const { sessionId } = await source.newSession({ directory: '/work' });

    await source.prompt({ sessionId, messageId: 'msg_user_1', text: 'hello' });

    const types = hub.payloads.map((payload) => payload.type);
    expect(types).toEqual([
      'session.inbox.enqueued',
      'session.execution.started',
      'session.step.started',
      'session.text.started',
      'session.text.delta',
      'session.text.delta',
      'session.text.delta',
      'session.text.ended',
      'session.step.ended',
      'session.execution.succeeded',
    ]);

    const streamed = hub.payloads
      .filter((payload) => payload.type === 'session.text.delta')
      .map((payload) => payload.data.delta)
      .join('');
    expect(streamed).toBe('Hello from ACP');

    const user = hub.payloads[0];
    expect(user.data).toMatchObject({ inboxID: 'msg_user_1', item: { payload: { text: 'hello' } } });
    expect(user.location).toEqual({ directory: '/work' });
  }, 20_000);

  it('holds a permission request until it is answered', async () => {
    const hub = collectHub();
    const source = await startSource(hub);
    const { sessionId } = await source.newSession({ directory: '/work' });

    const promptPromise = source.prompt({ sessionId, messageId: 'msg_user_1', text: 'please ask' });
    await waitFor(() => hub.payloads.some((payload) => payload.type === 'permission.asked'));

    const asked = hub.payloads.find((payload) => payload.type === 'permission.asked');
    expect(asked.data.action).toBe('Run the mock tool');
    await source.respondToPermission(asked.data.id, 'once');

    const result = await promptPromise;
    expect(result.stopReason).toBe('end_turn');
    expect(hub.payloads.some((payload) => payload.type === 'permission.replied')).toBe(true);
  }, 20_000);

  it('keeps two sessions independent on one agent', async () => {
    const hub = collectHub();
    const source = await startSource(hub);
    const first = await source.newSession({ directory: '/work' });
    const second = await source.newSession({ directory: '/work' });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(source.sessionIds).toEqual(expect.arrayContaining([first.sessionId, second.sessionId]));

    await source.prompt({ sessionId: first.sessionId, messageId: 'msg_a', text: 'hello' });
    const forFirst = hub.payloads.filter((payload) => payload.data.sessionID === first.sessionId);
    const forSecond = hub.payloads.filter((payload) => payload.data.sessionID === second.sessionId);
    expect(forFirst.length).toBeGreaterThan(0);
    expect(forSecond).toEqual([]);

    await source.closeSession(first.sessionId);
    expect(source.sessionIds).toEqual([second.sessionId]);
  }, 20_000);

  it('tracks modes and config options per session', async () => {
    const hub = collectHub();
    const source = await startSource(hub);
    const { sessionId } = await source.newSession({ directory: '/work' });

    const initial = source.getSessionOptions(sessionId);
    expect(initial.modes.currentModeId).toBe('code');
    expect(initial.modes.availableModes.map((mode) => mode.id)).toEqual(['code', 'ask']);
    expect(initial.configOptions.map((option) => option.id)).toEqual(['model']);

    const afterMode = await source.setSessionMode(sessionId, 'ask');
    expect(afterMode.modes.currentModeId).toBe('ask');

    const afterConfig = await source.setSessionConfigOption(sessionId, 'model', 'mock-model-b');
    const model = afterConfig.configOptions.find((option) => option.id === 'model');
    expect(model.currentValue).toBe('mock-model-b');

    expect(() => source.getSessionOptions('missing')).toThrow(/not open/);
  }, 20_000);
});
