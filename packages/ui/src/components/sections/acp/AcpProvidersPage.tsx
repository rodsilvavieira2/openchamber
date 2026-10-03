import React from 'react';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsCard,
  SettingsCardChip,
  SettingsCardPill,
  SettingsCardSearch,
  SettingsCardIcon,
} from '@/components/sections/shared/SettingsCards';
import { SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { createSession as createChatSession } from '@/sync/session-actions';
import {
  CUSTOM_ACP_AGENT_ID,
  listAcpAgentIds,
  type AcpAgentDefinition,
} from '@/lib/agent/registry';
import { useAcpStore, listAcpAgentDefinitions, type AcpConnectionStatus } from '@/lib/agent/acp-store';
import { useAgentBackendStore } from '@/lib/agent/config';
import { cn } from '@/lib/utils';

const agentIconFor = (agentId: string): IconName => {
  switch (agentId) {
    case 'codex':
      return 'code-box';
    case 'claude':
      return 'sparkling';
    default:
      return 'terminal-box';
  }
};

const statusTone = (status: AcpConnectionStatus): 'success' | 'info' | 'error' | 'neutral' => {
  switch (status) {
    case 'connected':
      return 'success';
    case 'starting':
      return 'info';
    case 'error':
      return 'error';
    default:
      return 'neutral';
  }
};

const STATUS_LABEL_KEYS = {
  off: 'settings.acp.status.off',
  starting: 'settings.acp.status.starting',
  connected: 'settings.acp.status.connected',
  error: 'settings.acp.status.error',
} as const;

const AgentCard: React.FC<{ definition: AcpAgentDefinition }> = ({ definition }) => {
  const { t } = useI18n();
  const runtime = useAcpStore((state) => state.agents[definition.id]);
  const connect = useAcpStore((state) => state.connect);
  const disconnect = useAcpStore((state) => state.disconnect);
  const defaultAcpAgentId = useAgentBackendStore((state) => state.config.defaultAcpAgentId);
  const setConfig = useAgentBackendStore((state) => state.setConfig);
  const config = useAgentBackendStore((state) => state.config);
  const status: AcpConnectionStatus = runtime?.status ?? 'off';
  const connected = status === 'connected';

  const handleOpen = (): void => {
    if (status === 'off' || status === 'error') void connect(definition.id);
  };

  const handleNewChat = async (): Promise<void> => {
    if (!connected) {
      await connect(definition.id);
    }
    const directory = useDirectoryStore.getState().currentDirectory ?? null;
    // Bound to this agent; every later turn resolves its client by session.
    await createChatSession(undefined, directory, undefined, undefined, undefined, 'open', {
      agentId: definition.id,
    });
  };

  const handleSetDefault = (): void => {
    setConfig({ ...config, defaultAcpAgentId: definition.id });
  };

  return (
    <SettingsCard
      icon={<SettingsCardIcon name={agentIconFor(definition.id)} />}
      title={definition.name}
      subtitle={definition.id === CUSTOM_ACP_AGENT_ID ? definition.command || definition.id : definition.id}
      badges={<SettingsCardPill tone={statusTone(status)}>{t(STATUS_LABEL_KEYS[status])}</SettingsCardPill>}
      footer={(
        <>
          <span className="inline-flex items-center gap-1">
            <Icon name="stack" className="size-3.5 opacity-70" aria-hidden />
            <span className="tabular-nums">{runtime?.sessionIds.length ?? 0}</span>
            <span>{t('settings.acp.card.sessions')}</span>
          </span>
          {defaultAcpAgentId === definition.id ? (
            <SettingsCardChip>{t('settings.acp.card.default')}</SettingsCardChip>
          ) : null}
          {status === 'error' && runtime?.error ? (
            <span className="truncate text-[var(--status-error)]" title={runtime.error}>{runtime.error}</span>
          ) : null}
        </>
      )}
      muted={status === 'off'}
      onOpen={status === 'connected' ? undefined : handleOpen}
      actions={[
        ...(connected
          ? [{ label: t('settings.acp.actions.newChat'), icon: 'add' as const, onSelect: () => void handleNewChat() }]
          : [{ label: t('settings.acp.actions.connect'), icon: 'plug' as const, onSelect: () => void connect(definition.id) }]),
        ...(defaultAcpAgentId === definition.id
          ? []
          : [{ label: t('settings.acp.actions.setDefault'), icon: 'star' as const, onSelect: handleSetDefault }]),
        ...(connected
          ? [{ label: t('settings.acp.actions.disconnect'), icon: 'close' as const, destructive: true, onSelect: () => void disconnect(definition.id) }]
          : []),
      ]}
      actionsLabel={t('settings.acp.card.actions', { name: definition.name })}
    />
  );
};

/** ACP agents as connectable providers: Codex, Claude Code, and one Custom CLI. */
export const AcpProvidersPage: React.FC = () => {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const refresh = useAcpStore((state) => state.refresh);
  const config = useAgentBackendStore((state) => state.config);
  const setConfig = useAgentBackendStore((state) => state.setConfig);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const definitions = listAcpAgentDefinitions();
  const filtered = definitions.filter((definition) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return definition.name.toLowerCase().includes(q) || definition.id.includes(q);
  });
  const updateCustom = (patch: Partial<typeof config.acp>): void => {
    setConfig({ ...config, acp: { ...config.acp, ...patch } });
  };

  return (
    <SettingsPageLayout title={t('settings.acp.title')} description={t('settings.acp.description')}>
      <SettingsCardSearch value={query} onChange={setQuery} placeholder={t('settings.acp.search')} />
      <div className={cn(SETTINGS_CARD_GRID_CLASS, 'mb-6')}>
        {filtered.map((definition) => (
          <AgentCard key={definition.id} definition={definition} />
        ))}
      </div>
      {listAcpAgentIds().includes(CUSTOM_ACP_AGENT_ID) ? (
        <SettingsSection title={t('settings.acp.custom.title')} divider={false}>
          <SettingsStackedField label={t('settings.acp.custom.command')}>
            <Input
              value={config.acp.command}
              onChange={(event) => updateCustom({ command: event.target.value })}
            />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.acp.custom.arguments')}>
            <Input
              value={config.acp.args.join(' ')}
              onChange={(event) =>
                updateCustom({ args: event.target.value.split(' ').filter((arg) => arg.length > 0) })
              }
            />
          </SettingsStackedField>
        </SettingsSection>
      ) : null}
    </SettingsPageLayout>
  );
};
