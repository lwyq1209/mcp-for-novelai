import { useEffect, useState } from 'react';
import type { AgentActivity } from '../../agent-clients';
import type { CaptureRequest } from '../../shell/capture';
import type { McpAccessInfo } from '../../types';
import { captureActivity } from './model';

/** This run's MCP access details (host: electron/mcp-access.ts), read once the section or the guide step is shown. */
export function useMcpAccess(active: boolean) {
  const [state, setState] = useState<{ info: McpAccessInfo | null; failed: boolean }>({ info: null, failed: false });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active || state.info) return;
    let live = true;
    const api = typeof window === 'undefined' ? undefined : window.naiDesktop;
    if (!api?.mcpAccess) { setState({ info: null, failed: true }); return; }
    api.mcpAccess().then(info => { if (live) setState({ info, failed: false }); }, () => { if (live) setState({ info: null, failed: true }); });
    return () => { live = false; };
  }, [active, attempt, state.info]);
  return { ...state, reload: () => { setState({ info: null, failed: false }); setAttempt(value => value + 1); } };
}

/** Which sample activity a capture page shows (settings-mcp: the prototype's three clients; the guide: none or one call). */
const captureMode = (capture: CaptureRequest | null) => !capture ? null
  : capture.page === 'onboarding-2-connected' ? 'just-now' as const
  : capture.page.startsWith('onboarding-') ? 'none' as const : 'sample' as const;

/**
 * Recent agent calls (client, tool, time; never arguments): read when shown and followed through the host's pushes
 * (novelai:agent:activity). A capture run shows sample activity instead.
 */
export function useAgentActivity(active: boolean, capture: CaptureRequest | null = null) {
  const sample = captureMode(capture);
  const [activity, setActivity] = useState<AgentActivity | null>(() => sample ? captureActivity(new Date(), sample) : null);
  useEffect(() => {
    if (!active || sample) return;
    const api = typeof window === 'undefined' ? undefined : window.naiDesktop;
    if (!api?.agentActivity) return;
    let live = true;
    const remove = typeof api.onAgentActivity === 'function' ? api.onAgentActivity(next => { if (live) setActivity(next); }) : () => {};
    api.agentActivity().then(next => { if (live) setActivity(current => current ?? next); }, () => undefined);
    return () => { live = false; remove(); };
  }, [active, sample]);
  return activity;
}

/** Now, refreshed every `everyMs` while shown (relative times such as "2 分钟前"). */
export function useNow(active: boolean, everyMs = 30_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}
