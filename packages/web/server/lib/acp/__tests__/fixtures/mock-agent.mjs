// Minimal ACP agent used by tests. It speaks the real protocol over stdio via
// the official SDK, so the test exercises the same framing, request/response
// and notification paths as a real agent without requiring Codex or Claude.
//
// Behavior:
//   initialize  → protocol version 1, no capabilities
//   session/new → a fixed session id
//   session/prompt → streams "Hello from ACP" as agent_message_chunks, ends the turn
//   session/cancel → stops the current turn

import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const REPLY_CHUNKS = ['Hello', ' from', ' ACP'];

class MockAcpAgent {
  constructor(connection) {
    this.connection = connection;
    this.cancelled = false;
  }

  async initialize() {
    return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  }

  async authenticate() {
    return {};
  }

  async newSession() {
    return { sessionId: 'mock-session-1' };
  }

  async prompt(params) {
    this.cancelled = false;
    for (const text of REPLY_CHUNKS) {
      if (this.cancelled) break;
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });
    }
    return { stopReason: this.cancelled ? 'cancelled' : 'end_turn' };
  }

  async cancel() {
    this.cancelled = true;
  }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
new AgentSideConnection((connection) => new MockAcpAgent(connection), stream);
