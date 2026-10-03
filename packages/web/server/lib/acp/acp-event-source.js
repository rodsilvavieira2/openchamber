// ACP event source: drives the sessions of ONE agent process and publishes
// their streams as OpenCode v2 wire payloads through the global hub, so the
// existing sync pipeline renders every turn unchanged.
//
// One source owns one agent process and N sessions on it. Lifecycle:
// `start(launch)` spawns and handshakes; `newSession(...)` opens a session;
// `prompt(...)` runs one turn on it; `closeSession(...)` drops it;
// `stop()` tears the process down. Transport/handshake failures publish an
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

/** Replace one config option by id, preserving order; appends when unknown. */
const upsertConfigOption = (options, option) => {
  const list = Array.isArray(options) ? options : [];
  if (!option || typeof option.id !== 'string') return list;
  const index = list.findIndex((entry) => entry?.id === option.id);
  if (index === -1) return [...list, option];
  return list.map((entry, at) => (at === index ? option : entry));
};

/**
 * @param {object} options
 * @param {{ injectEvent: (event: { payload: unknown, directory?: string }) => void }} options.hub
 * @param {string} [options.directory] Default working directory for sessions.
 * @param {string} [options.agentId='default'] Stable id of this agent.
 * @param {string} [options.agentLabel='ACP'] Label for the assistant message footer.
 * @param {ReturnType<typeof createAgentProcessManager>} [options.manager]
 * @param {(error: unknown) => void} [options.onError]
 */
export const createAcpEventSource = ({
  hub,
  directory,
  agentId = 'default',
  agentLabel = 'ACP',
  manager = createAgentProcessManager(),
  onError = () => {},
} = {}) => {
  let handle = null;
  let connection = null;
  /** sessionId -> { translator, directory, modes, configOptions } */
  const sessions = new Map();
  const pendingPermissions = new Map();

  const publish = (payload, sessionDirectory) => {
    hub?.injectEvent?.({ payload, directory: sessionDirectory ?? directory });
  };

  const sessionOf = (sessionId) => sessions.get(sessionId) ?? null;

  const publishUpdate = (params) => {
    const record = sessionOf(params?.sessionId);
    if (!record) return;
    // The agent moved on its own (mode/config changed mid-turn): keep the
    // stored snapshot fresh. The UI refetches on open and after its own sets.
    const update = params?.update;
    if (update?.sessionUpdate === 'current_mode_update' && typeof update.currentModeId === 'string') {
      if (record.modes) record.modes = { ...record.modes, currentModeId: update.currentModeId };
      return;
    }
    if (update?.sessionUpdate === 'config_option_update' && update.configOption) {
      record.configOptions = upsertConfigOption(record.configOptions, update.configOption);
      return;
    }
    if (!record.translator) return;
    for (const payload of record.translator.update(params)) publish(payload, record.directory);
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
          const record = sessionOf(params?.sessionId);
          pendingPermissions.set(requestID, { resolve, params });
          const action = params?.toolCall?.title ?? 'Permission required';
          publish(
            permissionAsked(requestID, params?.sessionId ?? null, action, record?.directory ?? directory, action),
            record?.directory,
          );
        }),
    });
    const initialized = await connection.initialize();
    return { agentId, initialized };
  };

  /** Open a session on the running agent. */
  const newSession = async ({ cwd, directory: sessionDirectory } = {}) => {
    if (!connection) throw new Error('ACP agent is not started.');
    const session = await connection.newSession({ cwd: cwd ?? sessionDirectory ?? directory ?? process.cwd() });
    sessions.set(session.sessionId, {
      translator: null,
      directory: sessionDirectory ?? directory,
      modes: session.modes ?? null,
      configOptions: session.configOptions ?? [],
    });
    return { sessionId: session.sessionId, session };
  };

  /** Run one prompt turn; resolves with the ACP PromptResponse. */
  const prompt = async ({ sessionId, messageId, text, model } = {}) => {
    const record = sessionOf(sessionId);
    if (!connection || !record) throw new Error(`ACP session ${sessionId ?? '(missing)'} is not open.`);
    const id = typeof messageId === 'string' && messageId.length > 0 ? messageId : ascendingId('msg');
    publish(userMessageEnqueued(sessionId, id, text, record.directory), record.directory);
    publish(sessionExecutionStarted(sessionId, record.directory), record.directory);
    record.translator = createTurnTranslator({ sessionID: sessionId, directory: record.directory, agent: agentLabel, model });
    try {
      const result = await connection.prompt(sessionId, [{ type: 'text', text }]);
      for (const payload of record.translator.finish(result?.stopReason)) publish(payload, record.directory);
      return result;
    } catch (error) {
      publish(sessionExecutionFailed(sessionId, error, record.directory), record.directory);
      onError(error);
      throw error;
    } finally {
      record.translator = null;
    }
  };

  const cancel = async (sessionId) => {
    if (connection && sessionId && sessions.has(sessionId)) await connection.cancel(sessionId);
  };

  /** The modes/config snapshot the UI renders its session controls from. */
  const getSessionOptions = (sessionId) => {
    const record = sessionOf(sessionId);
    if (!record) throw new Error(`ACP session ${sessionId ?? '(missing)'} is not open.`);
    return { sessionId, modes: record.modes, configOptions: record.configOptions ?? [] };
  };

  const setSessionMode = async (sessionId, modeId) => {
    const record = sessionOf(sessionId);
    if (!connection || !record) throw new Error(`ACP session ${sessionId ?? '(missing)'} is not open.`);
    await connection.setSessionMode(sessionId, modeId);
    if (record.modes) record.modes = { ...record.modes, currentModeId: modeId };
    return getSessionOptions(sessionId);
  };

  const setSessionConfigOption = async (sessionId, configId, value) => {
    const record = sessionOf(sessionId);
    if (!connection || !record) throw new Error(`ACP session ${sessionId ?? '(missing)'} is not open.`);
    const result = await connection.setSessionConfigOption(sessionId, configId, value);
    if (result && Array.isArray(result.configOptions)) record.configOptions = result.configOptions;
    return getSessionOptions(sessionId);
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
    const record = sessionOf(pending.params?.sessionId);
    publish(permissionReplied(requestID, pending.params?.sessionId ?? null, record?.directory ?? directory), record?.directory);
  };

  /** Drop a session locally; best-effort protocol close. */
  const closeSession = async (sessionId) => {
    sessions.delete(sessionId);
    if (connection && typeof connection.closeSession === 'function') {
      await connection.closeSession(sessionId).catch(() => {});
    }
  };

  const stop = async () => {
    sessions.clear();
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
    agentId,
    start,
    newSession,
    prompt,
    cancel,
    closeSession,
    respondToPermission,
    getSessionOptions,
    setSessionMode,
    setSessionConfigOption,
    stop,
    get sessionIds() {
      return [...sessions.keys()];
    },
    get pid() {
      return handle?.pid ?? null;
    },
  };
};
