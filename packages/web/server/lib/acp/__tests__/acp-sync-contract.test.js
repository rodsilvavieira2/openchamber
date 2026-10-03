import { describe, expect, it } from 'vitest';

import { translateWireEvent } from '@openchamber/ui/lib/opencode/events';
import {
  createTurnTranslator,
  sessionExecutionStarted,
  userMessageEnqueued,
} from '../acp-translate.js';

// Locks the M3 seam: every v2 payload the ACP translator emits must survive
// the UNMODIFIED UI translator (`packages/ui/src/lib/opencode/events.ts`) and
// come out as the SyncEvents the reducer, stores, and renderers consume. If
// either side drifts, this fails before anything reaches a browser.
describe('ACP sync contract (server translator -> UI translator)', () => {
  it('renders a full text turn through the existing sync vocabulary', () => {
    const directory = '/work';
    const wire = [
      userMessageEnqueued('sess-1', 'msg_user_1', 'hello', directory),
      sessionExecutionStarted('sess-1', directory),
    ];
    const turn = createTurnTranslator({ sessionID: 'sess-1', directory });
    wire.push(
      ...turn.update({
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } },
      }),
      ...turn.update({
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } },
      }),
      ...turn.finish('end_turn'),
    );

    const translated = wire.map((payload) => translateWireEvent(payload).map((event) => event.type));

    expect(translated[0]).toEqual(['message.updated', 'message.parts.replaced']);
    expect(translated[1]).toEqual(['session.status']);
    expect(translated[2]).toEqual(['message.updated']);
    expect(translated[3]).toEqual(['message.part.updated']);
    expect(translated[4]).toEqual(['message.part.delta']);
    expect(translated[5]).toEqual(['message.part.delta']);
    expect(translated[6]).toEqual(['message.part.updated']);
    expect(translated[7]).toEqual(['message.patched']);
    expect(translated[8]).toEqual(['session.patched', 'session.idle']);

    const userMessage = translateWireEvent(wire[0])[0];
    expect(userMessage.properties.info.id).toBe('msg_user_1');
    const delta = translateWireEvent(wire[4])[0];
    expect(delta.properties.delta).toBe('Hello');
  });

  it('maps a tool call and a permission request onto existing events', () => {
    const turn = createTurnTranslator({ sessionID: 'sess-1', directory: '/work' });
    const wire = [
      ...turn.update({
        update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Run', kind: 'execute', status: 'pending' },
      }),
      ...turn.update({
        update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
      }),
      ...turn.update({
        update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [] },
      }),
    ];

    const types = wire.flatMap((payload) => translateWireEvent(payload).map((event) => event.type));
    expect(types).toEqual([
      'message.updated',
      'message.part.updated',
      'message.tool.transition',
      'message.tool.transition',
    ]);
  });
});
