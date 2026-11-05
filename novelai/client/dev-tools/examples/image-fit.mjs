#!/usr/bin/env node
// Large image views show the whole image, in a real background test window (regression check for 0.1.2: "only part of
// the image is shown"). A new data root gets five full-size history images of 832×1216, 1216×832, 1024×1024,
// 1664×2432 and 64×64 and three Style preset images (1664×2432, 1216×832, 64×64), all with a white frame, both
// diagonals and coloured corners; then, at each window size, every view is measured through DevTools
// (img.getBoundingClientRect() against its container, the drawn picture worked out from object-fit):
//   library detail (← → and full screen buttons, the image is what a drag starts from), library full screen (a click on
//   the image keeps it, a click beside it closes it), library tiles, tag cards and a tag's detail cover (cropped
//   covers must fill their box exactly), canvas stage, canvas full screen, the image-metadata reader, the generation
//   preview over the stage (injected into the stage, as no generation runs), the Inpaint stage (its mask canvas on
//   the image), Style preset images and their full-screen preview.
//   "contain" views: the whole picture inside the container's content box and the window, its aspect ratio kept,
//   filling the box in at least one direction (or shown at its own size when it is smaller than the box);
//   "cover" views: the image box is exactly the container's box.
//   node dev-tools/examples/image-fit.mjs [--out <folder under .tmp>] [--window 1440x900,1280x720] [--keep]
// Prints one JSON report (also <out>/report.json) and exits with 0 when every check passes, 1 when one fails (the
// report lists each failure with its numbers). Screenshots go to <out>/shots. Uses the fake NovelAI service; nothing
// is generated. The data root is removed afterwards unless --keep or a failure.
import fs from 'node:fs';
import path from 'node:path';
import { ToolError, allowOptions, parseArgs, pollUntil, runCli, sleep } from '../lib/cli.mjs';
import { connectPage } from '../lib/cdp.mjs';
import { startFakeNovelAI } from '../lib/fake-novelai-server.mjs';
import { frontDetectedError, startFrontWatch } from '../lib/front-watch.mjs';
import { worktreeRoot } from '../lib/paths.mjs';
import { parseSizeList, seedLibrary } from '../lib/seed.mjs';
import { startClient, stopClient } from '../test-client.mjs';

const HISTORY_SIZES = [[832, 1216], [1216, 832], [1024, 1024], [1664, 2432], [64, 64]];
const PRESET_SIZES = [[1664, 2432], [1216, 832], [64, 64]];

/**
 * In the window: measures image(s) in their container(s). spec: { container, image (inside the container), kind
 * 'contain'|'cover', all (every container match, default the first visible one), reserve (a selector inside the
 * container whose box, with the container's row gap, is taken off the bottom of the area the image may use) }.
 */
function inspectImages(spec) {
  const round = value => Math.round(value * 10) / 10;
  const rect = (r) => ({ x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) });
  const visible = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const px = value => parseFloat(value) || 0;
  const contentBox = el => {
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const left = px(cs.borderLeftWidth) + px(cs.paddingLeft), right = px(cs.borderRightWidth) + px(cs.paddingRight);
    const top = px(cs.borderTopWidth) + px(cs.paddingTop), bottom = px(cs.borderBottomWidth) + px(cs.paddingBottom);
    return { left: r.left + left, top: r.top + top, right: r.right - right, bottom: r.bottom - bottom };
  };
  // The picture as drawn inside the img box (object-fit, object-position centred as the app uses it).
  const painted = (img) => {
    const box = contentBox(img), bw = box.right - box.left, bh = box.bottom - box.top;
    const nw = img.naturalWidth, nh = img.naturalHeight, fit = getComputedStyle(img).objectFit;
    let w = bw, h = bh;
    if (fit === 'contain' || fit === 'scale-down') { const scale = Math.min(bw / nw, bh / nh); const used = fit === 'scale-down' ? Math.min(1, scale) : scale; w = nw * used; h = nh * used; }
    else if (fit === 'cover') { const scale = Math.max(bw / nw, bh / nh); w = nw * scale; h = nh * scale; }
    else if (fit === 'none') { w = nw; h = nh; }
    return { left: box.left + (bw - w) / 2, top: box.top + (bh - h) / 2, right: box.left + (bw + w) / 2, bottom: box.top + (bh + h) / 2, fit };
  };
  const containers = [...document.querySelectorAll(spec.container)].filter(visible);
  const chosen = spec.all ? containers : containers.slice(0, 1);
  if (!chosen.length) return [{ ok: false, problems: [`no visible ${spec.container}`] }];
  return chosen.map(container => {
    const img = container.querySelector(spec.image);
    const problems = [];
    if (!img) return { ok: false, problems: [`no ${spec.image} in ${spec.container}`] };
    if (!img.complete || !img.naturalWidth) return { ok: false, problems: ['image not loaded'], src: img.currentSrc.slice(0, 120) };
    const area = contentBox(container);
    if (spec.reserve) {
      const reserved = container.querySelector(spec.reserve);
      if (reserved) area.bottom = Math.min(area.bottom, reserved.getBoundingClientRect().top - px(getComputedStyle(container).rowGap));
    }
    const box = img.getBoundingClientRect(), drawn = painted(img);
    const nw = img.naturalWidth, nh = img.naturalHeight, aw = area.right - area.left, ah = area.bottom - area.top;
    const tolerance = 1;
    if (spec.kind === 'cover') {
      const off = ['left', 'top', 'right', 'bottom'].map(side => [side, box[side] - area[side]]).filter(([, value]) => Math.abs(value) > tolerance);
      if (off.length) problems.push(`image box is not the container box: ${off.map(([side, value]) => `${side} ${value > 0 ? '+' : ''}${round(value)}px`).join(', ')}`);
      if (drawn.fit !== 'cover' && Math.abs((box.width / box.height) / (nw / nh) - 1) > 0.01) problems.push(`stretched (object-fit ${drawn.fit})`);
    } else {
      const outside = [['left', area.left - drawn.left], ['top', area.top - drawn.top], ['right', drawn.right - area.right], ['bottom', drawn.bottom - area.bottom]].filter(([, value]) => value > tolerance);
      if (outside.length) problems.push(`picture goes past the container: ${outside.map(([side, value]) => `${side} ${round(value)}px`).join(', ')}`);
      const screen = [['left', -drawn.left], ['top', -drawn.top], ['right', drawn.right - innerWidth], ['bottom', drawn.bottom - innerHeight]].filter(([, value]) => value > tolerance);
      if (screen.length) problems.push(`picture goes past the window: ${screen.map(([side, value]) => `${side} ${round(value)}px`).join(', ')}`);
      const dw = drawn.right - drawn.left, dh = drawn.bottom - drawn.top;
      if (Math.abs((dw / dh) / (nw / nh) - 1) > 0.01) problems.push(`aspect ratio ${round(dw / dh * 1000) / 1000} instead of ${round(nw / nh * 1000) / 1000}`);
      const filled = dw >= aw - 1.5 || dh >= ah - 1.5;
      const ownSize = nw <= aw + 0.5 && nh <= ah + 0.5 && Math.abs(dw - nw) <= 1 && Math.abs(dh - nh) <= 1;
      if (!filled && !ownSize) problems.push(`picture ${round(dw)}×${round(dh)} fills the ${round(aw)}×${round(ah)} area in neither direction`);
    }
    return {
      ok: problems.length === 0, problems, natural: `${nw}×${nh}`,
      container: rect({ left: area.left, top: area.top, width: area.right - area.left, height: area.bottom - area.top }),
      imageBox: rect(box), picture: rect({ left: drawn.left, top: drawn.top, width: drawn.right - drawn.left, height: drawn.bottom - drawn.top }), objectFit: drawn.fit,
    };
  });
}

/** In the window: the element at a point and whether it is (inside) the given selector's first visible match. */
function hitTest(x, y, selector) {
  const el = document.elementFromPoint(x, y);
  const target = selector ? [...document.querySelectorAll(selector)].find(node => node.getBoundingClientRect().width > 0) : null;
  return { hit: el ? `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).filter(Boolean).join('.')}` : ''}` : null, inside: Boolean(target && el && target.contains(el)) };
}

/** In the window: the drawer's ← → buttons against the image box (vertically centred, 8 px from the sides, clickable). */
function drawerButtons() {
  const box = document.querySelector('.lib-dr-img')?.getBoundingClientRect();
  if (!box) return { problems: ['no .lib-dr-img'] };
  const problems = [], buttons = {};
  for (const [name, selector] of [['prev', '.lib-dr-nav.is-left'], ['next', '.lib-dr-nav.is-right'], ['full', '.lib-dr-full']]) {
    const button = document.querySelector(`.lib-dr-img ${selector}`);
    if (!button) continue;
    const r = button.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    buttons[name] = { x: Math.round(r.left - box.left), y: Math.round(r.top - box.top), w: Math.round(r.width), h: Math.round(r.height) };
    if (!hit || !button.contains(hit)) problems.push(`${name} button is covered at its centre by ${hit?.tagName.toLowerCase()}.${hit?.className}`);
    if (name !== 'full' && Math.abs(cy - (box.top + box.height / 2)) > 1.5) problems.push(`${name} button is not vertically centred (${Math.round(cy - box.top)} of ${Math.round(box.height)})`);
    if (name === 'prev' && Math.abs(r.left - box.left - 8) > 1) problems.push(`prev button is ${Math.round(r.left - box.left)}px from the left, not 8`);
    if (name === 'next' && Math.abs(box.right - r.right - 8) > 1) problems.push(`next button is ${Math.round(box.right - r.right)}px from the right, not 8`);
    if (name === 'full' && (Math.abs(box.right - r.right - 8) > 1 || Math.abs(box.bottom - r.bottom - 8) > 1)) problems.push('full screen button is not 8px from the lower right corner');
  }
  return { problems, buttons };
}

/** In the window: the first visible img under a selector, its source and whether it finished loading. */
function imageState(selector) {
  const img = [...document.querySelectorAll(selector)].find(node => node.getBoundingClientRect().width > 0);
  return img ? { src: img.currentSrc || img.src, loaded: img.complete && img.naturalWidth > 0, natural: `${img.naturalWidth}×${img.naturalHeight}` } : null;
}

async function main(argv) {
  const { options } = parseArgs(argv, { booleans: ['keep'] });
  allowOptions(options, ['out', 'keep', 'window']);
  const windows = parseSizeList(options.window ?? '1440x900,1280x720', 'window');
  const out = path.resolve(String(options.out ?? path.join(worktreeRoot, '.tmp', 'dev-tools-examples', `image-fit-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
  const data = path.join(out, 'data'), shots = path.join(out, 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const checks = [], steps = [], screenshots = [];
  let fake, page, client, failure = null, label = '';
  const front = await startFrontWatch({ dataRoot: data });
  const step = async (name, run) => {
    const started = Date.now();
    try { const value = await run(); steps.push({ step: name, ok: true, ms: Date.now() - started }); return value; }
    catch (error) { steps.push({ step: name, ok: false, ms: Date.now() - started, error: error.message, ...(error.details ? { details: error.details } : {}) }); throw error; }
  };
  const shot = async name => { const file = path.join(shots, `${label}-${String(screenshots.length + 1).padStart(2, '0')}-${name.replace(/×/g, 'x')}.png`); await page.screenshot(file); screenshots.push(path.relative(out, file)); return path.relative(out, file); };
  const record = (view, image, results, extra = {}) => {
    for (const result of results) checks.push({ window: label, view, image: image ?? result.natural ?? null, ...result, ...extra, problems: [...(result.problems ?? []), ...(extra.problems ?? [])], ok: result.ok && !(extra.problems ?? []).length });
  };
  const inspect = spec => page.evaluate(inspectImages, spec);
  // Waits until the first visible img under `selector` shows a new (or the given) source and has loaded, then lets
  // the layout settle (the canvas sizes its frame after the load event).
  const loaded = async (selector, { not = null, src = null, timeoutMs = 15_000 } = {}) => {
    const state = await pollUntil(async () => { const value = await page.evaluate(imageState, selector).catch(() => null); return value?.loaded && (!not || value.src !== not) && (!src || value.src === src) ? value : null; }, { timeoutMs });
    if (!state) throw new ToolError('image_not_loaded', `${selector} did not show a loaded image within ${timeoutMs} ms.`, await page.evaluate(imageState, selector).catch(() => null));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await sleep(250);
    return state;
  };
  const gone = (selector, timeoutMs = 3_000) => page.wait(selector, { state: 'hidden', timeoutMs }).then(() => true).catch(() => false);
  // A real click on the picture keeps an overlay open; a real click on its backdrop (a corner of its padding) closes it.
  const overlayClicks = async (container, image, picture) => {
    const problems = [];
    await page.clickAt(picture.x + picture.w / 2, picture.y + picture.h / 2);
    await sleep(300);
    if (!(await page.evaluate(selector => Boolean(document.querySelector(selector)), container))) problems.push('a click on the picture closed the view');
    const point = await page.evaluate(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.left + 10, y: r.bottom - 10 }; }, container);
    const hit = await page.evaluate(hitTest, point.x, point.y, `${container} ${image}`);
    if (hit.inside) problems.push('the backdrop point is on the picture');
    await page.clickAt(point.x, point.y);
    if (!(await gone(container))) problems.push('a click beside the picture did not close the view');
    return problems;
  };

  try {
    fake = await step('fake-novelai', () => startFakeNovelAI());
    await step('seed-library', () => seedLibrary({
      data, history: HISTORY_SIZES.length, sizes: HISTORY_SIZES, presetImages: PRESET_SIZES, marks: true, imageScale: 1, agentRatio: 0, archivedRatio: 0,
      // All on today's date (the canvas strip shows the newest day's images), a few minutes apart.
      days: 0, now: new Date(new Date().setHours(12, 0, 0, 0)).toISOString(),
      tags: 4, combos: 0, notes: 0, imports: 0, favorites: 0, collections: 0, trash: 0, stylePresets: 2, positivePresets: 1, chunks: 0, referencePresets: 0,
    }));
    const [firstWidth, firstHeight] = windows[0];
    client = await step('test-client start', () => startClient({ data, port: 'auto', 'fake-novelai': fake.url, locale: 'zh-CN', size: `${firstWidth}x${firstHeight}` }));
    page = await connectPage({ port: client.port });
    await page.captureConsole();
    const applied = [];

    for (const [width, height] of windows) {
      const size = await page.setWindowSize(width, height);
      label = `${size.viewport.width}x${size.viewport.height}`;
      applied.push({ requested: `${width}x${height}`, applied: size.applied, viewport: label });
      await sleep(500);

      // ── Library: the detail drawer and its full screen, image by image (→ steps through them) ─────────────────
      await step(`${label} library detail and full screen`, async () => {
        await page.route('library');
        await page.clickText('历史成图', { within: '.lib-side' });
        await page.wait('[data-testid^="tile-"] button.lib-tile-open', { timeoutMs: 20_000 });
        // Tiles: the cropped thumbnails fill their tile.
        await pollUntil(() => page.evaluate(count => document.querySelectorAll('.lib-tile .lib-thumb[data-state="ready"] img').length >= count, HISTORY_SIZES.length), { timeoutMs: 20_000 });
        record('library tile', null, await inspect({ container: '.lib-tile .lib-thumb', image: 'img', kind: 'cover', all: true }));
        await shot('library-grid');
        await page.click('[data-testid^="tile-"][data-index="0"] button.lib-tile-open');
        let previous = null;
        for (let index = 0; index < HISTORY_SIZES.length; index++) {
          if (index > 0) await page.click('.lib-dr-img .lib-dr-nav.is-right');
          const state = await loaded('.lib-dr-img img', { not: previous });
          previous = state.src;
          const [detail] = await inspect({ container: '.lib-dr-img', image: 'img', kind: 'contain' });
          const buttons = await page.evaluate(drawerButtons);
          const extra = [...buttons.problems];
          if (detail.picture) {
            const center = await page.evaluate(hitTest, detail.picture.x + detail.picture.w / 2, detail.picture.y + detail.picture.h / 2, '.lib-dr-img img');
            const draggable = await page.evaluate(() => document.querySelector('.lib-dr-img img')?.draggable === true);
            if (!center.inside) extra.push(`the picture's centre is covered by ${center.hit} (a drag would not start from the image)`);
            if (!draggable) extra.push('the image is not draggable');
          }
          record('library detail', state.natural, [detail], { buttons: buttons.buttons, problems: extra, screenshot: await shot(`library-detail-${state.natural}`) });

          await page.click('.lib-dr-img .lib-dr-full');
          await loaded('.lib-lightbox img');
          const [full] = await inspect({ container: '.lib-lightbox', image: 'img', kind: 'contain' });
          const screenshot = await shot(`library-full-${state.natural}`);
          const clicks = full.picture ? await overlayClicks('.lib-lightbox', 'img', full.picture) : [];
          if (await page.evaluate(() => Boolean(document.querySelector('.lib-lightbox')))) { await page.key('Escape'); await gone('.lib-lightbox'); }
          record('library full screen', state.natural, [full], { problems: clicks, screenshot });
        }
        await page.key('Escape');
        await gone('.lib-detail');
      });

      // ── Library: tag cards and a tag's detail cover (cropped covers fill their box) ──────────────────────────────
      await step(`${label} tag covers`, async () => {
        await page.clickText('标签', { within: '.lib-side' });
        await page.wait('.lib-card-cv', { timeoutMs: 10_000 });
        await pollUntil(() => page.evaluate(() => document.querySelectorAll('.lib-card-cv .lib-thumb[data-state="ready"] img').length > 0), { timeoutMs: 20_000 });
        await sleep(300);
        record('tag card cover', null, await inspect({ container: '.lib-card-cv .lib-thumb[data-state="ready"]', image: 'img', kind: 'cover', all: true }));
        await shot('tag-cards');
        const withCover = await page.evaluate(() => [...document.querySelectorAll('.lib-card')].findIndex(card => card.querySelector('.lib-card-cv .lib-thumb[data-state="ready"] img')));
        await page.click('.lib-card button.lib-card-open', { nth: Math.max(0, withCover) });
        await loaded('.lib-dr-cover .lib-thumb img');
        record('tag detail cover', null, await inspect({ container: '.lib-dr-cover .lib-thumb', image: 'img', kind: 'cover' }), { screenshot: await shot('tag-detail-cover') });
        await page.key('Escape');
        await gone('.lib-detail');
        await page.clickText('历史成图', { within: '.lib-side' });
      });

      // ── Canvas: stage, full screen, metadata reader, generation preview (injected) ─────────────────────────────────
      await step(`${label} canvas`, async () => {
        await page.route('canvas');
        await page.clickText('文生图', { within: '.cv-modes', exact: true });
        await page.wait('.cv-film-item', { timeoutMs: 15_000 });
        const films = await page.evaluate(() => document.querySelectorAll('.cv-film-item').length);
        if (films < HISTORY_SIZES.length) throw new ToolError('film_strip', `The canvas strip shows ${films} images, expected ${HISTORY_SIZES.length}.`);
        for (let index = 0; index < films; index++) {
          const src = await page.evaluate(nth => document.querySelectorAll('.cv-film-item img')[nth].currentSrc || document.querySelectorAll('.cv-film-item img')[nth].src, index);
          await page.click('.cv-film-item', { nth: index });
          const state = await loaded('[data-testid="cv-image"] img.cv-zoom-img', { src });
          record('canvas stage', state.natural, await inspect({ container: '.cv-zoom-shell', image: 'img.cv-zoom-img', kind: 'contain' }), { screenshot: await shot(`canvas-stage-${state.natural}`) });

          await page.click('button[aria-label="全屏查看"]');
          await loaded('.cv-full img');
          const [full] = await inspect({ container: '.cv-full', image: 'img', kind: 'contain' });
          const screenshot = await shot(`canvas-full-${state.natural}`);
          const clicks = full.picture ? await overlayClicks('.cv-full', 'img', full.picture) : [];
          if (await page.evaluate(() => Boolean(document.querySelector('.cv-full')))) { await page.key('Escape'); await gone('.cv-full'); }
          record('canvas full screen', state.natural, [full], { problems: clicks, screenshot });

          await page.click('button[aria-label="图片操作"]');
          await page.clickText('图片原数据');
          await loaded('.lib-read-img img');
          record('image metadata reader', state.natural, await inspect({ container: '.lib-read-img', image: 'img', kind: 'contain' }), { screenshot: await shot(`reader-${state.natural}`) });
          await page.clickText('关掉', { within: '[role="dialog"]', exact: true });
          await gone('.lib-read-img');

          // The running generation's preview over the stage: a stream frame of this size (no generation runs here).
          await page.evaluate(src => {
            const viewport = document.querySelector('.cv-viewport:not(.cv-viewport--inpaint)');
            const overlay = document.createElement('div');
            overlay.className = 'cv-gen has-preview';
            overlay.dataset.imageFitProbe = '1';
            overlay.innerHTML = '<img class="cv-gen-frame" alt=""><div class="cv-gen-status"><b>生成中 · 14/28</b><span class="cv-gen-track"><i style="width: 50%"></i></span></div>';
            overlay.querySelector('img').src = src;
            viewport.append(overlay);
          }, src);
          await loaded('[data-image-fit-probe] img');
          const preview = await inspect({ container: '[data-image-fit-probe]', image: 'img', kind: 'contain', reserve: '.cv-gen-status' });
          record('generation preview (injected)', state.natural, preview, { screenshot: await shot(`generation-preview-${state.natural}`) });
          await page.evaluate(() => document.querySelectorAll('[data-image-fit-probe]').forEach(node => node.remove()));
        }
      });

      // ── Style preset images and their full-screen preview ───────────────────────────────────────────────────────
      await step(`${label} style preset images`, async () => {
        await page.click('[data-testid="cv-style"] button.cv-hact');
        await page.click('.cv-pop-item:has([data-testid="cv-style-preset-sp-01"]) .cv-iconbtn');
        await page.wait('.spi-img img', { timeoutMs: 10_000 });
        await pollUntil(() => page.evaluate(count => [...document.querySelectorAll('.spi-img img')].filter(img => img.complete && img.naturalWidth).length >= count, PRESET_SIZES.length), { timeoutMs: 10_000 });
        await sleep(300);
        record('style preset image', null, await inspect({ container: '.spi-img', image: 'img', kind: 'contain', all: true }), { screenshot: await shot('style-preset-images') });
        for (let index = 0; index < PRESET_SIZES.length; index++) {
          await page.click('.spi-img', { nth: index, clickCount: 2 });
          const state = await loaded('.spi-lightbox img');
          const [full] = await inspect({ container: '.spi-lightbox', image: 'img', kind: 'contain' });
          const screenshot = await shot(`style-preset-full-${state.natural}`);
          const clicks = full.picture ? await overlayClicks('.spi-lightbox', 'img', full.picture) : [];
          if (await page.evaluate(() => Boolean(document.querySelector('.spi-lightbox')))) { await page.key('Escape'); await gone('.spi-lightbox'); }
          record('style preset full screen', state.natural, [full], { problems: clicks, screenshot });
        }
        await page.clickText('关闭', { within: '[role="dialog"]', exact: true });
        await gone('.spi-grid');
      });

      // ── Inpaint stage: the source image and its mask canvas ────────────────────────────────────────────────────
      await step(`${label} inpaint stage`, async () => {
        await page.clickText('局部重绘', { within: '.cv-modes', exact: true });
        let previous = null;
        for (let index = 0; index < HISTORY_SIZES.length; index++) {
          // The toast of the previous source (已把图片设为局部重绘的源图) sits over the strip for a few seconds.
          await gone('.ui-toast', 8_000);
          await page.click('.cv-film-item', { nth: index });
          // 用当前图片 (shown while the strip's image is not the source yet).
          const staged = await page.wait('[data-testid="cv-source-current"]', { timeoutMs: 3_000 }).then(() => true).catch(() => false);
          if (staged) await page.click('[data-testid="cv-source-current"]');
          const state = await loaded('.inpaint-stage .inpaint-base-img', { not: staged ? previous : null });
          previous = state.src;
          const [stage] = await inspect({ container: '.inpaint-stage', image: '.inpaint-base-img', kind: 'contain' });
          const mask = await page.evaluate(() => {
            const img = document.querySelector('.inpaint-base-img')?.getBoundingClientRect(), canvas = document.querySelector('.inpaint-mask-canvas')?.getBoundingClientRect();
            if (!img || !canvas) return ['no mask canvas'];
            const off = ['left', 'top', 'width', 'height'].filter(key => Math.abs(img[key] - canvas[key]) > 1);
            return off.length ? [`the mask canvas is not on the image (${off.join(', ')})`] : [];
          });
          record('inpaint stage', state.natural, [stage], { problems: mask, screenshot: await shot(`inpaint-${state.natural}`) });
        }
        await page.clickText('文生图', { within: '.cv-modes', exact: true });
      });
    }

    const errors = page.consoleEntries({ errorsOnly: true });
    steps.push({ step: 'page errors', ok: errors.length === 0, result: { count: errors.length, entries: errors.slice(0, 10) } });
    if (errors.length) failure = new ToolError('page_errors', `The window logged ${errors.length} error(s).`);
    steps.push({ step: 'windows', ok: true, result: applied });
  } catch (error) {
    failure = error;
    if (page) await shot('failure').catch(() => undefined);
  } finally {
    page?.close();
    if (client) await step('test-client stop', () => stopClient({ data })).catch(() => undefined);
    if (fake) await fake.close().catch(() => undefined);
    const seen = await front.stop();
    if (seen.hits.length && !failure) failure = frontDetectedError('the image-fit run', seen);
    steps.push({ step: 'front-app watch', ok: !seen.hits.length, result: { supported: seen.supported, hits: seen.hits, samples: seen.samples, maxGapMs: seen.maxGapMs } });
  }
  const failed = checks.filter(check => !check.ok);
  const byView = {};
  for (const check of checks) { const entry = byView[`${check.window} ${check.view}`] ??= { checks: 0, failed: 0 }; entry.checks++; if (!check.ok) entry.failed++; }
  const ok = !failure && failed.length === 0 && checks.length > 0;
  if (!options.keep && ok) fs.rmSync(data, { recursive: true, force: true });
  const report = {
    ok, out, summary: { checks: checks.length, failed: failed.length, byView },
    failures: failed.map(check => ({ window: check.window, view: check.view, image: check.image, problems: check.problems, container: check.container, imageBox: check.imageBox, picture: check.picture, screenshot: check.screenshot })),
    ...(failure ? { error: { code: failure.code ?? 'failed', message: failure.message, ...(failure.details ? { details: failure.details } : {}) } } : {}),
    steps, checks, screenshots: screenshots.length, shots: path.relative(out, shots), dataKept: fs.existsSync(data),
  };
  fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

await runCli(main);
