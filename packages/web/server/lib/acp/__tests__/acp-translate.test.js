import { describe, expect, it } from 'vitest';

import {
  createTurnTranslator,
  sessionExecutionFailed,
  userMessageEnqueued,
} from '../acp-translate.js';

const textChunk = (text) => ({
  sessionId: 'sess-1',
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
});
const thoughtChunk = (text) => ({
  sessionId: 'sess-1',
  update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
});

const isWirePayload = (payload) =>
  typeof payload.id === 'string' &&
  payload.id.length > 0 &&
  typeof payload.type === 'string' &&
  Number.isFinite(payload.created) &&
  payload.data !== undefined &&
  (payload.location === undefined || typeof payload.location.directory === 'string');

describe('acp-translate', () => {
  it('builds a user inbox payload the sync translator recognises', () => {
    const payload = userMessageEnqueued('sess-1', 'msg_user_1', 'hello', '/work');
    expect(payload.type).toBe('session.inbox.enqueued');
    expect(payload.data).toMatchObject({
      sessionID: 'sess-1',
      inboxID: 'msg_user_1',
      item: { type: 'user', payload: { text: 'hello' } },
    });
    expect(payload.location).toEqual({ directory: '/work' });
    expect(isWirePayload(payload)).toBe(true);
  });

  it('streams a text turn and settles it', () => {
    const translator = createTurnTranslator({ sessionID: 'sess-1', directory: '/work' });

    const first = translator.update(textChunk('Hello'));
    const second = translator.update(textChunk(' world'));
    const settled = translator.finish('end_turn');

    expect(first.map((payload) => payload.type)).toEqual([
      'session.step.started',
      'session.text.started',
      'session.text.delta',
    ]);
    expect(second.map((payload) => payload.type)).toEqual(['session.text.delta']);

    const assistantMessageID = first[0].data.assistantMessageID;
    expect(assistantMessageID).toMatch(/^msg_/);
    expect(first[2].data).toMatchObject({ assistantMessageID, ordinal: 0, delta: 'Hello' });
    expect(second[0].data).toMatchObject({ assistantMessageID, ordinal: 0, delta: ' world' });

    const ended = settled.find((payload) => payload.type === 'session.text.ended');
    expect(ended.data.text).toBe('Hello world');
    expect(settled.map((payload) => payload.type)).toEqual([
      'session.text.ended',
      'session.step.ended',
      'session.execution.succeeded',
    ]);
    for (const payload of [...first, ...second, ...settled]) {
      expect(isWirePayload(payload)).toBe(true);
    }
  });

  it('streams reasoning separately from text', () => {
    const translator = createTurnTranslator({ sessionID: 'sess-1', directory: '/work' });
    const reasoning = translator.update(thoughtChunk('thinking'));
    const text = translator.update(textChunk('answer'));
    const settled = translator.finish('end_turn');

    expect(reasoning.map((payload) => payload.type)).toEqual([
      'session.step.started',
      'session.reasoning.started',
      'session.reasoning.delta',
    ]);
    expect(text.map((payload) => payload.type)).toEqual([
      'session.reasoning.ended',
      'session.text.started',
      'session.text.delta',
    ]);
    const reasoningEnded = text.find((payload) => payload.type === 'session.reasoning.ended');
    expect(reasoningEnded.data.text).toBe('thinking');
    expect(settled.map((payload) => payload.type)).toEqual([
      'session.text.ended',
      'session.step.ended',
      'session.execution.succeeded',
    ]);
  });

  it('reports a cancelled turn as interrupted', () => {
    const translator = createTurnTranslator({ sessionID: 'sess-1', directory: '/work' });
    translator.update(textChunk('partial'));
    const settled = translator.finish('cancelled');

    expect(settled.map((payload) => payload.type)).toContain('session.execution.interrupted');
  });

  it('closes a turn that produced no content', () => {
    const translator = createTurnTranslator({ sessionID: 'sess-1', directory: '/work' });
    expect(translator.finish('end_turn').map((payload) => payload.type)).toEqual([
      'session.execution.succeeded',
    ]);
  });

  it('builds an explicit failure payload', () => {
    const payload = sessionExecutionFailed('sess-1', new Error('boom'), '/work');
    expect(payload.type).toBe('session.execution.failed');
    expect(payload.data.error.message).toBe('boom');
  });

  it('maps a tool call lifecycle onto the OpenCode tool events', () => {
    const translator = createTurnTranslator({ sessionID: 'sess-1', directory: '/work' });

    const started = translator.update({
      update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run tests', kind: 'execute', status: 'pending' },
    });
    const running = translator.update({
      update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', rawInput: { command: 'ls' } },
    });
    const done = translator.update({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      },
    });

    expect(started.map((payload) => payload.type)).toEqual(['session.step.started', 'session.tool.input.started']);
    expect(started[1].data.name).toBe('shell');
    expect(running.map((payload) => payload.type)).toEqual(['session.tool.called']);
    expect(running[0].data.input).toEqual({ command: 'ls' });
    expect(done.map((payload) => payload.type)).toEqual(['session.tool.success']);
    expect(done[0].data.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});
