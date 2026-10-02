// ACP feature flag and agent launch configuration.
//
// ACP support starts behind a flag so OpenCode stays the default backend until
// the ACP runtime is proven stable. This module owns the flag and the built-in
// agent definitions; a user-supplied definition (Settings, Phase 6) overrides
// the defaults without any code change.

const ACP_ENABLED_ENV = 'OPENCHAMBER_ACP_ENABLED';

/** True when ACP support is explicitly enabled. Defaults to off. */
export const isAcpEnabled = (env = process.env) => {
  const value = env?.[ACP_ENABLED_ENV];
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

/**
 * Built-in ACP agents. `command`/`args` are defaults a user may override; the
 * runtime never branches on `id`, it only launches whatever is configured.
 */
export const ACP_DEFAULT_AGENTS = {
  codex: {
    id: 'codex',
    name: 'Codex',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude-code-acp',
    args: [],
  },
};

/**
 * Turn an agent definition into a spawn spec. An empty command is a
 * configuration error and throws early with a readable message instead of
 * failing later with a cryptic spawn error.
 */
export const resolveAgentLaunch = (agent) => {
  const command = typeof agent?.command === 'string' ? agent.command.trim() : '';
  if (!command) {
    throw new Error(
      `ACP agent "${agent?.id ?? agent?.name ?? 'unknown'}" has no command to launch.`,
    );
  }
  const args = Array.isArray(agent?.args) ? agent.args.filter((arg) => typeof arg === 'string') : [];
  return {
    id: typeof agent?.id === 'string' ? agent.id : command,
    name: typeof agent?.name === 'string' ? agent.name : command,
    command,
    args,
    cwd: typeof agent?.cwd === 'string' ? agent.cwd : undefined,
    env: agent?.env && typeof agent.env === 'object' ? agent.env : undefined,
  };
};
