/// <reference types="node" />

import { describe, expect, it } from "vitest";
import {
  NO,
  YES,
  animationNames,
  describePath,
  el,
  readClientRules,
  rulesMatching,
  styleRulesOf,
  type Match,
  type ModelElement,
  type PseudoElement,
} from "./test-support/css-source";

// Retained views are hidden with visibility/opacity rather than unmounted. CSS
// animations inside them keep running, and inside a visibility:hidden subtree they
// cannot run on the compositor, so the renderer restyles them on every display frame
// while nothing is visible (measured with the old queue panel's spinner; step 4c2 removed
// the old workbench, so the scenarios below are the new frame's pages and the canvas stage).
// Every descendant animation (pseudo-elements included) must be paused while its
// container is hidden, and must run again when it is shown.

const styleRules = styleRulesOf(readClientRules());
const PSEUDOS: PseudoElement[] = [null, "before", "after"];

/** The new frame (step 4b1): pages stay mounted and laid out; the ones not shown are visibility:hidden. */
const framePage = (active: boolean, page: "library" | "canvas"): ModelElement[] => [
  el("html", { lang: null }), el("body"), el("div#root"), el("div.as-shell"), el("main.as-pages"),
  el(`section.as-page${active ? ".is-active" : ""}`, active ? { "data-page": page } : { "data-page": page, "aria-hidden": "true", inert: "" }),
  ...(page === "library" ? [el("div.ui-scope.lib"), el("div.lib-main"), el("p.lib-wait"), el("span.ui-spinner")] : [el("div.as-canvas-page"), el("div.ui-scope.cv-page"), el("section.cv-stage"), el("div.cv-gen.is-waiting", { "aria-live": "polite" }), el("div.cv-gen-wait"), el("span.cv-spinner")]),
];

/** The rebuilt canvas (step 4b3): its stage keeps Inpaint's viewport mounted beside the image one. Since 4b3c nothing
 * covers the canvas page (the metadata and reference preset pages are gone). */
const canvasViewport = (hidden: boolean): ModelElement[] => [
  el("html", { lang: null }), el("body"), el("div#root"), el("div.as-shell"), el("main.as-pages"), el("section.as-page.is-active", { "data-page": "canvas" }),
  el("div.as-canvas-page"), el("div.ui-scope.cv-page"), el("section.cv-stage"), el("div.cv-vhost"),
  el(`div.cv-viewport${hidden ? ".is-hidden" : ""}`, hidden ? { "aria-hidden": "true", inert: "" } : {}),
  el("div.cv-gen.is-waiting", { "aria-live": "polite" }), el("div.cv-gen-wait"), el("span.cv-spinner"),
];

/** container: the selector in the stylesheet that hides it (see the inventory test). */
const SCENARIOS: { name: string; container: string; hidden: ModelElement[]; shown: ModelElement[] }[] = [
  {
    name: "another page of the frame open: the library's spinner",
    container: ".as-page",
    hidden: framePage(false, "library"),
    shown: framePage(true, "library"),
  },
  {
    name: "another page of the frame open: a spinner on the canvas page",
    container: ".as-page",
    hidden: framePage(false, "canvas"),
    shown: framePage(true, "canvas"),
  },
  {
    name: "inpaint mode: the image viewport of the canvas stage underneath",
    container: ".cv-viewport.is-hidden",
    hidden: canvasViewport(true),
    shown: canvasViewport(false),
  },
];

// Every non-keyframe rule that sets visibility:hidden, classified. A new one must be
// added to a pause block (src/shell/shell.css, src/canvas/canvas.css) and a scenario above, or listed as a leaf.
const PAUSED_CONTAINERS = [...new Set(SCENARIOS.map((scenario) => scenario.container))];
const LEAVES_WITHOUT_DESCENDANTS: Record<string, string> = {};

function pauseMatch(path: ModelElement[], pseudo: PseudoElement, importantOnly: boolean): Match {
  let best: Match = NO;
  for (const { rule, match } of rulesMatching(styleRules, path, pseudo)) {
    const pauses = rule.declarations.some((declaration) => (
      declaration.property === "animation-play-state"
      && /^paused$/i.test(declaration.value)
      && (declaration.important || !importantOnly)
    ));
    if (pauses && match > best) best = match;
  }
  return best;
}

describe("animations inside retained hidden views", () => {
  it.each(SCENARIOS)("$name: paused while hidden, running when shown", ({ hidden, shown }) => {
    for (const pseudo of PSEUDOS) {
      expect(pauseMatch(hidden, pseudo, true), `${describePath(hidden.slice(-3), pseudo)} should be paused`).toBe(YES);
      expect(pauseMatch(shown, pseudo, false), `${describePath(shown.slice(-3), pseudo)} should not be paused`).toBe(NO);
    }
  });

  it("cannot be un-paused by another !important animation declaration", () => {
    const offenders = styleRules.flatMap((rule) => rule.declarations
      .filter((declaration) => declaration.important && (
        (declaration.property === "animation-play-state" && !/^paused$/i.test(declaration.value))
        // The shorthand resets animation-play-state to running.
        || (declaration.property === "animation" && animationNames("animation", declaration.value).length > 0)
      ))
      .map((declaration) => `${rule.file}:${rule.line} ${rule.selectors.join(", ")} { ${declaration.property}: ${declaration.value} !important }`));
    expect(offenders).toEqual([]);
  });

  it("only pauses: show/hide transitions and visibility are left to the containers' own rules", () => {
    const offenders = styleRules
      .filter((rule) => rule.declarations.some((declaration) => declaration.property === "animation-play-state" && /^paused$/i.test(declaration.value)))
      .filter((rule) => rule.declarations.some((declaration) => declaration.property !== "animation-play-state"))
      .map((rule) => `${rule.file}:${rule.line} ${rule.selectors[0]}`);
    expect(offenders).toEqual([]);
  });

  it("classifies every rule that hides with visibility:hidden", () => {
    const hiding = [...new Set(styleRules
      .filter((rule) => rule.declarations.some((declaration) => declaration.property === "visibility" && /^hidden$/i.test(declaration.value)))
      .flatMap((rule) => rule.selectors))].sort();
    expect(hiding).toEqual([...PAUSED_CONTAINERS, ...Object.keys(LEAVES_WITHOUT_DESCENDANTS)].sort());
  });
});
