/**
 * Placeholder "illustrations" for UI capture runs: deterministic SVG scenes (no network, no real images).
 * A port of the step-4 prototype's art.js (same themes, random generator and drawing order), without window/document.
 */
export type ArtTheme = 'cafe' | 'night' | 'library' | 'rain' | 'beach' | 'forest' | 'sakura' | 'studio';

interface ThemePalette { sky: [string, string]; glow: string; ground: string; hair: string[]; cloth: string[]; deco: 'window' | 'city' | 'shelves' | 'rain' | 'sun' | 'trees' | 'petals' | 'none' }

const THEMES: Record<ArtTheme, ThemePalette> = {
  cafe:    { sky: ['#3b2a22', '#8a5a3c'], glow: '#ffcf8a', ground: '#2a1d17', hair: ['#6b3f2a', '#3a2418', '#c98b5a'], cloth: ['#f3e6d2', '#5b4636', '#b7795a'], deco: 'window' },
  night:   { sky: ['#0c1030', '#3b2a6b'], glow: '#7dd3fc', ground: '#0a0b1c', hair: ['#141428', '#e8e8f0', '#6a5acd'], cloth: ['#1f2a4a', '#e6e9f2', '#3c2f6b'], deco: 'city' },
  library: { sky: ['#2c3a36', '#9bb3a0'], glow: '#fff1c4', ground: '#243029', hair: ['#d8b46a', '#4a3424', '#2b2b2b'], cloth: ['#c7d6cf', '#7a5c3e', '#40625a'], deco: 'shelves' },
  rain:    { sky: ['#0d0f1a', '#36204a'], glow: '#ff5fa2', ground: '#120d18', hair: ['#f1f1f6', '#1b1b2b', '#8bd3ff'], cloth: ['#24304a', '#4b2a4a', '#1a1a24'], deco: 'rain' },
  beach:   { sky: ['#f59e6b', '#7c6fd6'], glow: '#ffe1a8', ground: '#3a6ea5', hair: ['#f2d27a', '#3a2a2a', '#e86f6f'], cloth: ['#ffffff', '#ffd3e0', '#9bd1ff'], deco: 'sun' },
  forest:  { sky: ['#0f2a24', '#3f7a5c'], glow: '#b8ffcf', ground: '#0b1f1a', hair: ['#e9f5ea', '#2d4a2a', '#d6b25a'], cloth: ['#3f6a4a', '#e0f0e6', '#24443a'], deco: 'trees' },
  sakura:  { sky: ['#f7c6d9', '#a5b8f0'], glow: '#fff4f8', ground: '#c98aa8', hair: ['#f6a5c0', '#2a2238', '#fff1f6'], cloth: ['#ffffff', '#2f3e6e', '#f2b6c8'], deco: 'petals' },
  studio:  { sky: ['#1b1b22', '#3a3a48'], glow: '#c4b5fd', ground: '#16161c', hair: ['#c4b5fd', '#1b1b1b', '#f5d0a9'], cloth: ['#e5e5ee', '#2a2a34', '#8b5cf6'], deco: 'none' },
};

export const ART_THEMES: readonly ArtTheme[] = Object.keys(THEMES) as ArtTheme[];

/** mulberry32, as in art.js. */
function rng(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scene(seed: number, W: number, H: number, theme: ArtTheme): string {
  const r = rng(seed * 7919 + 13);
  const P = THEMES[theme] ?? THEMES[ART_THEMES[seed % ART_THEMES.length]];
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)];
  const hair = pick(P.hair), cloth = pick(P.cloth);
  const id = 's' + seed;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">`;
  s += `<defs><linearGradient id="${id}b" x1="0" y1="0" x2="${r() > .5 ? 1 : 0.3}" y2="1"><stop offset="0" stop-color="${P.sky[0]}"/><stop offset="1" stop-color="${P.sky[1]}"/></linearGradient>`;
  s += `<radialGradient id="${id}g" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${P.glow}" stop-opacity=".75"/><stop offset="1" stop-color="${P.glow}" stop-opacity="0"/></radialGradient>`;
  s += `<linearGradient id="${id}f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></linearGradient></defs>`;
  s += `<rect width="${W}" height="${H}" fill="url(#${id}b)"/>`;
  const gx = W * (0.2 + r() * 0.6), gy = H * (0.15 + r() * 0.3), gr = Math.max(W, H) * (0.35 + r() * 0.25);
  s += `<circle cx="${gx}" cy="${gy}" r="${gr}" fill="url(#${id}g)"/>`;
  // Decorations
  if (P.deco === 'window') {
    const wx = W * (0.08 + r() * 0.2), wy = H * 0.1, ww = W * 0.45, wh = H * 0.38;
    s += `<rect x="${wx}" y="${wy}" width="${ww}" height="${wh}" rx="4" fill="${P.glow}" opacity=".22"/>`;
    s += `<path d="M${wx + ww / 2} ${wy}V${wy + wh}M${wx} ${wy + wh / 2}H${wx + ww}" stroke="${P.sky[0]}" stroke-width="${W * 0.012}" opacity=".7"/>`;
  } else if (P.deco === 'city') {
    let x = 0;
    while (x < W) {
      const bw = W * (0.06 + r() * 0.1), bh = H * (0.12 + r() * 0.28);
      s += `<rect x="${x}" y="${H * 0.72 - bh}" width="${bw}" height="${bh + H}" fill="#0a0a1e" opacity=".85"/>`;
      for (let k = 0; k < 6; k++) if (r() > .45) s += `<rect x="${x + r() * bw * .8}" y="${H * 0.72 - bh + r() * bh}" width="${W * .008}" height="${W * .01}" fill="${P.glow}" opacity=".8"/>`;
      x += bw + W * 0.01;
    }
    for (let k = 0; k < 18; k++) s += `<circle cx="${r() * W}" cy="${r() * H * 0.45}" r="${W * 0.004 + r() * W * 0.004}" fill="#fff" opacity="${0.4 + r() * .5}"/>`;
  } else if (P.deco === 'shelves') {
    for (let row = 0; row < 4; row++) {
      const y = H * (0.12 + row * 0.15);
      s += `<rect x="0" y="${y}" width="${W}" height="${H * 0.012}" fill="#2a1f16" opacity=".5"/>`;
      let x = W * 0.02;
      while (x < W) {
        const bw = W * (0.02 + r() * 0.025);
        s += `<rect x="${x}" y="${y - H * (0.07 + r() * 0.04)}" width="${bw}" height="${H * 0.12}" fill="${pick(['#7a4a3a', '#3f5a6a', '#6a6a3a', '#5a3a5a', '#c9a96a'])}" opacity=".55"/>`;
        x += bw + W * 0.004;
      }
    }
  } else if (P.deco === 'rain') {
    for (let k = 0; k < 40; k++) { const x = r() * W, y = r() * H; s += `<path d="M${x} ${y}l${-W * 0.01} ${H * 0.05}" stroke="#bcd6ff" stroke-width="${W * 0.003}" opacity=".35"/>`; }
    s += `<rect x="${W * 0.7}" y="${H * 0.18}" width="${W * 0.22}" height="${H * 0.06}" rx="3" fill="${P.glow}" opacity=".55"/>`;
  } else if (P.deco === 'sun') {
    s += `<circle cx="${W * 0.72}" cy="${H * 0.52}" r="${W * 0.14}" fill="#fff1c9" opacity=".85"/>`;
    s += `<rect x="0" y="${H * 0.58}" width="${W}" height="${H}" fill="${P.ground}" opacity=".85"/>`;
    for (let k = 0; k < 7; k++) s += `<rect x="${r() * W}" y="${H * (0.6 + r() * 0.2)}" width="${W * (0.1 + r() * 0.2)}" height="${H * 0.005}" fill="#fff" opacity=".45"/>`;
  } else if (P.deco === 'trees') {
    for (let k = 0; k < 7; k++) { const x = r() * W, tw = W * (0.12 + r() * 0.12); s += `<path d="M${x} ${H * 0.2 + r() * H * 0.2}l${tw / 2} ${H * 0.55}h${-tw}z" fill="#08201a" opacity="${0.5 + r() * .4}"/>`; }
    for (let k = 0; k < 22; k++) s += `<circle cx="${r() * W}" cy="${r() * H}" r="${W * 0.006}" fill="${P.glow}" opacity="${0.3 + r() * .6}"/>`;
  } else if (P.deco === 'petals') {
    for (let k = 0; k < 26; k++) s += `<ellipse cx="${r() * W}" cy="${r() * H}" rx="${W * 0.012}" ry="${W * 0.007}" transform="rotate(${r() * 180} ${r() * W} ${r() * H})" fill="#fff" opacity="${0.4 + r() * .5}"/>`;
  }
  if (P.deco !== 'sun') s += `<rect x="0" y="${H * (0.74 + r() * 0.06)}" width="${W}" height="${H}" fill="${P.ground}" opacity=".7"/>`;
  // Figure (abstract, faceless)
  const cx = W * (0.38 + r() * 0.24), headR = Math.min(W, H) * (0.085 + r() * 0.03), cy = H * (0.36 + r() * 0.1);
  const skin = pick(['#f6dcc8', '#f1d2bd', '#ffe6d6', '#eac3a6']);
  const hl = headR * (1.6 + r() * 1.6);
  s += `<path d="M${cx - headR * 1.25} ${cy - headR * .2} Q${cx - headR * 1.5} ${cy + hl} ${cx - headR * .9} ${cy + hl * 1.05} L${cx + headR * .9} ${cy + hl * 1.05} Q${cx + headR * 1.5} ${cy + hl} ${cx + headR * 1.25} ${cy - headR * .2} Z" fill="${hair}"/>`;
  const sw = headR * (2.3 + r() * .6), top = cy + headR * 1.05;
  s += `<path d="M${cx - headR * .35} ${top - headR * .2} h${headR * .7} v${headR * .45} h${-headR * .7}z" fill="${skin}"/>`;
  s += `<path d="M${cx - sw / 2} ${H} L${cx - sw * .42} ${top + headR * .4} Q${cx} ${top + headR * .05} ${cx + sw * .42} ${top + headR * .4} L${cx + sw / 2} ${H} Z" fill="${cloth}"/>`;
  s += `<path d="M${cx - sw * .1} ${top + headR * .2} L${cx} ${top + headR * .75} L${cx + sw * .1} ${top + headR * .2}" fill="none" stroke="${hair}" stroke-width="${headR * .08}" opacity=".5"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${headR}" fill="${skin}"/>`;
  s += `<path d="M${cx - headR * 1.08} ${cy + headR * .1} Q${cx - headR * 1.1} ${cy - headR * 1.25} ${cx} ${cy - headR * 1.18} Q${cx + headR * 1.15} ${cy - headR * 1.2} ${cx + headR * 1.08} ${cy + headR * .15} Q${cx + headR * .5} ${cy - headR * .55} ${cx - headR * .2} ${cy - headR * .35} Q${cx - headR * .7} ${cy - headR * .2} ${cx - headR * 1.08} ${cy + headR * .1}Z" fill="${hair}"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="${headR * 1.02}" fill="none" stroke="${P.glow}" stroke-width="${headR * 0.05}" opacity=".45"/>`;
  // Sparkles
  for (let k = 0; k < 4; k++) {
    const x = r() * W, y = r() * H * 0.6, z = W * (0.01 + r() * 0.015);
    s += `<path d="M${x} ${y - z}Q${x} ${y} ${x + z} ${y}Q${x} ${y} ${x} ${y + z}Q${x} ${y} ${x - z} ${y}Q${x} ${y} ${x} ${y - z}Z" fill="#fff" opacity="${0.5 + r() * .4}"/>`;
  }
  s += `<rect width="${W}" height="${H}" fill="url(#${id}f)"/></svg>`;
  return s;
}

/** The raw SVG text of a scene (drawn at 1/4 of width × height, like art.js). */
export function captureArtSvg(seed: number, width: number, height: number, theme: ArtTheme): string {
  return scene(seed, Math.max(1, Math.round(width / 4)), Math.max(1, Math.round(height / 4)), theme);
}

const cache = new Map<string, string>();
/** data:image/svg+xml URL of the deterministic scene; width/height in px (drawn at 1/4 size like art.js). */
export function captureArt(seed: number, width: number, height: number, theme: ArtTheme): string {
  const W = Math.max(1, Math.round(width / 4)), H = Math.max(1, Math.round(height / 4));
  const key = seed + ':' + W + 'x' + H + ':' + theme;
  let url = cache.get(key);
  if (!url) { url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(scene(seed, W, H, theme)); cache.set(key, url); }
  return url;
}
