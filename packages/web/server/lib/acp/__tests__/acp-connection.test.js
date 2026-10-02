import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { createAcpConnection } from '../acp-connection.js';
import { createAgentProcessManager } from '../agent-process-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, 'fixtures', 'mock-agent.mjs');

// No-op registry: this test exercises the process + protocol path, not the
// on-disk registry, and must not write to the user's real config directory.
const noopRegistry = {
  registerManagedProcess: async () => {},
  unregisterManagedProcess: async () => {},
  reapOrphanedProcesses: async () => ({ inspected: 0, reaped: 0 }),
};

describe('ACP stdio vertical slice (fake agent)', () => {
  const manager = createAgentProcessManager({ registry: noopRegistry });
  const started = [];

  afterEach(async () => {
    for (const handle of started) await manager.stop(handle);
    started.length = 0;
  });

  it('initializes, creates a session, and streams a prompt turn', async () => {
    const handle = await manager.start({ command: process.execPath, args: [FIXTURE] });
    started.push(handle);

    const chunks = [];
    const connection = createAcpConnection({
      handle,
      onSessionUpdate: (params) => {
        const update = params?.update;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
          chunks.push(update.content.text);
        }
      },
    });

    const init = await connection.initialize();
    expect(init.protocolVersion).toBe(1);

    const session = await connection.newSession({ cwd: os.tmpdir() });
    expect(session.sessionId).toBe('mock-session-1');

    const result = await connection.prompt(session.sessionId, [{ type: 'text', text: 'hello' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(chunks.join('')).toBe('Hello from ACP');
  }, 20_000);
});
