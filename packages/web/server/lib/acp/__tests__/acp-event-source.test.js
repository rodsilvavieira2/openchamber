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

describe('ACP event source', () => {
  const manager = createAgentProcessManager({ registry: noopRegistry });
  const sources = [];

  afterEach(async () => {
    for (const source of sources) await source.stop();
    sources.length = 0;
  });

  it('publishes a full turn as wire payloads the sync layer understands', async () => {
    const hub = collectHub();
    const source = createAcpEventSource({ hub, directory: '/work' });
    sources.push(source);

    const started = await source.start({ command: process.execPath, args: [FIXTURE] });
    expect(started.sessionId).toBe('mock-session-1');

    await source.prompt({ messageId: 'msg_user_1', text: 'hello' });

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
});
