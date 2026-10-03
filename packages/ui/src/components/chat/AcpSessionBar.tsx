import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAgentBackendStore } from '@/lib/agent/config';
import { readSessionAcpAgentId, resolveAcpAgent } from '@/lib/agent/registry';
import { useAcpSessionOptionsStore } from '@/lib/agent/acp-session-options';
import type { AcpConfigOption } from '@/lib/agent/acp-session-options';
import { SettingsCardChip } from '@/components/sections/shared/SettingsCards';
import { cn } from '@/lib/utils';

const selectClassName =
  'h-7 max-w-44 truncate rounded-md border border-border bg-muted px-1.5 typography-micro text-foreground';

/**
 * Agent + model controls for an ACP-bound chat, rendered above the composer.
 * Everything shown comes from the agent's own `session/new` snapshot (modes,
 * select-type config options) — the UI never assumes a Codex-shaped or
 * Claude-shaped list. OpenCode chats render nothing here.
 */
export const AcpSessionBar: React.FC<{ sessionId: string | null; className?: string }> = ({
  sessionId,
  className,
}) => {
  const { t } = useI18n();
  const agentId = useGlobalSessionsStore((state) => {
    if (!sessionId) return null;
    return readSessionAcpAgentId(state.entityById.get(sessionId)?.metadata);
  });
  const custom = useAgentBackendStore((state) => state.config.acp);
  const entry = useAcpSessionOptionsStore((state) => (sessionId ? state.bySession[sessionId] : undefined));
  const load = useAcpSessionOptionsStore((state) => state.load);
  const setMode = useAcpSessionOptionsStore((state) => state.setMode);
  const setOption = useAcpSessionOptionsStore((state) => state.setOption);

  React.useEffect(() => {
    if (sessionId && agentId) void load(sessionId);
  }, [sessionId, agentId, load]);

  if (!sessionId || !agentId) return null;
  const definition = resolveAcpAgent(agentId, custom);
  const isSelectOption = (
    option: AcpConfigOption,
  ): option is Extract<AcpConfigOption, { type: 'select' }> => option.type === 'select';
  const selects = (entry?.configOptions ?? []).filter(isSelectOption);

  return (
    <div
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-1.5 pt-1', className)}
      data-acp-session-bar={sessionId}
    >
      <SettingsCardChip>{definition.name}</SettingsCardChip>
      {!entry || entry.status === 'loading' ? (
        <span className="typography-micro text-muted-foreground">{t('chat.acp.options.loading')}</span>
      ) : null}
      {entry?.status === 'error' ? (
        <>
          <span className="typography-micro text-muted-foreground">{t('chat.acp.options.error')}</span>
          <button
            type="button"
            className="typography-micro text-foreground underline"
            onClick={() => void load(sessionId)}
          >
            {t('chat.acp.options.retry')}
          </button>
        </>
      ) : null}
      {entry?.status === 'ready' && entry.modes && entry.modes.availableModes.length > 1 ? (
        <select
          aria-label={t('chat.acp.options.mode')}
          title={t('chat.acp.options.mode')}
          className={selectClassName}
          value={entry.modes.currentModeId}
          onChange={(event) => void setMode(sessionId, event.target.value)}
        >
          {entry.modes.availableModes.map((mode) => (
            <option key={mode.id} value={mode.id} title={mode.description ?? undefined}>
              {mode.name}
            </option>
          ))}
        </select>
      ) : null}
      {entry?.status === 'ready'
        ? selects.map((option) => (
            <select
              key={option.id}
              aria-label={option.name}
              title={option.description ?? option.name}
              className={selectClassName}
              value={option.currentValue}
              onChange={(event) => void setOption(sessionId, option.id, event.target.value)}
            >
              {option.values.map((value) => (
                <option key={value.value} value={value.value}>
                  {value.name}
                </option>
              ))}
            </select>
          ))
        : null}
    </div>
  );
};
