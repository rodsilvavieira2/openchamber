// ACP event source: drives one ACP session over a managed connection and
// publishes its stream as OpenCode v2 wire payloads through the global hub, so
// the existing sync pipeline renders the turn unchanged.
//
// Lifecycle: `start(launch)` spawns and handshakes; `prompt(...)` runs one turn;
// `stop()` tears the process down. A transport or handshake failure publishes an
// explicit `session.execution.failed` (never an empty success).

import { createAcpConnection } from './acp-connection.js';
import { createAgentProcessManager } from './agent-process-manager.js';
import {
  ascendingId,
  createTurnTranslator,
  permissionAsked,
  permissionReplied,
  sessionExecutionFailed,
  sessionExecutionStarted,
  userMessageEnqueued,
} from './acp-translate.js';

const OPTION_KIND_BY_DECISION = {
  once: ['allow_once', 'allow_always'],
  always: ['allow_always', 'allow_once'],
  reject: ['reject_once', 'reject_always'],
};

const chooseOptionId = (options, decision) => {
  if (!Array.isArray(options) || options.length === 0) return null;
  const preferred = OPTION_KIND_BY_DECISION[decision] ?? OPTION_KIND_BY_DECISION.reject;
  for (const kind of preferred) {
    const match = options.find((option) => option?.kind === kind);
    if (match) return match.optionId;
  }
  return options[0]?.optionId ?? null;
};

/**
 * @param {object} options
 * @param {{ injectEvent: (event: { payload: unknown, directory?: string }) => void }} options.hub
 * @param {string} [options.directory] Session working directory.
 * @param {string} [options.agentLabel='ACP'] Label for the assistant message footer.
 * @param {ReturnType<typeof createAgentProcessManager>} [options.manager]
 * @param {(error: unknown) => void} [options.onError]
 */
export const createAcpEventSource = ({
  hub,
  directory,
  agentLabel = 'ACP',
  manager = createAgentProcessManager(),
  onError = () => {},
} = {}) => {
  let handle = null;
  let connection = null;
  let sessionId = null;
  let translator = null;
  const pendingPermissions = new Map();

  const publish = (payload) => {
    hub?.injectEvent?.({ payload, directory });
  };

  const publishUpdate = (params) => {
    if (!translator) return;
    for (const payload of translator.update(params)) publish(payload);
  };

  const start = async (launch = {}) => {
    if (handle) throw new Error('ACP event source is already started.');
    handle = await manager.start(launch);
    connection = createAcpConnection({
      handle,
      onSessionUpdate: publishUpdate,
      onPermissionRequest: (params) =>
        new Promise((resolve) => {
          const requestID = params?.toolCall?.toolCallId ?? ascendingId('perm');
          pendingPermissions.set(requestID, { resolve, params });
          const action = params?.toolCall?.title ?? 'Permission required';
          publish(permissionAsked(requestID, params?.sessionId ?? sessionId, action, directory, action));
        }),
    });
    const initialized = await connection.initialize();
    const session = await connection.newSession({ cwd: launch.cwd ?? directory ?? process.cwd() });
    sessionId = session.sessionId;
    return { sessionId, initialized, session };
  };

  /** Answer a held `session/request_permission` and clear its UI card. */
  const respondToPermission = async (requestID, decision) => {
    const pending = pendingPermissions.get(requestID);
    if (!pending) throw new Error(`Permission request ${requestID} is not pending.`);
    pendingPermissions.delete(requestID);
    const optionId = chooseOptionId(pending.params?.options, decision);
    pending.resolve(
      optionId
        ? { outcome: { outcome: 'selected', optionId } }
        : { outcome: { outcome: 'cancelled' } },
    );
    publish(permissionReplied(requestID, pending.params?.sessionId ?? sessionId, directory));
  };

  /** Run one prompt turn; resolves with the ACP PromptResponse. */
  const prompt = async ({ messageId, text, model } = {}) => {
    if (!connection || !sessionId) throw new Error('ACP session is not started.');
    const id = typeof messageId === 'string' && messageId.length > 0 ? messageId : ascendingId('msg');
    publish(userMessageEnqueued(sessionId, id, text, directory));
    publish(sessionExecutionStarted(sessionId, directory));
    translator = createTurnTranslator({ sessionID: sessionId, directory, agent: agentLabel, model });
    try {
      const result = await connection.prompt(sessionId, [{ type: 'text', text }]);
      for (const payload of translator.finish(result?.stopReason)) publish(payload);
      return result;
    } catch (error) {
      publish(sessionExecutionFailed(sessionId, error, directory));
      onError(error);
      throw error;
    } finally {
      translator = null;
    }
  };

  const cancel = async () => {
    if (connection && sessionId) await connection.cancel(sessionId);
  };

  const stop = async () => {
    translator = null;
    sessionId = null;
    connection = null;
    for (const pending of pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    pendingPermissions.clear();
    if (handle) {
      await manager.stop(handle);
      handle = null;
    }
  };

  return {
    start,
    prompt,
    cancel,
    respondToPermission,
    stop,
    get sessionId() {
      return sessionId;
    },
    get pid() {
      return handle?.pid ?? null;
    },
  };
};
