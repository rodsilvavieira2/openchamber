// ACP connection over a managed process's stdio.
//
// Wraps the spawned agent's stdin/stdout with the official SDK and exposes the
// minimal client surface the OpenChamber runtime needs: `initialize`,
// `newSession`, `prompt`, `cancel`, and a `sessionUpdate` callback. Protocol
// details (JSON-RPC framing, request ids, timeouts) are the SDK's job; the
// process lifecycle is the process manager's.

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

const DEFAULT_CLIENT_INFO = { name: 'OpenChamber', version: '0.0.0' };

/**
 * @param {object} options
 * @param {{ child: import('node:child_process').ChildProcess }} options.handle
 *   A spawned process handle from `createAgentProcessManager().start`.
 * @param {(params: unknown) => void} [options.onSessionUpdate]
 *   Receives every `session/update` notification from the agent.
 * @param {(params: unknown) => Promise<unknown>} [options.onPermissionRequest]
 *   Answers `session/request_permission`. Defaults to cancelling, which is the
 *   protocol-correct answer when no user surface is available yet.
 */
export const createAcpConnection = ({
  handle,
  clientInfo = DEFAULT_CLIENT_INFO,
  onSessionUpdate = () => {},
  onPermissionRequest,
} = {}) => {
  const { child } = handle ?? {};
  if (!child?.stdin || !child?.stdout) {
    throw new Error('ACP connection requires a spawned process with stdin/stdout pipes.');
  }

  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

  const answerPermission =
    typeof onPermissionRequest === 'function'
      ? onPermissionRequest
      : async () => ({ outcome: { outcome: 'cancelled' } });

  const connection = new ClientSideConnection(
    () => ({
      sessionUpdate: (params) => onSessionUpdate(params),
      requestPermission: (params) => answerPermission(params),
    }),
    stream,
  );

  return {
    initialize: () =>
      connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo }),
    newSession: (params) => connection.newSession({ mcpServers: [], ...params }),
    prompt: (sessionId, prompt) => connection.prompt({ sessionId, prompt }),
    cancel: (sessionId) => connection.cancel({ sessionId }),
    /** Best-effort: older agents may not implement session/close. */
    closeSession: (sessionId) => connection.closeSession?.({ sessionId }),
    /** Aborts when the underlying transport closes. */
    signal: connection.signal,
  };
};
