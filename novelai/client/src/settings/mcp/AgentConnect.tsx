import { useState } from 'react';
import clsx from 'clsx';
import { Button, Icon } from '../../ui';
import { useUiText, type UiText } from '../../ui/i18n';
import type { UiStringKey } from '../../ui/strings';
import type { McpAccessInfo, McpClientId } from '../../types';
import { MCP_CLIENTS } from './model';

const LABEL: Record<McpClientId, UiStringKey> = { claude: 'mcp.client.claude', cursor: 'mcp.client.cursor', codex: 'mcp.client.codex', pi: 'mcp.client.pi', dsh: 'mcp.client.dsh', other: 'mcp.client.other' };
const BADGE: Record<McpClientId, string> = { claude: 'C', cursor: 'C', codex: 'C', pi: 'P', dsh: 'D', other: '…' };
const HOW: Record<McpClientId, UiStringKey> = { claude: 'mcp.how.command', cursor: 'mcp.how.cursor', codex: 'mcp.how.codex', pi: 'mcp.how.pi', dsh: 'mcp.how.dsh', other: 'mcp.how.other' };

/** What to do with the snippet and how the tool timeout is handled, per client (sources in electron/mcp-access.ts). */
export function clientHint(t: UiText, client: McpClientId, seconds: number, start: number): string {
  const minutes = Math.round(seconds / 60);
  if (client === 'claude') return t('mcp.hint.claude', { minutes });
  if (client === 'cursor') return t('mcp.hint.cursor');
  if (client === 'codex') return t('mcp.hint.codex', { minutes, start });
  // Seconds as written in the configuration (1560, not 1,560).
  if (client === 'pi') return t('mcp.hint.pi', { seconds: String(seconds) });
  // Milliseconds as written in the configuration (1560000).
  if (client === 'dsh') return t('mcp.hint.dsh', { ms: String(seconds * 1000) });
  return t('mcp.hint.other', { minutes, seconds: String(seconds) });
}

/** A copy button with its result in place (copied, or a failure to copy by hand). */
export function CopyButton({ text, testId, size = 'sm' }: { text: string; testId?: string; size?: 'sm' | 'md' }) {
  const { t } = useUiText();
  const [state, setState] = useState<'' | 'copied' | 'failed'>('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setState('copied'); setTimeout(() => setState(''), 1800); }
    catch { setState('failed'); }
  };
  return <span className="mc-copy">
    <Button size={size} icon={state === 'copied' ? 'check' : 'copy'} onClick={() => void copy()} data-testid={testId}>{t(state === 'copied' ? 'c.copied' : 'c.copy')}</Button>
    {state === 'failed' ? <span className="mc-copy-failed" role="alert">{t('mcp.copyFailed')}</span> : null}
  </span>;
}

/** A configuration snippet: monospace, selectable, with its copy button. */
export function Snippet({ text, testId }: { text: string; testId?: string }) {
  return <div className="mc-snippet">
    <pre tabIndex={0} data-testid={testId ? `${testId}-text` : undefined}>{text}</pre>
    <CopyButton text={text} testId={testId ? `${testId}-copy` : undefined} />
  </div>;
}

/**
 * The agent picker (Claude Code / Cursor / Codex / Pi / DeepSeek Harness / other) with this run's configuration for the picked one,
 * where it goes, the timeout note and the first thing to try (prototype 22, 23, 31).
 */
export function AgentConnect({ info, client, onClient, showTry = true }: { info: McpAccessInfo; client: McpClientId; onClient(client: McpClientId): void; showTry?: boolean }) {
  const { t } = useUiText();
  const config = info.clients[client];
  return <div className="mc-connect" data-testid="mcp-connect" data-client={client}>
    <div className="mc-clients" role="radiogroup" aria-label={t('mcp.pick')}>
      {MCP_CLIENTS.map(value => <button key={value} type="button" role="radio" aria-checked={value === client} className={clsx('mc-client', value === client && 'is-on')} onClick={() => onClient(value)} data-testid={`mcp-client-${value}`}>
        <span className={clsx('mc-badge', `mc-badge--${value}`)} aria-hidden="true">{BADGE[value]}</span>{t(LABEL[value])}
      </button>)}
    </div>
    <p className="mc-how">{t(HOW[client])}</p>
    <Snippet text={config.snippet} testId="mcp-snippet" />
    <p className="mc-hint">{config.format === 'command' || config.format === 'yaml' ? clientHint(t, client, info.toolTimeoutSeconds, info.startupTimeoutSeconds) : `${t(config.format === 'toml' ? 'mcp.mergeToml' : 'mcp.merge')} ${clientHint(t, client, info.toolTimeoutSeconds, info.startupTimeoutSeconds)}`}</p>
    {showTry ? <div className="mc-try"><Icon name="sparkle" size={14} /><span>{t('mcp.try')}</span></div> : null}
  </div>;
}
