import { useId } from 'react';

// 24×24 line icons, 1.6 stroke, round caps (from the step-4 prototype icons.js).
// The bodies are static constants; nothing user-supplied is ever injected.
const ICON_BODIES = {
  library: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.5-4.5-8 8"/>',
  canvas: '<path d="M12 3.5c.9 3.9 1.4 4.4 5.3 5.3-3.9.9-4.4 1.4-5.3 5.3-.9-3.9-1.4-4.4-5.3-5.3 3.9-.9 4.4-1.4 5.3-5.3z"/><path d="M18 14.5c.4 1.7.7 2 2.4 2.4-1.7.4-2 .7-2.4 2.4-.4-1.7-.7-2-2.4-2.4 1.7-.4 2-.7 2.4-2.4z"/><path d="M6.5 15.5l-2 4"/>',
  queue: '<path d="M12 3.8l8.2 4.2-8.2 4.2-8.2-4.2z"/><path d="M3.8 12l8.2 4.2 8.2-4.2"/><path d="M3.8 16l8.2 4.2 8.2-4.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.8l-5.1 2.6 1-5.6-4.1-4 5.7-.8z"/>',
  starFill: '<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.8l-5.1 2.6 1-5.6-4.1-4 5.7-.8z" fill="currentColor"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2L17.5 7"/><path d="M10.2 10.5v5.5M13.8 10.5v5.5"/>',
  restore: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  down: '<path d="M7 10l5 5 5-5"/>',
  right: '<path d="M10 7l5 5-5 5"/>',
  left: '<path d="M14 7l-5 5 5 5"/>',
  more: '<circle cx="6" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18" cy="12" r="1.2" fill="currentColor"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.5-4.5-8 8"/>',
  upload: '<path d="M12 15.5V4.5M7.5 9L12 4.5 16.5 9"/><path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  download: '<path d="M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5"/><path d="M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  eye: '<path d="M2.8 12s3.4-6.2 9.2-6.2 9.2 6.2 9.2 6.2-3.4 6.2-9.2 6.2S2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>',
  alert: '<path d="M12 4l9 15.5H3z"/><path d="M12 10v4.2M12 16.8v.2"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  dice: '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/><circle cx="9" cy="9" r="1" fill="currentColor"/><circle cx="15" cy="15" r="1" fill="currentColor"/><circle cx="15" cy="9" r="1" fill="currentColor"/><circle cx="9" cy="15" r="1" fill="currentColor"/>',
  brush: '<path d="M14.5 4.5l5 5-7.5 7.5-5-5z"/><path d="M7 12l-1.2 1.2a3 3 0 0 0 0 4.2 3 3 0 0 1-2.3 1.6c2.6 1 5.3.6 6.5-.8L11 17"/>',
  eraser: '<path d="M8.5 19.5h11"/><path d="M4.8 14.2l8.8-8.8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 18.1a2 2 0 0 1-1.4.6H8a2 2 0 0 1-1.4-.6l-1.8-1.8a1.5 1.5 0 0 1 0-2.1z"/><path d="M9 10l5 5"/>',
  invert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17A8.5 8.5 0 0 0 12 3.5z" fill="currentColor"/>',
  layers: '<path d="M12 3.8l8.2 4.2-8.2 4.2-8.2-4.2z"/><path d="M3.8 12l8.2 4.2 8.2-4.2"/>',
  agent: '<circle cx="16" cy="16" r="4"/><path d="M5 5l8.2 8.2"/>',
  sparkle: '<path d="M12 3c1 4.6 1.6 5.2 6.2 6.2-4.6 1-5.2 1.6-6.2 6.2-1-4.6-1.6-5.2-6.2-6.2C10.4 8.2 11 7.6 12 3z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  link: '<path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 0 1-13 5.1M4.5 12a7.5 7.5 0 0 1 13-5.1"/><path d="M17.5 3.5v3.6h-3.6M6.5 20.5v-3.6h3.6"/>',
  filter: '<path d="M4.5 6h15M7.5 12h9M10.5 18h3"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  gridS: '<rect x="4" y="4" width="4" height="4" rx="1"/><rect x="10" y="4" width="4" height="4" rx="1"/><rect x="16" y="4" width="4" height="4" rx="1"/><rect x="4" y="10" width="4" height="4" rx="1"/><rect x="10" y="10" width="4" height="4" rx="1"/><rect x="16" y="10" width="4" height="4" rx="1"/><rect x="4" y="16" width="4" height="4" rx="1"/><rect x="10" y="16" width="4" height="4" rx="1"/><rect x="16" y="16" width="4" height="4" rx="1"/>',
  gridL: '<rect x="4" y="4" width="16" height="7" rx="1.5"/><rect x="4" y="13" width="16" height="7" rx="1.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.3-3.5-8.5S9.6 6 12 3.5z"/>',
  key: '<circle cx="8" cy="15" r="3.8"/><path d="M10.8 12.3L19 4.5M16.5 7l2.2 2.2M14.2 9.3l1.6 1.6"/>',
  plug: '<circle cx="15.5" cy="15.5" r="4.2"/><path d="M4 4l8.5 8.5"/>',
  tag: '<path d="M4 12.6V5.5A1.5 1.5 0 0 1 5.5 4h7.1l7.4 7.4a1.5 1.5 0 0 1 0 2.1l-6 6a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8.5" cy="8.5" r="1.3"/>',
  combo: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="8.5" y="13.5" width="7" height="7" rx="1.5"/>',
  note: '<path d="M6.5 3.5h7.5l4.5 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-10.5A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M13.5 3.5V8.5h5M8.5 12.5h7M8.5 16h5"/>',
  preset: '<path d="M4.5 7h9M17.5 7h2M4.5 12h3M11.5 12h8M4.5 17h11M19.5 17h0"/><circle cx="15.5" cy="7" r="2"/><circle cx="9.5" cy="12" r="2"/><circle cx="17.5" cy="17" r="2"/>',
  artist: '<path d="M12 20.5a8.5 8.5 0 1 1 8.5-8.5c0 2.4-1.8 3.3-3.5 3.3h-1.8a1.8 1.8 0 0 0-1.2 3.1c.6.6.3 2.1-2 2.1z"/><circle cx="7.8" cy="11" r="1" fill="currentColor"/><circle cx="10.5" cy="7.2" r="1" fill="currentColor"/><circle cx="15" cy="7.8" r="1" fill="currentColor"/>',
  imported: '<path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5M12 11v6M9.5 14.5L12 17l2.5-2.5"/>',
  history: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.5-4.5-8 8"/>',
  collection: '<path d="M6 3.5h12a1.5 1.5 0 0 1 1.5 1.5v15.5L12 16l-7.5 4.5V5A1.5 1.5 0 0 1 6 3.5z"/>',
  group: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  palette: '<path d="M12 20.5a8.5 8.5 0 1 1 8.5-8.5c0 2.4-1.8 3.3-3.5 3.3h-1.8a1.8 1.8 0 0 0-1.2 3.1c.6.6.3 2.1-2 2.1z"/><circle cx="7.8" cy="11" r="1" fill="currentColor"/><circle cx="10.5" cy="7.2" r="1" fill="currentColor"/><circle cx="15" cy="7.8" r="1" fill="currentColor"/>',
  drive: '<rect x="3.5" y="13" width="17" height="6.5" rx="2"/><path d="M5 13l2.5-7.5h9L19 13"/><circle cx="16.5" cy="16.2" r=".8" fill="currentColor"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>',
  external: '<path d="M13.5 4.5h6v6M19.5 4.5L11 13"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  undo: '<path d="M8.5 6.5L4.5 10.5l4 4"/><path d="M4.5 10.5h10a5 5 0 0 1 0 10H12"/>',
  compare: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M12 3v18"/>',
  fit: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>',
  wand: '<path d="M4.5 19.5l10-10M13 5.5l1.5-1M17 9.5l1.5-1M17 5l.5-1.5M18.5 13l1.5.5"/><path d="M12.5 7.5l4 4"/>',
  bolt: '<path d="M13 3.5L5.5 13.5H12l-1 7 7.5-10H12z"/>',
  activity: '<path d="M3.5 12h3.5l2.5-6 5 12 2.5-6h3.5"/>',
  selectbox: '<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12.2l2.5 2.5 4.5-5"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5"/><path d="M5 9v9.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4"/>',
  terminal: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>',
  minimize: '<path d="M6 12h12"/>',
  maximize: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  // Added for the client (not in the prototype set).
  edit: '<path d="M4.5 19.5l.9-4.1L15.6 5.2a1.9 1.9 0 0 1 2.7 0l.5.5a1.9 1.9 0 0 1 0 2.7L8.6 18.6z"/><path d="M13.6 7.2l3.2 3.2"/>',
  expand: '<path d="M14.5 4.5h5v5M19.5 4.5l-5.2 5.2M9.5 19.5h-5v-5M4.5 19.5l5.2-5.2M4.5 9.5v-5h5M4.5 4.5l5.2 5.2M19.5 14.5v5h-5M19.5 19.5l-5.2-5.2"/>',
  // The censored JPG export (src/censor).
  mosaic: '<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/><path d="M9.3 4h5.4v5.3H9.3zM4 9.3h5.3v5.4H4zM14.7 9.3H20v5.4h-5.3zM9.3 14.7h5.4V20H9.3z" fill="currentColor" stroke="none" opacity=".55"/>',
  lasso: '<ellipse cx="12" cy="9.5" rx="8" ry="5.5"/><path d="M7.6 14.1c-1.7 1-2 2.9-.3 3.6 1.7.6 2.6 1.5 1.2 3.3"/>',
  redo: '<path d="M15.5 6.5l4 4-4 4"/><path d="M19.5 10.5h-10a5 5 0 0 0 0 10H12"/>',
} as const;

export type IconName = keyof typeof ICON_BODIES;
export const ICON_NAMES: readonly IconName[] = Object.freeze(Object.keys(ICON_BODIES) as IconName[]);

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  /** When set, the icon is exposed to assistive technology with this label. */
  title?: string;
}

export function Icon({ name, size = 16, className, title }: IconProps) {
  const a11y = title
    ? { role: 'img' as const, 'aria-label': title }
    : { 'aria-hidden': true as const };
  return (
    <svg
      className={className ? `ui-glyph ${className}` : 'ui-glyph'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...a11y}
      dangerouslySetInnerHTML={{ __html: ICON_BODIES[name] }}
    />
  );
}

export interface BrandMarkProps {
  size: number;
  /** Full app icon: dark rounded square plus the cyan plug. */
  full?: boolean;
  className?: string;
}

/** Purple-to-cyan four-pointed star; the full variant is the app icon. */
export function BrandMark({ size, full = false, className }: BrandMarkProps) {
  const gradientId = `ui-bm-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg
      className={className ? `ui-brandmark ${className}` : 'ui-brandmark'}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      {full ? <rect width="512" height="512" rx="116" fill="#13111d" /> : null}
      <path
        d="M242 88 C275 205 275 205 392 238 C275 271 275 271 242 388 C209 271 209 271 92 238 C209 205 209 205 242 88Z"
        fill={`url(#${gradientId})`}
      />
      {full ? (
        <>
          <path d="M330 330 L378 378" stroke="#22d3ee" strokeWidth="26" strokeLinecap="round" />
          <circle cx="392" cy="392" r="34" fill="none" stroke="#22d3ee" strokeWidth="22" />
        </>
      ) : null}
    </svg>
  );
}
