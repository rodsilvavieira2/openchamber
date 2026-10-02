import React from 'react';
import { Input } from '@/components/ui/input';
import {
  SettingsSection,
  SettingsStackedField,
  SettingsRadioGroup,
  SettingsRadioOption,
} from '@/components/sections/shared/SettingsSection';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { useAgentBackendStore } from '@/lib/agent/config';
import { DEFAULT_ACP_AGENT } from '@/lib/agent/config';

type AgentPreset = {
  id: string;
  name: string;
  command: string;
  args: string[];
  labelKey: I18nKey;
};

const AGENT_PRESETS: readonly AgentPreset[] = [
  { id: 'codex', name: 'Codex', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp'], labelKey: 'settings.agentBackend.agent.codex' },
  { id: 'claude', name: 'Claude Code', command: 'claude-code-acp', args: [], labelKey: 'settings.agentBackend.agent.claude' },
  { id: 'custom', name: 'Custom ACP', command: '', args: [], labelKey: 'settings.agentBackend.agent.custom' },
];

/**
 * Agent backend selection. OpenCode stays the default; choosing ACP lets the
 * user point at any ACP-compatible agent (a preset or a custom command).
 */
export const AgentBackendSettings: React.FC = () => {
  const { t } = useI18n();
  const config = useAgentBackendStore((state) => state.config);
  const setConfig = useAgentBackendStore((state) => state.setConfig);
  const acp = config.acp;

  const updateAcp = (patch: Partial<typeof acp>): void => {
    setConfig({ ...config, acp: { ...acp, ...patch } });
  };

  return (
    <SettingsSection
      title={t('settings.agentBackend.title')}
      info={t('settings.agentBackend.hint')}
      settingsItem="agent-backend"
    >
      <SettingsStackedField label={t('settings.agentBackend.backend')}>
        <SettingsRadioGroup aria-label={t('settings.agentBackend.backend')}>
          <SettingsRadioOption
            selected={config.backend === 'opencode'}
            onSelect={() => setConfig({ ...config, backend: 'opencode' })}
            label={t('settings.agentBackend.opencode')}
          />
          <SettingsRadioOption
            selected={config.backend === 'acp'}
            onSelect={() => setConfig({ ...config, backend: 'acp' })}
            label={t('settings.agentBackend.acp')}
          />
        </SettingsRadioGroup>
      </SettingsStackedField>

      {config.backend === 'acp' ? (
        <>
          <SettingsStackedField label={t('settings.agentBackend.agent')}>
            <SettingsRadioGroup aria-label={t('settings.agentBackend.agent')}>
              {AGENT_PRESETS.map((preset) => (
                <SettingsRadioOption
                  key={preset.id}
                  selected={acp.agentId === preset.id}
                  onSelect={() =>
                    updateAcp({
                      agentId: preset.id,
                      name: preset.name,
                      command: preset.command,
                      args: preset.args,
                    })
                  }
                  label={t(preset.labelKey)}
                />
              ))}
            </SettingsRadioGroup>
          </SettingsStackedField>

          <SettingsStackedField label={t('settings.agentBackend.command')}>
            <Input
              value={acp.command}
              placeholder={DEFAULT_ACP_AGENT.command}
              onChange={(event) => updateAcp({ command: event.target.value })}
            />
          </SettingsStackedField>

          <SettingsStackedField label={t('settings.agentBackend.arguments')}>
            <Input
              value={acp.args.join(' ')}
              placeholder={DEFAULT_ACP_AGENT.args.join(' ')}
              onChange={(event) => updateAcp({ args: event.target.value.split(' ').filter((arg) => arg.length > 0) })}
            />
          </SettingsStackedField>
        </>
      ) : null}
    </SettingsSection>
  );
};
