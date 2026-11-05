import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

let portalRoot: HTMLDivElement | null = null;

/** Lazily creates (once) and reuses the shared overlay root under document.body. */
export function uiPortalRoot(): HTMLDivElement | null {
  if (typeof document === 'undefined') return null;
  if (portalRoot && portalRoot.isConnected) return portalRoot;
  const existing = document.body.querySelector<HTMLDivElement>(':scope > .ui-portal-root');
  if (existing) {
    portalRoot = existing;
    return existing;
  }
  const node = document.createElement('div');
  node.className = 'ui-scope ui-portal-root';
  document.body.appendChild(node);
  portalRoot = node;
  return node;
}

/**
 * Renders children into the shared `.ui-scope.ui-portal-root` container.
 * Renders nothing during server rendering and on the very first client render
 * (the container is resolved in an effect), so it is SSR safe.
 */
export function UiPortal({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    setRoot(uiPortalRoot());
  }, []);
  return root ? createPortal(children, root) : null;
}
