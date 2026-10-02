import { describe, expect, it } from 'vitest';

import { ACP_DEFAULT_AGENTS, isAcpEnabled, resolveAgentLaunch } from '../acp-config.js';

describe('isAcpEnabled', () => {
  it('defaults to off', () => {
    expect(isAcpEnabled({})).toBe(false);
    expect(isAcpEnabled({ OPENCHAMBER_ACP_ENABLED: 'off' })).toBe(false);
    expect(isAcpEnabled({ OPENCHAMBER_ACP_ENABLED: '0' })).toBe(false);
  });

  it('accepts common truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(isAcpEnabled({ OPENCHAMBER_ACP_ENABLED: value })).toBe(true);
    }
  });
});

describe('resolveAgentLaunch', () => {
  it('fills defaults for a built-in agent', () => {
    const launch = resolveAgentLaunch(ACP_DEFAULT_AGENTS.codex);
    expect(launch.command).toBe('npx');
    expect(launch.args).toEqual(['-y', '@agentclientprotocol/codex-acp']);
  });

  it('rejects an agent with no command', () => {
    expect(() => resolveAgentLaunch({ id: 'broken' })).toThrow(/no command/);
  });

  it('drops non-string arguments', () => {
    const launch = resolveAgentLaunch({ id: 'custom', command: 'agent', args: ['--acp', 42, null] });
    expect(launch.args).toEqual(['--acp']);
  });
});
