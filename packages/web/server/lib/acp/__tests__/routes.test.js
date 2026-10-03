import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createAcpRouteRuntime } from '../routes.js';

const makeSource = (overrides = {}) => ({
  start: vi.fn(async () => ({ agentId: 'codex', initialized: { agentCapabilities: { loadSession: true } } })),
  newSession: vi.fn(async () => ({ sessionId: 'sess-1' })),
  prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
  cancel: vi.fn(async () => {}),
  closeSession: vi.fn(async () => {}),
  respondToPermission: vi.fn(async () => {}),
  getSessionOptions: vi.fn(() => ({ sessionId: 'sess-1', modes: null, configOptions: [] })),
  setSessionMode: vi.fn(async (sessionId) => ({ sessionId, modes: null, configOptions: [] })),
  setSessionConfigOption: vi.fn(async (sessionId) => ({ sessionId, modes: null, configOptions: [] })),
  stop: vi.fn(async () => {}),
  sessionIds: [],
  ...overrides,
});

const buildApp = (runtime) => {
  const app = express();
  runtime.registerRoutes(app, { hub: { injectEvent: () => {} } });
  return app;
};

const initialize = (app, body = { agentId: 'codex', command: 'agent' }) =>
  request(app).post('/api/agent/acp/initialize').send(body);

describe('ACP routes', () => {
  it('returns 404 for every route when the feature flag is off', async () => {
    const runtime = createAcpRouteRuntime({ enabled: () => false, createSource: makeSource });
    const app = buildApp(runtime);

    const res = await request(app).post('/api/agent/acp/initialize').send({ command: 'agent' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ACP_DISABLED');
  });

  it('rejects initialize without a command', async () => {
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: makeSource });
    const res = await request(buildApp(runtime)).post('/api/agent/acp/initialize').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AGENT_NOT_FOUND');
  });

  it('connects an agent, opens sessions on it, and routes turns by session', async () => {
    const source = makeSource();
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: () => source });
    const app = buildApp(runtime);

    const init = await initialize(app);
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({ backend: 'acp', agentId: 'codex' });
    expect(source.start).toHaveBeenCalledWith(expect.objectContaining({ command: 'agent' }));

    const created = await request(app)
      .post('/api/agent/acp/session/new')
      .send({ agentId: 'codex', directory: '/work' });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ backend: 'acp', agentId: 'codex', sessionId: 'sess-1' });
    expect(source.newSession).toHaveBeenCalledWith(expect.objectContaining({ directory: '/work' }));

    const prompt = await request(app)
      .post('/api/agent/acp/prompt')
      .send({ sessionId: 'sess-1', messageId: 'msg_user_1', text: 'hello' });
    expect(prompt.status).toBe(200);
    expect(prompt.body.stopReason).toBe('end_turn');
    expect(source.prompt).toHaveBeenCalledWith({ sessionId: 'sess-1', messageId: 'msg_user_1', text: 'hello' });

    const cancel = await request(app).post('/api/agent/acp/cancel').send({ sessionId: 'sess-1' });
    expect(cancel.status).toBe(200);
    expect(source.cancel).toHaveBeenCalledWith('sess-1');
  });

  it('keeps two agents connected at once', async () => {
    const codex = makeSource();
    const claude = makeSource();
    const byCommand = { current: codex };
    const runtime = createAcpRouteRuntime({
      enabled: () => true,
      createSource: () => byCommand.current,
    });
    const app = buildApp(runtime);

    byCommand.current = codex;
    await initialize(app, { agentId: 'codex', command: 'codex-acp' });
    byCommand.current = claude;
    await initialize(app, { agentId: 'claude', command: 'claude-acp' });

    const status = await request(app).get('/api/agent/acp/status');
    expect(status.body.agents.map((agent) => agent.agentId).sort()).toEqual(['claude', 'codex']);
    expect(runtime.agents.sort()).toEqual(['claude', 'codex']);
  });

  it('rejects a prompt for an unknown session', async () => {
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: makeSource });
    const res = await request(buildApp(runtime)).post('/api/agent/acp/prompt').send({ sessionId: 'nope', text: 'hi' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
  });

  it('requires a connected agent before opening a session', async () => {
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: makeSource });
    const res = await request(buildApp(runtime)).post('/api/agent/acp/session/new').send({ agentId: 'ghost' });
    expect(res.status).toBe(409);
  });

  it('answers a permission request on the owning agent', async () => {
    const source = makeSource();
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: () => source });
    const app = buildApp(runtime);
    await initialize(app);
    await request(app).post('/api/agent/acp/session/new').send({ agentId: 'codex' });

    const res = await request(app)
      .post('/api/agent/acp/permission')
      .send({ sessionId: 'sess-1', requestId: 'perm-1', decision: 'always' });

    expect(res.status).toBe(200);
    expect(source.respondToPermission).toHaveBeenCalledWith('perm-1', 'always');
  });

  it('reads and writes session modes and config options', async () => {
    const source = makeSource();
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: () => source });
    const app = buildApp(runtime);
    await initialize(app);
    await request(app).post('/api/agent/acp/session/new').send({ agentId: 'codex' });

    const options = await request(app).post('/api/agent/acp/session/options').send({ sessionId: 'sess-1' });
    expect(options.status).toBe(200);
    expect(source.getSessionOptions).toHaveBeenCalledWith('sess-1');

    const mode = await request(app).post('/api/agent/acp/session/mode').send({ sessionId: 'sess-1', modeId: 'ask' });
    expect(mode.status).toBe(200);
    expect(source.setSessionMode).toHaveBeenCalledWith('sess-1', 'ask');

    const config = await request(app)
      .post('/api/agent/acp/session/config')
      .send({ sessionId: 'sess-1', configId: 'model', value: 'mock-model-b' });
    expect(config.status).toBe(200);
    expect(source.setSessionConfigOption).toHaveBeenCalledWith('sess-1', 'model', 'mock-model-b');

    const missing = await request(app).post('/api/agent/acp/session/options').send({ sessionId: 'nope' });
    expect(missing.status).toBe(404);
  });

  it('surfaces a failed handshake as an explicit error', async () => {
    const source = makeSource({ start: vi.fn(async () => { throw new Error('executable not found'); }) });
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: () => source });
    const res = await request(buildApp(runtime)).post('/api/agent/acp/initialize').send({ agentId: 'codex', command: 'missing' });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AGENT_INITIALIZATION_FAILED');
    expect(res.body.error).toContain('executable not found');
    expect(source.stop).toHaveBeenCalled();
  });

  it('shuts down one agent without touching the other', async () => {
    const codex = makeSource();
    const claude = makeSource();
    const byCommand = { current: codex };
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: () => byCommand.current });
    const app = buildApp(runtime);
    await initialize(app, { agentId: 'codex', command: 'codex-acp' });
    byCommand.current = claude;
    await initialize(app, { agentId: 'claude', command: 'claude-acp' });

    const res = await request(app).post('/api/agent/acp/shutdown').send({ agentId: 'codex' });
    expect(res.status).toBe(200);
    expect(codex.stop).toHaveBeenCalled();
    expect(claude.stop).not.toHaveBeenCalled();
    expect(runtime.agents).toEqual(['claude']);
  });
});
