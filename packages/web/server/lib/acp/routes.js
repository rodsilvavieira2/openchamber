// ACP HTTP routes.
//
// Many agents may be connected at once (Codex and Claude side by side); each
// chat session is bound to exactly one of them. `sources` holds one event
// source per agent id, `sessions` maps every open ACP session to its agent.
// `initialize` ensures an agent's process, `session/new` opens a session on
// it, and `prompt`/`cancel`/`permission` route by session id.
//
// Every endpoint fails explicitly (non-2xx with a code) rather than reporting
// an empty success, and all are gated by OPENCHAMBER_ACP_ENABLED.

import express from 'express';

import { isAcpEnabled } from './acp-config.js';
import { createAcpEventSource } from './acp-event-source.js';

const DEFAULT_AGENT_ID = 'default';

const json = (res, status, body) => res.status(status).json(body);

/**
 * @param {object} [options]
 * @param {(options: object) => ReturnType<typeof createAcpEventSource>} [options.createSource]
 * @param {() => boolean} [options.enabled]
 */
export const createAcpRouteRuntime = ({ createSource = createAcpEventSource, enabled = isAcpEnabled } = {}) => {
  /** agentId -> { source, label, command } */
  const sources = new Map();
  /** sessionId -> agentId */
  const sessions = new Map();

  const stopSource = async (agentId) => {
    const record = sources.get(agentId);
    if (!record) return;
    sources.delete(agentId);
    for (const [sessionId, owner] of sessions) {
      if (owner === agentId) sessions.delete(sessionId);
    }
    await record.source.stop().catch(() => {});
  };

  const teardown = async () => {
    for (const agentId of [...sources.keys()]) await stopSource(agentId);
  };

  const sourceForSession = (sessionId) => {
    const agentId = sessions.get(sessionId);
    const record = agentId ? sources.get(agentId) : null;
    return record?.source ?? null;
  };

  const registerRoutes = (app, { hub } = {}) => {
    const ensureEnabled = (res) => {
      if (enabled()) return true;
      json(res, 404, { error: 'ACP support is disabled', code: 'ACP_DISABLED' });
      return false;
    };

    // Ensure the agent's process is running (idempotent per agent id).
    app.post('/api/agent/acp/initialize', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      const body = req.body ?? {};
      const agentId =
        typeof body.agentId === 'string' && body.agentId.length > 0 ? body.agentId : DEFAULT_AGENT_ID;
      const command = typeof body.command === 'string' ? body.command.trim() : '';
      if (!command) {
        return json(res, 400, { error: 'Missing required field: command', code: 'AGENT_NOT_FOUND' });
      }

      const existing = sources.get(agentId);
      if (existing && existing.command === command) {
        return json(res, 200, {
          backend: 'acp',
          agentId,
          sessionIds: existing.source.sessionIds,
          capabilities: existing.capabilities ?? {},
        });
      }
      await stopSource(agentId);

      const label =
        (typeof body.name === 'string' && body.name) || (typeof body.agentId === 'string' && body.agentId) || 'ACP';
      const source = createSource({ hub, agentId, agentLabel: label });
      try {
        const started = await source.start({
          command,
          args: Array.isArray(body.args) ? body.args : undefined,
          env: body.env && typeof body.env === 'object' ? body.env : undefined,
          cwd: typeof body.cwd === 'string' ? body.cwd : undefined,
        });
        const record = { source, label, command, capabilities: started.initialized?.agentCapabilities ?? {} };
        sources.set(agentId, record);
        return json(res, 200, { backend: 'acp', agentId, sessionIds: source.sessionIds, capabilities: record.capabilities });
      } catch (error) {
        await source.stop().catch(() => {});
        return json(res, 502, {
          error: error?.message ?? 'ACP initialization failed',
          code: 'AGENT_INITIALIZATION_FAILED',
        });
      }
    });

    // Open a session on an already-connected agent.
    app.post('/api/agent/acp/session/new', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      const body = req.body ?? {};
      const agentId =
        typeof body.agentId === 'string' && body.agentId.length > 0 ? body.agentId : DEFAULT_AGENT_ID;
      const record = sources.get(agentId);
      if (!record) {
        return json(res, 409, { error: `ACP agent "${agentId}" is not connected`, code: 'AGENT_NOT_FOUND' });
      }
      const directory = typeof body.directory === 'string' && body.directory.length > 0 ? body.directory : undefined;
      try {
        const created = await record.source.newSession({
          cwd: typeof body.cwd === 'string' ? body.cwd : directory,
          directory,
        });
        sessions.set(created.sessionId, agentId);
        const options = record.source.getSessionOptions(created.sessionId);
        return json(res, 200, {
          backend: 'acp',
          agentId,
          sessionId: created.sessionId,
          directory: directory ?? null,
          modes: options.modes,
          configOptions: options.configOptions,
        });
      } catch (error) {
        return json(res, 502, { error: error?.message ?? 'ACP session creation failed', code: 'SESSION_CREATE_FAILED' });
      }
    });

    // Read the modes/config snapshot that drives the chat session controls.
    app.post('/api/agent/acp/session/options', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      const body = req.body ?? {};
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const source = sourceForSession(sessionId);
      if (!source) {
        return json(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      }
      try {
        const options = source.getSessionOptions(sessionId);
        return json(res, 200, { sessionId, modes: options.modes ?? null, configOptions: options.configOptions ?? [] });
      } catch (error) {
        return json(res, 502, { error: error?.message ?? 'ACP session lookup failed', code: 'SESSION_NOT_FOUND' });
      }
    });

    // Switch the session mode (ask/code/architect/... as advertised).
    app.post('/api/agent/acp/session/mode', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      const body = req.body ?? {};
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const source = sourceForSession(sessionId);
      if (!source) {
        return json(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      }
      if (typeof body.modeId !== 'string' || body.modeId.length === 0) {
        return json(res, 400, { error: 'Missing required field: modeId', code: 'SESSION_NOT_FOUND' });
      }
      try {
        const options = await source.setSessionMode(sessionId, body.modeId);
        return json(res, 200, { sessionId, modes: options.modes ?? null, configOptions: options.configOptions ?? [] });
      } catch (error) {
        return json(res, 502, { error: error?.message ?? 'ACP mode switch failed', code: 'PROMPT_FAILED' });
      }
    });

    // Set one session config option (model, reasoning effort, ... as advertised).
    app.post('/api/agent/acp/session/config', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      const body = req.body ?? {};
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const source = sourceForSession(sessionId);
      if (!source) {
        return json(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      }
      if (typeof body.configId !== 'string' || body.configId.length === 0) {
        return json(res, 400, { error: 'Missing required field: configId', code: 'PROMPT_FAILED' });
      }
      try {
        const options = await source.setSessionConfigOption(sessionId, body.configId, body.value);
        return json(res, 200, { sessionId, modes: options.modes ?? null, configOptions: options.configOptions ?? [] });
      } catch (error) {
        return json(res, 502, { error: error?.message ?? 'ACP config change failed', code: 'PROMPT_FAILED' });
      }
    });

    // Run one prompt turn. Events stream over the normal event channel.
    app.post('/api/agent/acp/prompt', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      const body = req.body ?? {};
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const source = sourceForSession(sessionId);
      if (!source) {
        return json(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      }
      if (typeof body.text !== 'string') {
        return json(res, 400, { error: 'Missing required field: text', code: 'PROMPT_FAILED' });
      }
      try {
        const result = await source.prompt({ sessionId, messageId: body.messageId, text: body.text });
        return json(res, 200, { sessionId, stopReason: result?.stopReason ?? null });
      } catch (error) {
        return json(res, 502, { error: error?.message ?? 'ACP prompt failed', code: 'PROMPT_FAILED' });
      }
    });

    app.post('/api/agent/acp/cancel', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      const body = req.body ?? {};
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const source = sourceForSession(sessionId);
      if (!source) {
        return json(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      }
      try {
        await source.cancel(sessionId);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 502, { error: error?.message ?? 'ACP cancel failed', code: 'PROMPT_FAILED' });
      }
    });

    // Answer a permission request the agent is blocked on.
    app.post('/api/agent/acp/permission', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      const body = req.body ?? {};
      const requestId = typeof body.requestId === 'string' ? body.requestId : '';
      if (!requestId) {
        return json(res, 400, { error: 'Missing required field: requestId', code: 'PERMISSION_FAILED' });
      }
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const source = sourceForSession(sessionId);
      if (!source) {
        return json(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      }
      const decision = body.decision === 'always' ? 'always' : body.decision === 'reject' ? 'reject' : 'once';
      try {
        await source.respondToPermission(requestId, decision);
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 502, { error: error?.message ?? 'ACP permission reply failed', code: 'PERMISSION_FAILED' });
      }
    });

    // Close one session, or stop a whole agent (all its sessions).
    app.post('/api/agent/acp/shutdown', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      const body = req.body ?? {};
      const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
      const agentId = typeof body.agentId === 'string' ? body.agentId : sessions.get(sessionId);
      if (sessionId && !agentId) {
        return json(res, 200, { ok: true });
      }
      if (sessionId && agentId && sessions.get(sessionId) === agentId) {
        const record = sources.get(agentId);
        if (record) await record.source.closeSession(sessionId).catch(() => {});
        sessions.delete(sessionId);
        return json(res, 200, { ok: true });
      }
      if (agentId) {
        await stopSource(agentId);
        return json(res, 200, { ok: true });
      }
      await teardown();
      return json(res, 200, { ok: true });
    });

    app.get('/api/agent/acp/status', (_req, res) => {
      if (!enabled()) return json(res, 200, { enabled: false, agents: [] });
      return json(res, 200, {
        enabled: true,
        agents: [...sources.entries()].map(([agentId, record]) => ({
          agentId,
          label: record.label,
          connected: true,
          sessionIds: record.source.sessionIds,
        })),
      });
    });
  };

  return {
    registerRoutes,
    teardown,
    get agents() {
      return [...sources.keys()];
    },
  };
};
