import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createAcpRouteRuntime } from '../routes.js';

const makeSource = (overrides = {}) => ({
  start: vi.fn(async () => ({ sessionId: 'sess-1', initialized: { agentCapabilities: { loadSession: true } } })),
  prompt: vi.fn(async () => ({ stopReason: 'end_turn' })),
  cancel: vi.fn(async () => {}),
  respondToPermission: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  ...overrides,
});

const buildApp = (runtime) => {
  const app = express();
  runtime.registerRoutes(app, { hub: { injectEvent: () => {} } });
  return app;
};

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

  it('initializes, prompts, cancels, and shuts down', async () => {
    const source = makeSource();
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: () => source });
    const app = buildApp(runtime);

    const init = await request(app)
      .post('/api/agent/acp/initialize')
      .send({ command: 'agent', args: ['--acp'], directory: '/work' });
    expect(init.status).toBe(200);
    expect(init.body).toMatchObject({ backend: 'acp', sessionId: 'sess-1', directory: '/work' });
    expect(init.body.capabilities).toEqual({ loadSession: true });
    expect(source.start).toHaveBeenCalledWith(expect.objectContaining({ command: 'agent', args: ['--acp'], cwd: '/work' }));

    const prompt = await request(app)
      .post('/api/agent/acp/prompt')
      .send({ sessionId: 'sess-1', messageId: 'msg_user_1', text: 'hello' });
    expect(prompt.status).toBe(200);
    expect(prompt.body.stopReason).toBe('end_turn');
    expect(source.prompt).toHaveBeenCalledWith({ messageId: 'msg_user_1', text: 'hello' });

    const cancel = await request(app).post('/api/agent/acp/cancel').send({ sessionId: 'sess-1' });
    expect(cancel.status).toBe(200);

    const shutdown = await request(app).post('/api/agent/acp/shutdown').send();
    expect(shutdown.status).toBe(200);
    expect(source.stop).toHaveBeenCalled();
  });

  it('rejects a prompt before initialize', async () => {
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: makeSource });
    const res = await request(buildApp(runtime)).post('/api/agent/acp/prompt').send({ text: 'hello' });
    expect(res.status).toBe(409);
  });

  it('rejects a prompt for an unknown session', async () => {
    const source = makeSource();
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: () => source });
    const app = buildApp(runtime);
    await request(app).post('/api/agent/acp/initialize').send({ command: 'agent' });

    const res = await request(app).post('/api/agent/acp/prompt').send({ sessionId: 'other', text: 'hi' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
  });

  it('answers a permission request', async () => {
    const source = makeSource();
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: () => source });
    const app = buildApp(runtime);
    await request(app).post('/api/agent/acp/initialize').send({ command: 'agent' });

    const res = await request(app)
      .post('/api/agent/acp/permission')
      .send({ sessionId: 'sess-1', requestId: 'perm-1', decision: 'always' });

    expect(res.status).toBe(200);
    expect(source.respondToPermission).toHaveBeenCalledWith('perm-1', 'always');
  });

  it('surfaces a failed handshake as an explicit error', async () => {
    const source = makeSource({ start: vi.fn(async () => { throw new Error('executable not found'); }) });
    const runtime = createAcpRouteRuntime({ enabled: () => true, createSource: () => source });
    const res = await request(buildApp(runtime)).post('/api/agent/acp/initialize').send({ command: 'missing' });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AGENT_INITIALIZATION_FAILED');
    expect(res.body.error).toContain('executable not found');
    expect(source.stop).toHaveBeenCalled();
  });
});
