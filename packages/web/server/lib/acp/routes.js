// ACP HTTP routes.
//
// One ACP agent connection is active at a time (a session is bound to one
// backend). `initialize` starts the agent and creates a session, replacing any
// previous one; `prompt` runs a turn; `cancel` aborts it; `shutdown` tears the
// process down. Every endpoint fails explicitly (non-2xx with a code) rather
// than reporting an empty success, and all are gated by OPENCHAMBER_ACP_ENABLED.

import express from 'express';

import { isAcpEnabled } from './acp-config.js';
import { createAcpEventSource } from './acp-event-source.js';

const json = (res, status, body) => res.status(status).json(body);

/**
 * @param {object} [options]
 * @param {(options: object) => ReturnType<typeof createAcpEventSource>} [options.createSource]
 * @param {() => boolean} [options.enabled]
 */
export const createAcpRouteRuntime = ({ createSource = createAcpEventSource, enabled = isAcpEnabled } = {}) => {
  let active = null; // { source, sessionId, directory }

  const teardown = async () => {
    if (!active) return;
    const { source } = active;
    active = null;
    await source.stop().catch(() => {});
  };

  const registerRoutes = (app, { hub } = {}) => {
    const ensureEnabled = (res) => {
      if (enabled()) return true;
      json(res, 404, { error: 'ACP support is disabled', code: 'ACP_DISABLED' });
      return false;
    };

    // Start the agent and create its initial session.
    app.post('/api/agent/acp/initialize', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      const body = req.body ?? {};
      const command = typeof body.command === 'string' ? body.command.trim() : '';
      if (!command) {
        return json(res, 400, { error: 'Missing required field: command', code: 'AGENT_NOT_FOUND' });
      }

      await teardown();
      const directory = typeof body.directory === 'string' && body.directory.length > 0 ? body.directory : undefined;
      const source = createSource({
        hub,
        directory,
        agentLabel: (typeof body.name === 'string' && body.name) || (typeof body.agentId === 'string' && body.agentId) || 'ACP',
      });

      try {
        const started = await source.start({
          command,
          args: Array.isArray(body.args) ? body.args : undefined,
          env: body.env && typeof body.env === 'object' ? body.env : undefined,
          cwd: typeof body.cwd === 'string' ? body.cwd : directory,
        });
        active = { source, sessionId: started.sessionId, directory };
        return json(res, 200, {
          backend: 'acp',
          sessionId: started.sessionId,
          directory: directory ?? null,
          capabilities: started.initialized?.agentCapabilities ?? {},
        });
      } catch (error) {
        await source.stop().catch(() => {});
        return json(res, 502, {
          error: error?.message ?? 'ACP initialization failed',
          code: 'AGENT_INITIALIZATION_FAILED',
        });
      }
    });

    // Run one prompt turn. Events stream over the normal event channel.
    app.post('/api/agent/acp/prompt', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      if (!active) {
        return json(res, 409, { error: 'ACP agent is not initialized', code: 'AGENT_NOT_FOUND' });
      }
      const body = req.body ?? {};
      if (typeof body.sessionId === 'string' && body.sessionId !== active.sessionId) {
        return json(res, 404, { error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      }
      if (typeof body.text !== 'string') {
        return json(res, 400, { error: 'Missing required field: text', code: 'PROMPT_FAILED' });
      }
      try {
        const result = await active.source.prompt({ messageId: body.messageId, text: body.text });
        return json(res, 200, { sessionId: active.sessionId, stopReason: result?.stopReason ?? null });
      } catch (error) {
        return json(res, 502, { error: error?.message ?? 'ACP prompt failed', code: 'PROMPT_FAILED' });
      }
    });

    app.post('/api/agent/acp/cancel', express.json({ limit: '1mb' }), async (req, res) => {
      if (!ensureEnabled(res)) return;
      if (!active) {
        return json(res, 409, { error: 'ACP agent is not initialized', code: 'AGENT_NOT_FOUND' });
      }
      try {
        await active.source.cancel();
        return json(res, 200, { ok: true });
      } catch (error) {
        return json(res, 502, { error: error?.message ?? 'ACP cancel failed', code: 'PROMPT_FAILED' });
      }
    });

    app.post('/api/agent/acp/shutdown', async (_req, res) => {
      if (!ensureEnabled(res)) return;
      await teardown();
      return json(res, 200, { ok: true });
    });

    app.get('/api/agent/acp/status', (_req, res) => {
      if (!enabled()) return json(res, 200, { enabled: false, active: false, sessionId: null });
      return json(res, 200, { enabled: true, active: active !== null, sessionId: active?.sessionId ?? null });
    });
  };

  return {
    registerRoutes,
    teardown,
    get sessionId() {
      return active?.sessionId ?? null;
    },
  };
};
