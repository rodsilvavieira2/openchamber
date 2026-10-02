// Pure translation of ACP `session/update` notifications into OpenCode v2 wire
// payloads.
//
// The browser already translates v2 payloads (`packages/ui/src/lib/opencode/
// events.ts`) and so does the server's own consumer translator
// (`event-stream/translate-v2.js`). Emitting that same vocabulary — rather than
// a private event shape — is what lets the whole sync pipeline render an ACP
// turn without a single change to it. Every payload carries `id`, `type`,
// `created`, `data`, and `location.directory`, which is exactly what the
// browser's `wireEventSchema` requires.
//
// Pure and side-effect-free, so it is unit-testable without a subprocess.

const ID_RANDOM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_RANDOM_LENGTH = 14;

let lastIdTimestamp = 0;
let idCounter = 0;

const randomBase62 = (length) => {
  let result = '';
  for (let index = 0; index < length; index += 1) {
    result += ID_RANDOM_CHARS[Math.floor(Math.random() * ID_RANDOM_CHARS.length)];
  }
  return result;
};

/**
 * Time-sortable id in the same format the UI mints (`lib/opencode/ids.ts`), so
 * a server-generated assistant id sorts after the client's user message id and
 * the turn renders in order.
 */
export const ascendingId = (prefix) => {
  const timestamp = Date.now();
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp;
    idCounter = 0;
  }
  idCounter += 1;
  const sortable = BigInt(timestamp) * BigInt(0x1000) + BigInt(idCounter);
  const timeBytes = new Uint8Array(6);
  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((sortable >> BigInt(40 - 8 * index)) & BigInt(0xff));
  }
  const hex = Array.from(timeBytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}${randomBase62(ID_RANDOM_LENGTH)}`;
};

const wire = (type, data, { directory, id, created } = {}) => {
  const payload = {
    id: typeof id === 'string' && id.length > 0 ? id : ascendingId('evt'),
    type,
    created: Number.isFinite(created) ? created : Date.now(),
    data,
  };
  if (typeof directory === 'string' && directory.length > 0) {
    payload.location = { directory };
  }
  return payload;
};

export const sessionExecutionStarted = (sessionID, directory) =>
  wire('session.execution.started', { sessionID }, { directory });

export const sessionExecutionSucceeded = (sessionID, directory) =>
  wire('session.execution.succeeded', { sessionID }, { directory });

export const sessionExecutionFailed = (sessionID, error, directory) =>
  wire(
    'session.execution.failed',
    {
      sessionID,
      error: {
        type: 'Error',
        message: typeof error === 'string' ? error : error?.message ?? 'ACP agent failed',
      },
    },
    { directory },
  );

export const sessionStepStarted = (sessionID, assistantMessageID, { directory, agent, model } = {}) =>
  wire(
    'session.step.started',
    {
      sessionID,
      assistantMessageID,
      agent,
      model: { providerID: model?.providerID ?? 'acp', id: model?.id ?? 'acp' },
    },
    { directory },
  );

export const sessionStepEnded = (sessionID, assistantMessageID, { directory, finish = 'stop', cost, tokens } = {}) =>
  wire('session.step.ended', { sessionID, assistantMessageID, finish, cost, tokens }, { directory });

export const textStarted = (sessionID, assistantMessageID, ordinal, directory) =>
  wire('session.text.started', { sessionID, assistantMessageID, ordinal }, { directory });

export const textDelta = (sessionID, assistantMessageID, ordinal, delta, directory) =>
  wire('session.text.delta', { sessionID, assistantMessageID, ordinal, delta }, { directory });

export const textEnded = (sessionID, assistantMessageID, ordinal, text, directory) =>
  wire('session.text.ended', { sessionID, assistantMessageID, ordinal, text }, { directory });

export const reasoningStarted = (sessionID, assistantMessageID, ordinal, directory) =>
  wire('session.reasoning.started', { sessionID, assistantMessageID, ordinal }, { directory });

export const reasoningDelta = (sessionID, assistantMessageID, ordinal, delta, directory) =>
  wire('session.reasoning.delta', { sessionID, assistantMessageID, ordinal, delta }, { directory });

export const reasoningEnded = (sessionID, assistantMessageID, ordinal, text, directory) =>
  wire('session.reasoning.ended', { sessionID, assistantMessageID, ordinal, text }, { directory });

/**
 * The authoritative user message. Emitted so the optimistic bubble the UI
 * inserted reconciles in place (same id) and survives a reload.
 */
export const userMessageEnqueued = (sessionID, messageID, text, directory, metadata) =>
  wire(
    'session.inbox.enqueued',
    { sessionID, inboxID: messageID, item: { type: 'user', payload: { text, metadata } } },
    { directory },
  );

const textFromChunk = (update) => {
  const content = update?.content;
  if (!content || content.type !== 'text' || typeof content.text !== 'string') return '';
  return content.text;
};

/**
 * One translator per prompt turn. Streams the assistant message and reasoning,
 * and settles the turn on the ACP `stopReason`.
 */
export const createTurnTranslator = ({ sessionID, directory, agent, model } = {}) => {
  let assistantMessageID = null;
  let textOrdinal = 0;
  let textPartOpen = false;
  let reasoningOrdinal = 0;
  let reasoningPartOpen = false;
  const textChunks = [];
  const reasoningChunks = [];

  const ensureAssistant = (events) => {
    if (assistantMessageID) return;
    assistantMessageID = ascendingId('msg');
    events.push(sessionStepStarted(sessionID, assistantMessageID, { directory, agent, model }));
  };

  const closeReasoning = (events) => {
    if (!reasoningPartOpen) return;
    events.push(
      reasoningEnded(sessionID, assistantMessageID, reasoningOrdinal, reasoningChunks.join(''), directory),
    );
    reasoningPartOpen = false;
    reasoningOrdinal += 1;
  };

  const closeText = (events) => {
    if (!textPartOpen) return;
    events.push(textEnded(sessionID, assistantMessageID, textOrdinal, textChunks.join(''), directory));
    textPartOpen = false;
    textOrdinal += 1;
  };

  return {
    /** Translate one ACP `session/update` params object. */
    update(params) {
      const events = [];
      const update = params?.update;
      if (!update || typeof update !== 'object') return events;

      if (update.sessionUpdate === 'agent_message_chunk') {
        const chunk = textFromChunk(update);
        if (chunk.length === 0) return events;
        ensureAssistant(events);
        closeReasoning(events);
        if (!textPartOpen) {
          textPartOpen = true;
          events.push(textStarted(sessionID, assistantMessageID, textOrdinal, directory));
        }
        textChunks.push(chunk);
        events.push(textDelta(sessionID, assistantMessageID, textOrdinal, chunk, directory));
      } else if (update.sessionUpdate === 'agent_thought_chunk') {
        const chunk = textFromChunk(update);
        if (chunk.length === 0) return events;
        ensureAssistant(events);
        if (!reasoningPartOpen) {
          reasoningPartOpen = true;
          events.push(reasoningStarted(sessionID, assistantMessageID, reasoningOrdinal, directory));
        }
        reasoningChunks.push(chunk);
        events.push(reasoningDelta(sessionID, assistantMessageID, reasoningOrdinal, chunk, directory));
      }
      return events;
    },

    /** Settle the turn. `stopReason` is the ACP PromptResponse stop reason. */
    finish(stopReason) {
      const events = [];
      if (!assistantMessageID) {
        // No content at all: still close the turn so the UI leaves "busy".
        events.push(sessionExecutionSucceeded(sessionID, directory));
        return events;
      }
      closeReasoning(events);
      closeText(events);
      events.push(sessionStepEnded(sessionID, assistantMessageID, { directory, finish: 'stop' }));
      events.push(
        stopReason === 'cancelled'
          ? wire('session.execution.interrupted', { sessionID, reason: 'user' }, { directory })
          : sessionExecutionSucceeded(sessionID, directory),
      );
      return events;
    },
  };
};
