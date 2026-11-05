/// <reference types="node" />

// Small CSS reader for source-level regression tests (node environment, no DOM).
//
// It flattens every client stylesheet into style rules and @keyframes, and answers
// "can this selector match this element?" for a hand-modelled DOM path. Matching is
// three-valued: user-action states (:hover, :focus...), structural pseudo-classes,
// :has() and sibling combinators are not modelled and come back as MAYBE, so a test
// can tell rules that certainly apply from rules that only might.
//
// It is not a CSS engine. There is no cascade ordering between files, so a test should
// only rely on !important declarations or on the absence of a matching rule.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type Declaration = { property: string; value: string; important: boolean };
export type StyleRule = {
  kind: "style";
  file: string;
  line: number;
  selectors: string[];
  declarations: Declaration[];
};
export type KeyframesRule = {
  kind: "keyframes";
  file: string;
  line: number;
  name: string;
  frames: { selector: string; declarations: Declaration[] }[];
};
export type CssRule = StyleRule | KeyframesRule;

/** One element of a modelled DOM path. `null` attribute value: present, value unknown. */
export type ModelElement = {
  tag: string;
  id?: string;
  classes: string[];
  attributes: Record<string, string | null>;
};
export type PseudoElement = "before" | "after" | null;

export const NO = 0;
export const MAYBE = 1;
export const YES = 2;
export type Match = typeof NO | typeof MAYBE | typeof YES;

// ── Reading ───────────────────────────────────────────────────────────────────

/** Every *.css file under `<clientRoot>/src`, sorted, with paths relative to clientRoot. */
export function readClientStylesheets(clientRoot = process.cwd()): { file: string; css: string }[] {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(full);
    return entry.name.endsWith(".css") ? [full] : [];
  });
  return walk(join(clientRoot, "src"))
    .sort()
    .map((full) => ({ file: relative(clientRoot, full).split(sep).join("/"), css: readFileSync(full, "utf8") }));
}

export function readClientRules(clientRoot = process.cwd()): CssRule[] {
  return readClientStylesheets(clientRoot).flatMap(({ file, css }) => parseStylesheet(css, file));
}

/** Replaces comments with spaces of the same shape, so offsets and line numbers survive. */
function blankComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/** Index of the bracket that closes the one opened at `open` (quote-aware). */
function matchingBracket(text: string, open: number, opening: string, closing: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === opening) depth += 1;
    else if (ch === closing) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`Unbalanced "${opening}" at ${open} in ${JSON.stringify(text.slice(open, open + 80))}`);
}

/** Split on a separator that is not inside parentheses, brackets or quotes. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseDeclarations(body: string): Declaration[] {
  return splitTopLevel(body, ";").flatMap((entry) => {
    const colon = entry.indexOf(":");
    if (colon < 0) return [];
    const property = entry.slice(0, colon).trim();
    let value = entry.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, "").trim();
    // Custom property names are case-sensitive; everything else is not.
    return [{ property: property.startsWith("--") ? property : property.toLowerCase(), value, important }];
  });
}

export function normalizeSelector(selector: string): string {
  return selector.replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim();
}

/** Flattens style rules and @keyframes from every nesting level (@media, @supports, ...). */
export function parseStylesheet(source: string, file = "<inline>"): CssRule[] {
  const css = blankComments(source);
  const lineStarts = [0];
  for (let i = 0; i < css.length; i += 1) if (css[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const rules: CssRule[] = [];
  const walk = (from: number, to: number) => {
    let cursor = from;
    while (cursor < to) {
      const open = css.indexOf("{", cursor);
      if (open < 0 || open >= to) break;
      // A prelude starts after the previous block end or a bodiless at-rule (@import ...;).
      const rawPrelude = css.slice(cursor, open);
      const lastSemicolon = rawPrelude.lastIndexOf(";");
      const preludeStart = cursor + lastSemicolon + 1;
      const prelude = css.slice(preludeStart, open).trim();
      const line = lineAt(preludeStart + (css.slice(preludeStart, open).length - css.slice(preludeStart, open).trimStart().length));
      const close = matchingBracket(css, open, "{", "}");
      const body = css.slice(open + 1, close);
      const keyframes = prelude.match(/^@(?:-webkit-)?keyframes\s+([^\s{]+)/i);
      if (keyframes) {
        const frames: KeyframesRule["frames"] = [];
        let inner = 0;
        while (inner < body.length) {
          const frameOpen = body.indexOf("{", inner);
          if (frameOpen < 0) break;
          const frameClose = matchingBracket(body, frameOpen, "{", "}");
          frames.push({
            selector: body.slice(inner, frameOpen).trim(),
            declarations: parseDeclarations(body.slice(frameOpen + 1, frameClose)),
          });
          inner = frameClose + 1;
        }
        rules.push({ kind: "keyframes", file, line, name: keyframes[1], frames });
      } else if (prelude.startsWith("@")) {
        walk(open + 1, close);
      } else {
        rules.push({
          kind: "style",
          file,
          line,
          selectors: splitTopLevel(prelude, ",").map(normalizeSelector),
          declarations: parseDeclarations(body),
        });
      }
      cursor = close + 1;
    }
  };
  walk(0, css.length);
  return rules;
}

export function styleRulesOf(rules: CssRule[]): StyleRule[] {
  return rules.filter((rule): rule is StyleRule => rule.kind === "style");
}

// ── Modelled elements ─────────────────────────────────────────────────────────

/** `el("div.workspace#main", { "data-page": "true" })` → a modelled element. */
export function el(spec: string, attributes: Record<string, string | null> = {}): ModelElement {
  const match = /^([a-z][\w-]*)((?:[.#][\w-]+)*)$/i.exec(spec);
  if (!match) throw new Error(`Bad element spec "${spec}"`);
  const parts = match[2].match(/[.#][\w-]+/g) ?? [];
  const id = parts.find((part) => part.startsWith("#"))?.slice(1);
  return {
    tag: match[1].toLowerCase(),
    ...(id ? { id } : {}),
    classes: parts.filter((part) => part.startsWith(".")).map((part) => part.slice(1)),
    attributes,
  };
}

export function describePath(path: ModelElement[], pseudo: PseudoElement = null): string {
  const describe = (element: ModelElement) => {
    const attributes = Object.entries(element.attributes)
      .map(([name, value]) => (value === null ? `[${name}]` : `[${name}="${value}"]`))
      .join("");
    return `${element.tag}${element.id ? `#${element.id}` : ""}${element.classes.map((name) => `.${name}`).join("")}${attributes}`;
  };
  return path.map(describe).join(" > ") + (pseudo ? `::${pseudo}` : "");
}

// ── Selector matching ─────────────────────────────────────────────────────────

type Combinator = " " | ">" | "+" | "~";
type Simple =
  | { kind: "type"; name: string }
  | { kind: "id"; name: string }
  | { kind: "class"; name: string }
  | { kind: "attr"; name: string; operator: string | null; value: string | null; insensitive: boolean }
  | { kind: "pseudo"; name: string; argument: string | null };
type Compound = { simple: Simple[]; pseudoElement: string | null };
type Complex = { compounds: Compound[]; combinators: Combinator[] };

const LEGACY_PSEUDO_ELEMENTS = new Set(["before", "after", "first-line", "first-letter"]);
const IDENT = String.raw`(?:\\.|[\w\u00a0-\uffff-])+`;
const unescapeIdent = (text: string) => text.replace(/\\(.)/g, "$1");

function splitComplex(selector: string): { compounds: string[]; combinators: Combinator[] } {
  const compounds: string[] = [];
  const combinators: Combinator[] = [];
  let current = "";
  let pending: Combinator | null = null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < selector.length; i += 1) {
    const ch = selector[i];
    if (quote) {
      current += ch;
      if (ch === "\\") current += selector[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (depth === 0 && (/\s/.test(ch) || ch === ">" || ch === "+" || ch === "~")) {
      if (current) {
        compounds.push(current);
        current = "";
      }
      if (ch === ">" || ch === "+" || ch === "~") pending = ch;
      else if (pending === null) pending = " ";
      continue;
    }
    if (current === "" && compounds.length > 0) {
      combinators.push(pending ?? " ");
    }
    if (current === "") pending = null;
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    current += ch;
  }
  if (current) compounds.push(current);
  return { compounds, combinators };
}

function parseCompound(text: string): Compound {
  const simple: Simple[] = [];
  let pseudoElement: string | null = null;
  let i = 0;
  const type = /^(\*|[a-z][\w-]*)/i.exec(text);
  if (type) {
    simple.push({ kind: "type", name: type[1].toLowerCase() });
    i = type[1].length;
  }
  while (i < text.length) {
    const rest = text.slice(i);
    const ch = text[i];
    if (ch === "." || ch === "#") {
      const match = new RegExp(`^[.#](${IDENT})`).exec(rest);
      if (!match) throw new Error(`Unsupported selector syntax in "${text}"`);
      simple.push({ kind: ch === "." ? "class" : "id", name: unescapeIdent(match[1]) });
      i += match[0].length;
    } else if (ch === "[") {
      const end = matchingBracket(text, i, "[", "]");
      const inner = text.slice(i + 1, end).trim();
      const match = /^([\w-]+)\s*(?:([~|^$*]?=)\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s\]]+))\s*([is])?)?$/i.exec(inner);
      if (!match) throw new Error(`Unsupported attribute selector in "${text}"`);
      simple.push({
        kind: "attr",
        name: match[1].toLowerCase(),
        operator: match[2] ?? null,
        value: match[2] ? (match[3] ?? match[4] ?? match[5] ?? "") : null,
        insensitive: (match[6] ?? "").toLowerCase() === "i",
      });
      i = end + 1;
    } else if (ch === ":") {
      const isElement = text[i + 1] === ":";
      const start = i + (isElement ? 2 : 1);
      const name = /^-?[\w-]+/.exec(text.slice(start))?.[0];
      if (!name) throw new Error(`Unsupported pseudo selector in "${text}"`);
      let next = start + name.length;
      let argument: string | null = null;
      if (text[next] === "(") {
        const end = matchingBracket(text, next, "(", ")");
        argument = text.slice(next + 1, end);
        next = end + 1;
      }
      const lower = name.toLowerCase();
      if (isElement || LEGACY_PSEUDO_ELEMENTS.has(lower)) pseudoElement = lower;
      else simple.push({ kind: "pseudo", name: lower, argument });
      i = next;
    } else {
      throw new Error(`Unsupported selector syntax in "${text}"`);
    }
  }
  return { simple, pseudoElement };
}

const complexCache = new Map<string, Complex>();
function parseComplex(selector: string): Complex {
  const cached = complexCache.get(selector);
  if (cached) return cached;
  const { compounds, combinators } = splitComplex(selector.trim());
  if (compounds.length === 0) throw new Error(`Empty selector "${selector}"`);
  const parsed = { compounds: compounds.map(parseCompound), combinators };
  complexCache.set(selector, parsed);
  return parsed;
}

const and = (a: Match, b: Match): Match => (a < b ? a : b);
const or = (a: Match, b: Match): Match => (a > b ? a : b);
const not = (a: Match): Match => (a === YES ? NO : a === NO ? YES : MAYBE);

function attributeValue(element: ModelElement, name: string): string | null | undefined {
  if (name === "class") return element.classes.length > 0 ? element.classes.join(" ") : element.attributes.class;
  if (name === "id") return element.id ?? element.attributes.id;
  return element.attributes[name];
}

function matchAttribute(simple: Extract<Simple, { kind: "attr" }>, element: ModelElement): Match {
  const actual = attributeValue(element, simple.name);
  if (actual === undefined) return NO;
  if (simple.operator === null) return YES;
  if (actual === null) return MAYBE;
  const fold = (value: string) => (simple.insensitive ? value.toLowerCase() : value);
  const have = fold(actual);
  const want = fold(simple.value ?? "");
  switch (simple.operator) {
    case "=": return have === want ? YES : NO;
    case "~=": return have.split(/\s+/).includes(want) ? YES : NO;
    case "|=": return have === want || have.startsWith(`${want}-`) ? YES : NO;
    case "^=": return want !== "" && have.startsWith(want) ? YES : NO;
    case "$=": return want !== "" && have.endsWith(want) ? YES : NO;
    case "*=": return want !== "" && have.includes(want) ? YES : NO;
    default: return MAYBE;
  }
}

function matchSelectorList(list: string, path: ModelElement[], index: number): Match {
  return splitTopLevel(list, ",").reduce<Match>((best, selector) => or(best, matchComplexAt(parseComplex(selector), path, index, null)), NO);
}

function matchCompound(compound: Compound, path: ModelElement[], index: number): Match {
  const element = path[index];
  let result: Match = YES;
  for (const simple of compound.simple) {
    let current: Match;
    switch (simple.kind) {
      case "type":
        current = simple.name === "*" || simple.name === element.tag ? YES : NO;
        break;
      case "class":
        current = element.classes.includes(simple.name) ? YES : NO;
        break;
      case "id":
        current = element.id === simple.name ? YES : NO;
        break;
      case "attr":
        current = matchAttribute(simple, element);
        break;
      case "pseudo":
        if (simple.name === "root" || simple.name === "scope") current = index === 0 ? YES : NO;
        else if (simple.name === "not") current = not(matchSelectorList(simple.argument ?? "", path, index));
        else if (["is", "where", "matches", "-webkit-any"].includes(simple.name)) current = matchSelectorList(simple.argument ?? "", path, index);
        // User-action, form, structural and relational states are not modelled.
        else current = MAYBE;
        break;
    }
    result = and(result, current);
    if (result === NO) return NO;
  }
  return result;
}

/** Can the compounds left of `k` match, given that compound k + 1 matched path[index]? */
function matchLeft(complex: Complex, k: number, path: ModelElement[], index: number): Match {
  if (k < 0) return YES;
  const compound = complex.compounds[k];
  if (compound.pseudoElement) return NO;
  switch (complex.combinators[k]) {
    case ">": {
      const parent = index - 1;
      if (parent < 0) return NO;
      return and(matchCompound(compound, path, parent), matchLeft(complex, k - 1, path, parent));
    }
    case " ": {
      let best: Match = NO;
      for (let ancestor = index - 1; ancestor >= 0 && best !== YES; ancestor -= 1) {
        const here = matchCompound(compound, path, ancestor);
        if (here !== NO) best = or(best, and(here, matchLeft(complex, k - 1, path, ancestor)));
      }
      return best;
    }
    default:
      // Siblings are not modelled: one might exist, and it shares path[index]'s ancestors.
      return and(MAYBE, matchLeft(complex, k - 1, path, index));
  }
}

function matchComplexAt(complex: Complex, path: ModelElement[], index: number, pseudo: PseudoElement): Match {
  const last = complex.compounds.length - 1;
  const subject = complex.compounds[last];
  if ((subject.pseudoElement ?? null) !== pseudo) return NO;
  const here = matchCompound(subject, path, index);
  if (here === NO) return NO;
  return and(here, matchLeft(complex, last - 1, path, index));
}

/** Whether `selector` matches the last element of `path` (or its ::before / ::after). */
export function matchSelector(selector: string, path: ModelElement[], pseudo: PseudoElement = null): Match {
  if (path.length === 0) throw new Error("Empty element path");
  return matchComplexAt(parseComplex(selector), path, path.length - 1, pseudo);
}

/** Style rules with at least one selector that can match (YES or MAYBE) the target. */
export function rulesMatching(
  rules: StyleRule[],
  path: ModelElement[],
  pseudo: PseudoElement = null,
): { rule: StyleRule; selector: string; match: Match }[] {
  return rules.flatMap((rule) => {
    let best: { selector: string; match: Match } | null = null;
    for (const selector of rule.selectors) {
      const match = matchSelector(selector, path, pseudo);
      if (match !== NO && (!best || match > best.match)) best = { selector, match };
      if (best?.match === YES) break;
    }
    return best ? [{ rule, ...best }] : [];
  });
}

// ── Animation values ──────────────────────────────────────────────────────────

const ANIMATION_KEYWORDS = new Set([
  "ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end",
  "infinite", "normal", "reverse", "alternate", "alternate-reverse",
  "none", "forwards", "backwards", "both", "running", "paused",
  "initial", "inherit", "unset", "revert", "revert-layer", "auto",
]);

/** Animation names referenced by an `animation` / `animation-name` value (var() already resolved). */
export function animationNames(property: string, value: string): string[] {
  return splitTopLevel(value, ",").flatMap((single) => {
    if (property === "animation-name") return ANIMATION_KEYWORDS.has(single.toLowerCase()) ? [] : [single];
    const tokens = single.match(/[\w-]+\([^)]*\)|[^\s]+/g) ?? [];
    return tokens.filter((token) => (
      !ANIMATION_KEYWORDS.has(token.toLowerCase())
      && !/\(/.test(token)
      && !/^-?[\d.]+(?:m?s)?$/i.test(token)
    ));
  });
}

/** Every value any rule assigns to each custom property, for conservative var() expansion. */
export function customPropertyValues(rules: StyleRule[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const rule of rules) {
    for (const declaration of rule.declarations) {
      if (!declaration.property.startsWith("--")) continue;
      values.set(declaration.property, [...(values.get(declaration.property) ?? []), declaration.value]);
    }
  }
  return values;
}

/**
 * Replaces each var(--x, fallback) with every value --x is given anywhere (plus the
 * fallback), so a keyword such as `infinite` hidden behind a variable is still seen.
 * `unresolved` lists variables that are never defined and have no fallback.
 */
export function expandVariables(value: string, variables: Map<string, string[]>): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  let current = value;
  for (let round = 0; round < 8 && /var\(/i.test(current); round += 1) {
    current = current.replace(/var\(\s*(--[\w-]+)\s*(?:,([^()]*(?:\([^()]*\)[^()]*)*))?\)/gi, (_, name: string, fallback?: string) => {
      const defined = variables.get(name) ?? [];
      if (defined.length === 0 && fallback === undefined) unresolved.push(name);
      return [...defined, ...(fallback === undefined ? [] : [fallback.trim()])].join(" ");
    });
  }
  return { value: current, unresolved };
}
