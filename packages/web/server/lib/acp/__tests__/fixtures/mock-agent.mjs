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
    this.sessionCount = 0;
    this.modeId = 'code';
    this.modelId = 'mock-model-a';
  }

  async initialize() {
    return { protocolVersion: 1, agentCapabilities: {}, authMethods: [] };
  }

  async authenticate() {
    return {};
  }

  async newSession() {
    this.sessionCount += 1;
    return {
      sessionId: `mock-session-${this.sessionCount}`,
      modes: {
        currentModeId: this.modeId,
        availableModes: [
          { id: 'code', name: 'Code' },
          { id: 'ask', name: 'Ask' },
        ],
      },
      configOptions: this.configOptions(),
    };
  }

  configOptions() {
    return [
      {
        id: 'model',
        type: 'select',
        name: 'Model',
        currentValue: this.modelId,
        options: [
          { value: 'mock-model-a', name: 'Mock Model A' },
          { value: 'mock-model-b', name: 'Mock Model B' },
        ],
      },
    ];
  }

  async setSessionMode(params) {
    this.modeId = params.modeId;
    return {};
  }

  async setSessionConfigOption(params) {
    if (params.configId === 'model' && typeof params.value === 'string') {
      this.modelId = params.value;
    }
    return { configOptions: this.configOptions() };
  }

  async prompt(params) {
    this.cancelled = false;
    const text = Array.isArray(params.prompt) ? params.prompt.map((block) => block?.text ?? '').join('') : '';
    if (text.includes('ask')) {
      const permission = await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'mock-tool-1', title: 'Run the mock tool' },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      });
      if (permission?.outcome?.outcome !== 'selected' || permission.outcome.optionId === 'reject-once') {
        return { stopReason: 'cancelled' };
      }
    }
    for (const chunk of REPLY_CHUNKS) {
      if (this.cancelled) break;
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } },
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
