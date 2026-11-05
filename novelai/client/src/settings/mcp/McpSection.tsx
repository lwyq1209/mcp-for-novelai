import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { Button, Disclosure, Icon, Spinner, Tag } from '../../ui';
import { useUiText } from '../../ui/i18n';
import type { CaptureRequest } from '../../shell/capture';
import type { McpAccessInfo, McpClientId } from '../../types';
import { InfoTip, InlineNote, SettingsBlock, SettingsGroup } from '../sections/common';
import { AgentConnect, Snippet } from './AgentConnect';
import { useAgentActivity, useMcpAccess, useNow } from './hooks';
import { clientTileOf, connectionRows, MCP_SERVER_NAME, MCP_TOOL_GROUPS, MCP_TOOL_NAMES, type McpToolGroup } from './model';
import './mcp.css';

const GROUP_LABEL = { library: 'mcp.tg.library', queue: 'mcp.tg.queue', canvas: 'mcp.tg.canvas' } as const;
/** The client a capture name shows (settings-mcp-codex → codex). */
const captureClient = (capture: CaptureRequest | null): McpClientId | null => {
  const match = capture ? /^settings-mcp-(cursor|codex|pi|other)$/.exec(capture.page) : null;
  return match ? match[1] as McpClientId : null;
};

/**
 * Settings › MCP access (step 4b2, prototype 22–23): whether the MCP server is ready, the recent connections (client,
 * time, last tool; never arguments), the configuration for each agent with this run's real paths, the 18 tools, and
 * the advanced details the old page had (project folder and inboxes, data folder, running from source).
 */
export function McpSection({ active, capture = null }: { active: boolean; capture?: CaptureRequest | null }) {
  const { t } = useUiText();
  const access = useMcpAccess(active);
  const activity = useAgentActivity(active, capture);
  const [client, setClient] = useState<McpClientId | null>(() => captureClient(capture));
  // The picker starts on the agent that called last (else Claude Code) until the user picks one.
  const recentTile = clientTileOf(activity?.clients.slice().sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0]?.client?.name);
  const picked = client ?? recentTile ?? 'claude';
  return <section className="sp-section mc-section" data-testid="settings-mcp">
    <h2>{t('mcp.title')}</h2>
    <p className="mc-lead">{t('mcp.intro')}</p>
    {access.failed ? <InlineNote tone="danger" icon="alert" testId="mcp-load-failed">{t('mcp.loadFailed')}</InlineNote>
      : !access.info ? <div className="mc-loading" role="status"><Spinner size={16} label={t('mcp.loading')} /><span>{t('mcp.loading')}</span></div>
      : <>
        <ServerStatus info={access.info} active={active} activity={activity} />
        <SettingsGroup title={t('mcp.pick')} testId="mcp-pick">
          <SettingsBlock><AgentConnect info={access.info} client={picked} onClient={setClient} /></SettingsBlock>
        </SettingsGroup>
        <ToolList />
        <Advanced info={access.info} />
      </>}
  </section>;
}

export function ServerStatus({ info, active, activity }: { info: McpAccessInfo; active: boolean; activity: ReturnType<typeof useAgentActivity> }) {
  const { t, lang } = useUiText();
  const now = useNow(active);
  const rows = connectionRows(activity, lang, now);
  const ready = info.bundleExists && info.bridgeReady;
  return <SettingsGroup className="mc-status" testId="mcp-status">
    <div className="mc-status-head">
      <span className={clsx('mc-status-icon', !ready && 'is-warn')}><Icon name={ready ? 'plug' : 'alert'} size={20} /></span>
      <div className="mc-status-text">
        <b>{ready ? t('mcp.ready') : !info.bundleExists ? t('mcp.missingBundle') : t('mcp.notReady')}</b>
        <span>{ready ? t(info.packaged ? 'mcp.readyPackaged' : 'mcp.readySource') : info.bundleExists ? t('mcp.notReadyHint') : ''}</span>
      </div>
      <Tag tone={ready ? 'ok' : 'warn'}>{t('mcp.server', { name: MCP_SERVER_NAME, n: MCP_TOOL_NAMES.length })}</Tag>
    </div>
    {info.temporaryLocation ? <SettingsBlock><InlineNote tone="warn" icon="alert" testId="mcp-temporary">{t('mcp.temporary')}</InlineNote></SettingsBlock> : null}
    <div className="mc-recent" data-testid="mcp-recent">
      <div className="mc-recent-head"><span>{t('mcp.recent')}<InfoTip content={t('mcp.recentPrivacy')} /></span></div>
      {rows.length ? rows.map(row => <div key={row.key} className="mc-recent-row" data-testid="mcp-recent-row">
        <i className={clsx('mc-dot', row.live && 'is-live')} aria-hidden="true" />
        <b>{row.label}</b>
        <span className="mc-when">{row.when}</span>
        <span className="mc-calls">{t('mcp.calls', { n: row.calls })}</span>
        {row.tool ? <code className="mc-tool">{row.tool}</code> : null}
      </div>) : <div className="mc-recent-none">{t('mcp.recentNone')}</div>}
    </div>
  </SettingsGroup>;
}

function ToolList() {
  const { t } = useUiText();
  return <SettingsGroup title={t('mcp.tools', { n: MCP_TOOL_NAMES.length })} testId="mcp-tools">
    <SettingsBlock className="mc-tools">
      {(Object.keys(MCP_TOOL_GROUPS) as McpToolGroup[]).map(group => <div key={group} className="mc-tool-group">
        <b>{t(GROUP_LABEL[group], { n: MCP_TOOL_GROUPS[group].length })}</b>
        <div>{MCP_TOOL_GROUPS[group].map(name => <code key={name}>{name}</code>)}</div>
      </div>)}
    </SettingsBlock>
  </SettingsGroup>;
}

function Advanced({ info }: { info: McpAccessInfo }) {
  const { t } = useUiText();
  const [openFailed, setOpenFailed] = useState(false);
  useEffect(() => setOpenFailed(false), [info.dataRoot]);
  const openData = async () => {
    try { const result = await window.naiDesktop.openInExplorer(info.dataRoot) as { ok?: boolean } | undefined; setOpenFailed(result?.ok === false); }
    catch { setOpenFailed(true); }
  };
  return <SettingsGroup className="mc-advanced" testId="mcp-advanced">
    <Disclosure summary={<span>{t('mcp.advanced')}</span>}>
      <div className="mc-adv">
        <div className="mc-adv-block">
          <b>{t('mcp.project')}</b>
          <p>{t('mcp.projectHint', { env: info.projectRootEnv })}</p>
          <code className="mc-path">{info.workspaceRoot}</code>
          <span className="mc-sub">{t('mcp.inboxes')}</span>
          <code className="mc-path">{info.materialInbox}</code>
          <code className="mc-path">{info.studyInbox}</code>
        </div>
        <div className="mc-adv-block">
          <b>{t('mcp.data')}</b>
          <div className="mc-path-row"><code className="mc-path" data-testid="mcp-data-root">{info.dataRoot}</code>
            <Button size="sm" icon="folder" onClick={() => void openData()}>{t(info.platform === 'darwin' ? 'mcp.openFolder' : 'mcp.openFolderOther')}</Button></div>
          {openFailed ? <InlineNote tone="danger" icon="alert">{t('c.failed')}</InlineNote> : null}
          <p>{t(info.customDataRoot ? 'mcp.dataCustom' : 'mcp.dataDefault', { env: info.dataDirEnv })}</p>
        </div>
        <div className="mc-adv-block">
          <b>{t('mcp.source')}</b>
          <p>{t('mcp.sourceHint')}{info.sourceEntry ? '' : ` ${t('mcp.sourcePlaceholder')}`}</p>
          <Snippet text={info.sourceCommand} testId="mcp-source" />
        </div>
      </div>
    </Disclosure>
  </SettingsGroup>;
}
