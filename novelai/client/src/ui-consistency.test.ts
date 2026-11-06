import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";



const projectRoot = process.cwd();

describe("desktop UI consistency guards", () => {
  it("never renders semantic icon names as visible panel text", () => {
    const source = fs.readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    expect(source).not.toContain("<span>{meta.icon}</span>");
  });

  it("centers weight text and provides direct character-position dragging", () => {
    // Step 4b3: the prompt's weight editor and the character position pad of the rebuilt canvas (src/canvas).
    const prompt = fs.readFileSync(path.join(projectRoot, "src", "canvas", "sections", "prompt.tsx"), "utf8");
    const characters = fs.readFileSync(path.join(projectRoot, "src", "canvas", "sections", "characters.tsx"), "utf8");
    expect(prompt).toContain("setTagLevelInPrompt(value, index, tag.level + 1)");
    expect(prompt).toContain("setTagLevelInPrompt(value, index, tag.level - 1)");
    expect(characters).toContain('className="cv-pad"');
    expect(characters).toContain('className="cv-pad-marker"');
    expect(characters).toContain("setPointerCapture(event.pointerId)");
    expect(characters).toContain("update(caption.id, { ...patch, useCoords: true })");
  });

  it("lets each character prompt card collapse independently", () => {
    const characters = fs.readFileSync(path.join(projectRoot, "src", "canvas", "sections", "characters.tsx"), "utf8");
    expect(characters).toContain("aria-expanded={expanded}");
    expect(characters).toContain("const toggle = (id: string) =>");
    expect(characters).toContain("{expanded && <div className=\"cv-char-body\">");
  });

  it("supports autocomplete and user prompt blocks inside character prompts", () => {
    // Step 4b3: the character cards of the rebuilt canvas (completion follows the one setting of the prompt box).
    // Step 4c2: the old snippet popover (PromptChunks.tsx) and its styles were removed; the library picker replaces it.
    const source = fs.readFileSync(path.join(projectRoot, "src", "canvas", "sections", "prompt.tsx"), "utf8");
    const characterModal = fs.readFileSync(path.join(projectRoot, "src", "canvas", "sections", "characters.tsx"), "utf8");
    expect(characterModal).toContain("enabled={autoComplete}");
    expect(characterModal.match(/<PromptTextarea/g)).toHaveLength(2);
    expect(characterModal).toContain('<PromptLibraryPicker open={picker} anchor={libraryButton} onClose={() => setPicker(false)} field="character"');
    expect(characterModal).not.toContain("<PromptChunkControl");
    expect(source).toContain("onTemplate={isPositive ? applyTemplate : undefined}");
  });

  it("keeps the Style presets of the canvas to apply, preview and save (step 4b3)", () => {
    // The old style-folder menu became the canvas's Style preset picker; groups are managed in the library.
    const source = fs.readFileSync(path.join(projectRoot, "src", "canvas", "sections", "style-presets.tsx"), "utf8");
    expect(source).toContain("setPromptField(scope, 'stylePrompt', preset.prompt)");
    expect(source).toContain("<StylePresetImagesManager presetId={imagesFor}");
    expect(source).toContain("saveAssetSetting(window.naiDesktop, 'stylePromptPresets', presets, [...presets, preset])");
  });

  it("defaults proxy setup to automatic system/VPN routing", () => {
    // The settings page's proxy control (step 4b2): automatic is the first, selectable mode and the fallback default.
    const proxyControl = fs.readFileSync(path.join(projectRoot, "src", "settings", "sections", "logic.ts"), "utf8");
    const accountSource = fs.readFileSync(path.join(projectRoot, "src", "settings", "sections", "AccountSection.tsx"), "utf8");
    const storeSource = fs.readFileSync(path.join(projectRoot, "electron", "ipc", "store.ts"), "utf8");
    const proxySource = fs.readFileSync(path.join(projectRoot, "electron", "ipc", "proxy.ts"), "utf8");
    expect(proxyControl).toContain("export const PROXY_MODES: readonly ProxyMode[] = ['auto', ");
    expect(proxyControl).toContain("export const DEFAULT_PROXY_MODE: ProxyMode = 'auto';");
    expect(accountSource).toContain("PROXY_MODES.map(value => ({ value, label: t(PROXY_LABEL[value]) }))");
    expect(accountSource).toContain("settings?.proxyMode ?? 'auto'");
    expect(storeSource).toContain('proxyMode: "auto"');
    expect(proxySource).toContain("systemProxyResolver");
    expect(proxySource).toContain("probeLocalProxy");
    expect(proxySource).toContain('settings.proxyMode === "auto"');
  });

  it("leaves the account and V5 allowance to the settings page (step 4b3: no account footer on the canvas)", () => {
    const source = fs.readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    expect(source).not.toContain("account-details-shell");
    const generateBar = fs.readFileSync(path.join(projectRoot, "src", "canvas", "GenerateBar.tsx"), "utf8");
    expect(generateBar).toContain("navigate('settings', 'account')");
  });

  it("keeps generation completion stable on the canvas", () => {
    const store = fs.readFileSync(path.join(projectRoot, "src", "store.ts"), "utf8");
    // The rebuilt stage (step 4b3) keeps the old handoff: the final stream frame stays until the saved image decodes.
    // (Step 4c2: the old history panel's pending tile and its styles were removed.)
    const stage = fs.readFileSync(path.join(projectRoot, "src", "canvas", "Stage.tsx"), "utf8");
    expect(stage).toContain("setHandoff(preview)");
    expect(stage).toContain("currentImage?.fileUrl !== handoff.imageDataUrl");
    expect(store).toContain("completedImageBridges");
    expect(store).toContain("preloadCompletedImage(item.fileUrl)");
  });

  it("renders official V5 Opus allowance as a live progress bar", () => {
    // Step 4b3: the canvas's allowance footer and dialog are gone; the account section of the settings shows it.
    const account = fs.readFileSync(path.join(projectRoot, "src", "settings", "sections", "AccountSection.tsx"), "utf8");
    expect(account).toMatch(/opusUsage/);
    expect(fs.readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8")).not.toContain('className="opus-usage-track"');
  });

  it("supports an isolated Opus usage screenshot surface", () => {
    const appSource = fs.readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const mainSource = fs.readFileSync(path.join(projectRoot, "electron", "main.ts"), "utf8");
    expect(mainSource).toContain('normalizedUiCapturePath.includes("opus-usage")');
    expect(appSource).toContain('captureSurface === "opusUsage"');
    expect(appSource).toContain('percent: 73.4');
  });

  it("shares positive-only presets in generation without batch coupling", () => {
    const backupSource = fs.readFileSync(path.join(projectRoot, "electron", "ipc", "data-backup.ts"), "utf8");
    // Step 4b3c: the canvas applies prompt presets through its library picker (a preset replaces the field).
    const picker = fs.readFileSync(path.join(projectRoot, "src", "canvas", "LibraryPicker.tsx"), "utf8");
    expect(picker).toContain("if (item.kind === 'positive_preset') { apply(insertionText(item), t('cv.lib.replaced', { name })); onClose(); }");
    expect(picker).toContain('<StylePresetImagesManager kind="positive" presetId={imagesFor}');
    expect(backupSource).toContain("positivePromptPresets: positivePrompts");
    expect(backupSource).toContain("positivePromptPresetStorageId(target.id)");
  });

  it("uses non-blocking confirmations and groups all post modes without changing backend tabs", () => {
    // Step 4c2: the old tab bar and the pages that confirmed with window.confirm are gone; the rebuilt reference preset
    // page confirms with the UI kit's ConfirmDialog (src/library/reference-presets.test.tsx).
    for (const file of ["App.tsx", "library/ReferencePresets.tsx", "canvas/StylePresetImages.tsx"]) {
      const source = fs.readFileSync(path.join(projectRoot, "src", file), "utf8");
      expect(source, file).not.toContain("window.confirm(");
    }
    const app = fs.readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const navigation = fs.readFileSync(path.join(projectRoot, "src", "app", "navigation.ts"), "utf8");
    expect(navigation).not.toContain('"upscale"');
    expect(app).not.toContain('activeTab === "upscale"');
    // The post tools are chosen in the canvas's mode switch (step 4b3).
    const modes = fs.readFileSync(path.join(projectRoot, "src", "canvas", "ModeSwitch.tsx"), "utf8");
    expect(modes).toContain("{ value: 'enhance', label: t('cv.post.enhance') }, { value: 'upscale', label: t('cv.post.upscale') }, { value: 'director', label: t('cv.post.director') }");
    const canvasPage = fs.readFileSync(path.join(projectRoot, "src", "canvas", "CanvasPage.tsx"), "utf8");
    expect(canvasPage).toContain("mode === 'enhance' ? <EnhanceSettings />");
    expect(canvasPage).toContain("mode === 'upscale' ? <UpscaleSettings />");
    expect(canvasPage).toContain(": <DirectorSettings />}");
  });

  it("keeps before/after comparison owned by its exact surface and hides it elsewhere", () => {
    const store = fs.readFileSync(path.join(projectRoot, "src", "store.ts"), "utf8");
    expect(store).toContain("comparisonSurface: CanvasSurface | null");
    expect(store).toContain("activeCanvasSurface: CanvasSurface");
    expect(store).toContain("comparisonSurface: options.compareBefore ? options.comparisonSurface ?? state.activeCanvasSurface : null");
    // The rebuilt stage (step 4b3) shows a comparison only on the exact surface it was made on.
    const stage = fs.readFileSync(path.join(projectRoot, "src", "canvas", "Stage.tsx"), "utf8");
    expect(stage).toContain("comparisonHere && comparisonSurface === activeSurface ? comparisonBefore : null");
    expect(stage).toContain("comparisonSurface?.startsWith('generate:')");
    expect(stage).toContain("comparisonSurface?.startsWith('postprocess:')");
    const workbenchNavigation = fs.readFileSync(path.join(projectRoot, 'src/app/workbench-navigation.ts'), 'utf8');
    expect(workbenchNavigation).toContain('store.setGenerateMode(mode)');
    expect(workbenchNavigation).toContain('store.setPostprocessMode(mode)');
  });

  it("keeps the removed prompt-codex enhancements out of nai.ts", () => {
    const nai = fs.readFileSync(path.join(projectRoot, "electron", "ipc", "nai.ts"), "utf8");
    expect(nai).not.toMatch(/codexEnabled|ruleRepairEnabled|matureTagNames/);
    expect(nai).not.toContain("提示词转换 · 规则修复");
    expect(nai).not.toContain("AI 反推 · 法典增强");
  });

  it("keeps an explicit redraw source policy and comparison handoff", () => {
    const app = fs.readFileSync(path.join(projectRoot, "src", "canvas", "sections", "inpaint.tsx"), "utf8") + fs.readFileSync(path.join(projectRoot, "src", "canvas", "sections", "source.tsx"), "utf8");
    const store = fs.readFileSync(path.join(projectRoot, "src", "store.ts"), "utf8");
    expect(app).toContain("t('cv.src.original')");
    expect(app).toContain("t('cv.src.latest')");
    expect(store).toContain('i2iSourceMode: "original"');
    expect(store).toContain("compareBefore: sourceImage");
    expect(store).toContain('loadWorkbench: state.i2iSourceMode === "latest"');
    expect(app).toContain("label={t('cv.src.next')} value={sourceMode} onChange={value => void setSourceMode(value)}");
    expect(store).toContain('inpaintSourceMode: "original"');
    expect(store).toContain('loadWorkbench: state.inpaintSourceMode === "latest"');
    expect(fs.readFileSync(path.join(projectRoot, "src", "InpaintCanvas.tsx"), "utf8"))
      .toContain("currentImage!.fileUrl");
  });

  it("keeps muted text AA-safe", () => {
    const css = fs.readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    expect(css.match(/--text-muted\s*:/g)).toHaveLength(2);
    expect(css).toContain("--text-muted:     #736a82");
    expect(css).toContain("select:not(:disabled) { cursor: pointer; }");
  });

  it("defines every custom property used without a fallback", () => {
    const css = fs.readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    const usedWithoutFallback = new Set(
      [...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((match) => match[1]),
    );
    const defined = new Set(
      [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]),
    );
    const injected = new Set([
      "--ws-left",
      "--ws-right",
      "--reference-preset-columns",
    ]);
    expect([...usedWithoutFallback].filter((token) => !defined.has(token) && !injected.has(token))).toEqual([]);
    expect(css).not.toMatch(/font:\s*[^;]*var\(--font-sans/);
    expect(css).not.toMatch(/animation:\s*[^;]*var\(--ease-in-out/);
    expect(css.match(/^:root\s*\{/gm)).toHaveLength(1);
    expect(css.match(/^\.theme-dark\s*\{/gm)).toHaveLength(1);
  });

  it("keeps shorthand variables defined and theme tokens unique per scope", () => {
    const css = fs.readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    const defined = new Set(
      [...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]),
    );
    for (const shorthand of css.matchAll(/\b(font|animation)\s*:\s*([^;{}]*)/g)) {
      for (const variable of shorthand[2].matchAll(/var\(\s*(--[\w-]+)\s*(?:,|\))/g)) {
        expect(defined.has(variable[1]), `${shorthand[1]} references ${variable[1]}`).toBe(true);
      }
    }

    for (const selector of [":root", ".theme-dark"]) {
      const pattern = selector === ":root"
        ? /^:root\s*\{([^}]*)\}/gm
        : /^\.theme-dark\s*\{([^}]*)\}/gm;
      const blocks = [...css.matchAll(pattern)];
      expect(blocks, selector).toHaveLength(1);
      const names = [...blocks[0][1].matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((match) => match[1]);
      expect(new Set(names).size, `${selector} contains duplicate tokens`).toBe(names.length);
    }
  });

  it("keeps motion explicit, typography owned by the app, and active theme selectors live", () => {
    const css = fs.readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    const app = fs.readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    // Step 4c2: the reference preset manager was rebuilt in src/library (its own tests: reference-presets.test.tsx).
    const presets = fs.readFileSync(path.join(projectRoot, "src", "library", "ReferencePresets.tsx"), "utf8");

    expect(css).not.toContain("prefers-reduced-motion");
    expect(css).not.toContain('[data-theme=');
    expect(css).toMatch(/html, html body, html body #root\s*\{[^}]*font-family:\s*var\(--font-sans\)/s);
    expect(css).toMatch(/--font-sans:[^;]*"Microsoft YaHei UI"[^;]*"PingFang SC"/);
    expect(css).toContain("html.motion-reduced *");
    // The reduce-motion switch is the app's own setting on the settings page (step 4b2), not the system preference.
    const appearance = fs.readFileSync(path.join(projectRoot, "src", "settings", "sections", "AppearanceSection.tsx"), "utf8");
    expect(appearance).toContain("update('reduceMotion', value)");
    expect(appearance).not.toContain("prefers-reduced-motion");
    expect(app).toContain('classList.toggle("motion-reduced", settings?.reduceMotion === true)');
    expect(presets).not.toContain("prefers-reduced-motion");
  });

  it("keeps tab recovery stateful and defers noncritical route warming", () => {
    const app = fs.readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const css = fs.readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    // Step 4b3c: the canvas page is the rebuilt canvas alone; the material rail and the auxiliary pages are gone.
    expect(app).toContain('<div className="as-canvas-page">');
    expect(app).not.toContain("<MaterialSidebar");
    expect(app).not.toContain("<MetadataInspector");
    expect(app).not.toContain("<ReferencePresetManager");
    expect(app).not.toContain("WIDE_WORKSPACE_TABS.has(activeTab)");
    expect(css).not.toContain(".workspace-tools {");
    expect(app).toContain('<AppErrorBoundary scope="page:canvas">');
    expect(app).not.toContain('<AppErrorBoundary key={activeTab}');
    expect(app).toContain("const SPLASH_MIN_VISIBLE_MS = 700");
    expect(app).toContain("const warmCriticalScreen = loadInpaintCanvas()");
    const criticalStart = app.indexOf("const warmCriticalScreen");
    const minimumStart = app.indexOf("const minimumSplash", criticalStart);
    expect(app.slice(criticalStart, minimumStart)).not.toMatch(/load(?:ToolsHub|MetadataInspector)\(/);
  });

  it("keeps the saved NovelAI token revealable", () => {
    // The settings page's token form (step 4b2) fills the saved token in, masked, with a show/hide switch.
    const tokenForm = fs.readFileSync(path.join(projectRoot, "src", "settings", "sections", "AccountSection.tsx"), "utf8");
    const main = fs.readFileSync(path.join(projectRoot, "electron", "main.ts"), "utf8");
    const preload = fs.readFileSync(path.join(projectRoot, "electron", "preload.ts"), "utf8");

    // No saved token reads as "" on every layer (review rework: undefined crashed the form without a token).
    expect(main).toContain('ipcMain.handle("nai:storedToken", () => getToken() ?? "")');
    expect(preload).toContain('storedToken: async (): Promise<string> => { const value = await ipcRenderer.invoke("nai:storedToken"); return typeof value === "string" ? value : ""; }');
    expect(tokenForm).toContain("window.naiDesktop.storedToken().then(value => { const text = typeof value === 'string' ? value : ''; saved.current = text; setToken(text); })");
    expect(tokenForm).toContain("type={visible ? 'text' : 'password'}");
    expect(tokenForm).toContain("setVisible(value => !value)");
  });

  it("keeps routes mounted and marks the active creative mode in the shared navigation", () => {
    const app = fs.readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const css = fs.readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    // The rebuilt stage (step 4b3) keeps Inpaint's viewport mounted once shown, beside the image viewport.
    const stage = fs.readFileSync(path.join(projectRoot, "src", "canvas", "Stage.tsx"), "utf8");
    expect(stage).toContain("{inpaintVisited && <div className={clsx('cv-viewport cv-viewport--inpaint', !inpaint && 'is-hidden')}");
    expect(css).not.toMatch(/\.persistent-tools-view\.is-hidden\s*\{[^}]*display:\s*none/s);
    expect(fs.readFileSync(path.join(projectRoot, "src", "canvas", "canvas.css"), "utf8")).toMatch(/\.cv-vhost > \.cv-viewport \{ position: absolute; inset: 0; \}/);
    // The tools page (step 4b1) and its metadata and reference preset pages (step 4b3c) are gone: a restored one opens
    // the last canvas mode.
    expect(app).not.toContain("<PersistentTabView");
    expect(app).toContain('} else if (activeTab === "tools" || activeTab === "metadata" || activeTab === "referencePresets") {');
  });

  it("uses non-blocking dialogs", () => {
    // Step 4c2: the old history panel (and its virtual list) was removed; the library grid has its own (VirtualGrid).
    const app = fs.readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    expect(app).not.toMatch(/window\.(?:alert|prompt|confirm)\s*\(/);
    expect(app).not.toContain("export function HistoryPanel()");
  });

  it("keeps render and rejected-request recovery wired", () => {
    const main = fs.readFileSync(path.join(projectRoot, "src", "main.tsx"), "utf8");
    const app = fs.readFileSync(path.join(projectRoot, "src", "App.tsx"), "utf8");
    const boundary = fs.readFileSync(path.join(projectRoot, "src", "components", "AppErrorBoundary.tsx"), "utf8");
    const store = fs.readFileSync(path.join(projectRoot, "src", "store.ts"), "utf8");
    // The new-version notice is published from the main process to a window that may already be gone.
    const updater = fs.readFileSync(path.join(projectRoot, "electron", "main.ts"), "utf8");
    const nai = fs.readFileSync(path.join(projectRoot, "electron", "ipc", "nai.ts"), "utf8");
    expect(main).toContain('window.addEventListener("unhandledrejection"');
    expect(main).toContain('<AppErrorBoundary scope="app" root>');
    expect(app).toContain('<AppErrorBoundary scope="page:canvas">');
    expect(boundary).toContain("getDerivedStateFromError");
    // A rejected manual enqueue IPC is looked up once with the same requestKey (never resent), so the window is not left waiting.
    expect(store).toMatch(/await window\.naiDesktop\.manualEnqueue\(\{ requestKey, [\s\S]*?\} catch \{[\s\S]*?window\.naiDesktop\.manualLookup\(requestKey\)/);
    expect(updater).toContain("mainWindow.webContents.isDestroyed()");
    expect(nai).toContain('signal?.removeEventListener("abort", onAbort)');
  });

  it("keeps the retired novel-shorts module out of active product code", () => {
    for (const retiredPath of [
      "src/tuiwen",
      "scripts/create-tuiwen-jianying-validation.mjs",
      "docs/TUIWEN_VALIDATION_STATUS.md",
      "docs/assets/tuiwen-jianying-10.9-golden-open.png",
    ]) {
      expect(fs.existsSync(path.join(projectRoot, retiredPath)), retiredPath).toBe(false);
    }
    // Every product source file of the client (renderer, main process, shared runtime, build scripts) and its
    // manifest; tests are left out because they name the retired module on purpose.
    const productFiles = ["index.html", "package.json", ...["src", "electron", "shared", "scripts"].flatMap((directory) =>
      (fs.readdirSync(path.join(projectRoot, directory), { recursive: true }) as string[])
        .map((file) => path.join(directory, file))
        .filter((file) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs|css|html|json)$/.test(file) && !/\.test\.[jt]sx?$/.test(file) && !file.split(path.sep).includes("test-support")))];
    expect(productFiles).toEqual(expect.arrayContaining(["electron/main.ts", "electron/preload.ts", "electron/ipc/nai.ts", "src/types.ts", "src/i18n.ts", "src/styles.css"].map((file) => path.normalize(file))));
    for (const file of productFiles) {
      const source = fs.readFileSync(path.join(projectRoot, file), "utf8");
      expect(source, file).not.toMatch(/tuiwen|小说推文|小說推文|novel shorts|小説ショート|소설 숏폼|novel-tuiwen/i);
    }
  });

  it("keeps typography, radii, stacking and breakpoints on bounded scales", () => {
    const css = fs.readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    for (const match of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
      expect(Number(match[1]), `font-size ${match[0]}`).toBeGreaterThanOrEqual(10);
    }
    for (const match of css.matchAll(/border(?:-[\w]+)*-radius:\s*([^;{}]+)/g)) {
      expect(match[1], match[0]).not.toMatch(/\d+(?:\.\d+)?(?:px|%)/);
    }
    const zValues = [...css.matchAll(/z-index:\s*([^;{}]+)/g)].map((match) => match[1].trim());
    // Save notifications require one semantic layer above fullscreen previews. (Step 4c2: the layers only the removed
    // pages used are gone.)
    const allowed = new Set(["base", "behind", "dropdown", "floating", "overlay", "overlay-raised", "overlay-top", "raised", "sticky", "notification"].map(name => `var(--z-${name})`));
    for (const value of zValues) expect(allowed.has(value), value).toBe(true);
    expect(zValues).toContain("var(--z-notification)");
    const breakpoints = [...css.matchAll(/@media\s*\([^)]*max-width:\s*(\d+)px/g)].map((match) => Number(match[1]));
    for (const value of breakpoints) expect([480, 640, 768, 960, 1200]).toContain(value);
  });

  it("names high stacking layers by height instead of misleading dialog semantics", () => {
    const css = fs.readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    expect(css).toContain("--z-notification: 21000");
    expect(css).not.toMatch(/--z-(?:dialog|popover|modal)\b/);
  });

  it("keeps large-image comparison scoped and compositor-driven", () => {
    const inpaint = fs.readFileSync(path.join(projectRoot, "src", "InpaintCanvas.tsx"), "utf8");
    const css = fs.readFileSync(path.join(projectRoot, "src", "styles.css"), "utf8");
    // The stage's image view (step 4b3, moved from App.tsx's ZoomableImageStage).
    const viewer = fs.readFileSync(path.join(projectRoot, "src", "canvas", "ImageView.tsx"), "utf8");
    expect(viewer).not.toContain("setCompareX");
    expect(viewer).not.toContain('window.addEventListener("pointermove"');
    expect(viewer).toContain("requestAnimationFrame");
    expect(viewer).toContain("clipRef.current.style.clipPath");
    expect(viewer).toContain("setPointerCapture(event.pointerId)");
    expect(inpaint).toContain('comparisonSurface === "inpaint"');
    expect(inpaint).not.toContain("setCompareX");
    expect(inpaint).not.toContain('window.addEventListener("pointermove"');
    expect(inpaint).toContain("compareClipRef.current.style.clipPath");
    expect(fs.readFileSync(path.join(projectRoot, "src", "canvas", "canvas.css"), "utf8")).toMatch(/\.cv-compare-clip\s*\{[^}]*will-change:\s*clip-path/s);
    expect(css).toMatch(/\.inpaint-compare-after-clip\s*\{[^}]*contain:\s*paint/s);
  });

  it("blocks oversized Enhance 2x targets before any generation request", () => {
    const source = fs.readFileSync(path.join(projectRoot, "src", "canvas", "sections", "post.tsx"), "utf8");
    const panel = source.slice(source.indexOf("export async function runEnhance"), source.indexOf("export function useEnhanceTarget"));
    // The click sends only a size enhanceRequestSize accepted: 2× over the pixel limit is refused (null).
    const guard = panel.indexOf("if (!target) return;");
    const request = panel.indexOf("await state.generateI2I(");
    expect(guard).toBeGreaterThan(-1);
    expect(request).toBeGreaterThan(guard);
    expect(panel).toContain("if (scale > 1 && requested.exceedsLimit) return null;");
    const page = fs.readFileSync(path.join(projectRoot, "src", "canvas", "CanvasPage.tsx"), "utf8");
    expect(page).toContain("disabled={enhance.tooLarge || !hasSource} disabledReason={enhance.reason || noSource}");
  });
});
