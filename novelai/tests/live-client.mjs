#!/usr/bin/env node
// Live acceptance only: real Electron UI, renderer Store, bridge and MCP.
// The sole mock replaces the native file picker with our generated SFW fixture.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridgeClient } from '../src/mcp.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clientRoot = resolve(root, 'client');
const requireClient = createRequire(resolve(clientRoot, 'package.json'));
const sharp = requireClient('sharp');
const executablePath = requireClient('electron');
const run = promisify(execFile);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runtimeDir = resolve(root, '.runtime/acceptance', runId);
const sourcePath = resolve(runtimeDir, 'garden-study.png');
const maskPath = resolve(runtimeDir, 'garden-mask.png');
await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
// The client under test runs on its own data root (NOVELAI_DATA_DIR); its bridge.json is in <data root>/runtime.
const dataDir = resolve(runtimeDir, 'data'), bridgeRuntime = resolve(dataDir, 'runtime');
// Belt and braces: an isolated client already defaults to <data root>/output; also name a throwaway output
// folder in its settings file before the first launch, so no image can land in the real Pictures folder.
const outputDir = resolve(runtimeDir, 'output');
await mkdir(dataDir, { recursive: true, mode: 0o700 });
await writeFile(resolve(dataDir, 'settings.json'), JSON.stringify({ settings: { outputDir } }), { mode: 0o600, flag: 'wx' });
await sharp(await readFile(resolve(root, 'fixtures/garden-study.svg'))).png().toFile(sourcePath);
await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="320" height="320" fill="black"/><ellipse cx="100" cy="165" rx="57" ry="50" fill="white"/></svg>')).png().toFile(maskPath);

const sourceBytes = await readFile(sourcePath);
const maskBytes = await readFile(maskPath);
const hash = value => createHash('sha256').update(value).digest('hex');
const pixelHash = async bytes => hash(await sharp(bytes).ensureAlpha().raw().toBuffer());
const sourcePixels = await pixelHash(sourceBytes);
const inputMaskPixels = await sharp(maskBytes).ensureAlpha().raw().toBuffer();
const expectedMaskAlpha = Buffer.from(Array.from({ length: 320 * 320 }, (_, index) => inputMaskPixels[index * 4] >= 128 ? 255 : 0));
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), runtimeDir, fixtures: { source: 'garden-study.svg', sourcePixelsSha256: sourcePixels, maskSha256: hash(maskBytes), dimensions: [320, 320] }, steps: [], screenshots: [], mcpCalls: [], httpCalls: [], generated: false, novelaiApiCalledByHarness: false, storeOrBridgeMocked: false, nativeFileDialogMocked: true };
let application;
let page;
let mcp;
let phase = 'launch';

async function until(operation, predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    try { value = await operation(); if (predicate(value)) return value; } catch (error) { if (!/(?:unavailable|not_ready)$/.test(error.code ?? '')) throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

function pass(name, details = {}) { report.steps.push({ name, passed: true, ...details }); }
async function screenshot(name) {
  const path = resolve(runtimeDir, name);
  await page.locator('.splash-page').waitFor({ state: 'detached', timeout: 15000 });
  await page.screenshot({ path, fullPage: true });
  report.screenshots.push(path);
}

async function canvasMaskAlpha() {
  const canvas = page.locator('canvas.inpaint-mask-canvas');
  await canvas.waitFor({ state: 'visible' });
  return until(() => canvas.evaluate(element => {
    const context = element.getContext('2d');
    return { width: element.width, height: element.height, protectedAlpha: context.getImageData(10, 10, 1, 1).data[3], selectedAlpha: context.getImageData(100, 165, 1, 1).data[3] };
  }), pixels => pixels.width === 320 && pixels.height === 320 && pixels.protectedAlpha === 0 && pixels.selectedAlpha === 255, 'actual canvas mask protects the black region and selects the white ellipse');
}

async function maskSemantics(imageBytes) {
  const pixels = await sharp(imageBytes).ensureAlpha().raw().toBuffer();
  const alpha = Buffer.from(Array.from({ length: 320 * 320 }, (_, index) => pixels[index * 4 + 3]));
  assert.deepEqual(alpha, expectedMaskAlpha, 'Canonical mask must preserve the complete input black/white selection semantics.');
  return { pngSha256: hash(imageBytes), alphaSha256: hash(alpha), selectedPixels: alpha.filter(value => value === 255).length };
}

try {
  const launchEnv = { ...process.env, NOVELAI_DATA_DIR: dataDir, electron_config_cache: resolve(runtimeDir, 'electron-cache') };
  for (const key of ['VITE_DEV_SERVER_URL', 'NAI_UI_CAPTURE_PATH', 'ELECTRON_RUN_AS_NODE']) delete launchEnv[key];
  application = await electron.launch({
    executablePath, args: [clientRoot], cwd: clientRoot, timeout: 45000,
    env: launchEnv,
  });
  // This does not bypass the load action, image decoder, Store or renderer UI.
  await application.evaluate(({ dialog }, fixturePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixturePath] });
  }, sourcePath);
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const bridge = createBridgeClient({ runtimeDir: bridgeRuntime });
  const http = async (method, args) => { report.httpCalls.push(method); return bridge.call(method, args); };
  const workspaces = await until(() => http('list_workspaces', {}), value => value.workspaces?.length === 1, 'live renderer readiness');
  let workspaceId = workspaces.workspaces[0].workspaceId;
  const read = () => http('read_workspace', { workspaceId });
  await page.getByRole('button', { name: '跳过向导', exact: true }).click();
  await page.locator('.onboarding-backdrop').waitFor({ state: 'detached' });
  await page.getByTestId('workspace-panel').waitFor({ state: 'visible', timeout: 20000 });
  await page.getByTestId('workspace-toggle').click();
  pass('live Electron renderer and authenticated HTTP bridge ready');

  phase = 'manual image and prompt';
  await page.locator('.generate-mode-switcher button').nth(1).click();
  await page.locator('.wb-upload button.full').first().click();
  const thumbnail = page.locator('.wb-thumb');
  await thumbnail.waitFor({ state: 'visible' });
  await until(() => thumbnail.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight })), size => size.width === 320 && size.height === 320, 'actual fixture pixels in UI');
  const prompt = page.getByPlaceholder('输入正面提示词...', { exact: true });
  const manualPrompt = 'SFW landscape illustration, cottage in a quiet garden, daylight, no people';
  await prompt.fill(manualPrompt);
  let state = await until(read, value => value.state.params.positivePrompt === manualPrompt && value.assets.some(asset => asset.role === 'workbenchImage'), 'manual changes in bridge');
  const sourceAssetId = state.assets.find(asset => asset.role === 'workbenchImage').id;
  pass('native file load and manual prompt appear in the same bridge workspace', { revision: state.revision, sourceAssetId });
  await screenshot('01-manual-workspace.png');

  phase = 'MCP read and native image';
  mcp = new Client({ name: 'novelai-live-acceptance', version: '0.1.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [resolve(root, 'src/mcp.mjs')], cwd: root, env: { NOVELAI_DATA_DIR: dataDir, NOVELAI_MCP_AUTOSTART: '0' }, stderr: 'pipe' }));
  const call = async (name, args, expectedError) => {
    report.mcpCalls.push(name);
    const result = await mcp.callTool({ name, arguments: args });
    if (expectedError) {
      assert.equal(result.isError, true, `${name} must fail after a conflicting edit.`);
      assert.equal(result.structuredContent.error.code, expectedError);
      return result;
    }
    assert.ok(!result.isError, `${name}: ${result.content.find(item => item.type === 'text')?.text}`);
    return result;
  };
  const mcpRead = await call('read_workspace', { workspaceId });
  const nativeImage = mcpRead.content.find(item => item.type === 'image');
  assert.ok(nativeImage, 'The visible workbench must be a native MCP image.');
  assert.equal(await pixelHash(Buffer.from(nativeImage.data, 'base64')), sourcePixels);
  assert.ok(mcpRead.structuredContent.imageAttachments.includedAssetIds.includes(sourceAssetId));
  assert.equal(mcpRead.structuredContent.activeImageContext, 'input thumbnail; central result canvas has no image');
  pass('real stdio MCP reads the input thumbnail and explicitly identifies the empty central result canvas');

  phase = 'visible draft and UI apply';
  const firstPrompt = 'SFW landscape illustration, cottage in a quiet garden, sunset, no people';
  let draft = (await call('draft_edit', { workspaceId, expectedRevision: state.revision, patch: { params: { positivePrompt: firstPrompt, model: 'nai-diffusion-5-full' } } })).structuredContent;
  assert.equal(await prompt.inputValue(), manualPrompt);
  assert.equal((await read()).state.params.positivePrompt, manualPrompt);
  const applyButton = page.getByTestId('draft-apply');
  await applyButton.waitFor({ state: 'visible' });
  await screenshot('02-visible-agent-draft.png');
  await applyButton.click();
  state = await until(read, value => value.state.params.positivePrompt === firstPrompt, 'UI applies the agent draft');
  assert.equal(await prompt.inputValue(), firstPrompt);
  assert.equal(state.state.params.model, 'nai-diffusion-5-full');
  pass('MCP draft remains unapplied until actual UI apply', { draftId: draft.draftId, appliedRevision: state.revision });

  phase = 'MCP undo and conflict';
  state = (await call('undo_edit', { workspaceId, expectedRevision: state.revision })).structuredContent;
  assert.equal(state.state.params.positivePrompt, manualPrompt);
  assert.equal(await prompt.inputValue(), manualPrompt);
  pass('MCP undo updates the actual UI');
  draft = (await call('draft_edit', { workspaceId, expectedRevision: state.revision, patch: { params: { positivePrompt: firstPrompt } } })).structuredContent;
  const protectedPrompt = 'SFW garden illustration, user manually selected a cloudy afternoon';
  await prompt.fill(protectedPrompt);
  state = await until(read, value => value.state.params.positivePrompt === protectedPrompt, 'manual conflict state');
  await call('apply_edit', { workspaceId, expectedRevision: state.revision, draftId: draft.draftId }, 'conflict');
  assert.equal(await prompt.inputValue(), protectedPrompt);
  draft = (await call('draft_edit', { workspaceId, expectedRevision: state.revision, patch: { params: { positivePrompt: firstPrompt } } })).structuredContent;
  state = (await call('apply_edit', { workspaceId, expectedRevision: state.revision, draftId: draft.draftId })).structuredContent;
  await prompt.fill(protectedPrompt);
  state = await until(read, value => value.state.params.positivePrompt === protectedPrompt, 'manual edit after apply');
  await call('undo_edit', { workspaceId, expectedRevision: state.revision }, 'conflict');
  assert.equal(await prompt.inputValue(), protectedPrompt);
  pass('manual edits reject both stale draft application and stale undo');

  phase = 'references and mask';
  draft = (await call('draft_edit', { workspaceId, expectedRevision: state.revision, patch: {
    params: { model: 'nai-diffusion-5-full', metadataReplay: { model: 'nai-diffusion-5-full', parameters: { quality_boost: true }, positive: {}, negative: {}, keepEmptyNegativeCharacters: false } },
    charCaptions: [{ id: 'adult-a', prompt: 'adult gardener in a blue jacket', negativePrompt: '', useCoords: false, x: 0.25, y: 0.5 }, { id: 'adult-b', prompt: 'adult visitor in a green jacket', negativePrompt: '', useCoords: false, x: 0.75, y: 0.5 }],
    vibeImages: [{ id: 'garden-vibe', assetId: sourceAssetId, strength: 0.6, infoExtracted: 0.7 }],
    preciseReferences: [{ id: 'garden-precise', assetId: sourceAssetId, type: 'style', strength: 0.5, fidelity: 0.7 }],
    inpaintMask: maskBytes.toString('base64'), inpaintStrength: 0.4, inpaintNoise: 0.1,
  } })).structuredContent;
  state = (await call('apply_edit', { workspaceId, expectedRevision: state.revision, draftId: draft.draftId })).structuredContent;
  assert.equal(state.state.charCaptions.length, 2);
  assert.equal(state.state.vibeImages.length, 1);
  assert.equal(state.state.preciseReferences.length, 1);
  assert.equal(state.state.params.metadataReplay.parameters.quality_boost, true);
  assert.ok(state.assets.some(asset => asset.role === 'inpaintMask'));
  assert.equal(state.capabilities.generation, true);
  await page.locator('[data-tab="inpaint"]').click();
  state = await until(read, value => value.state.activeTab === 'inpaint', 'mask preview on the inpaint surface');
  const canvasMask = await canvasMaskAlpha();
  const maskAsset = state.assets.find(asset => asset.role === 'inpaintMask');
  const maskResult = await call('get_asset', { workspaceId, expectedRevision: state.revision, assetId: maskAsset.id });
  const normalizedMask = await maskSemantics(Buffer.from(maskResult.content.find(item => item.type === 'image').data, 'base64'));
  report.maskVerification = { input: 'opaque black background with white ellipse; brightness threshold 128', normalizedMask, canvasMask };
  await screenshot('03-mask.png');
  pass('V5 creative state, both references, mask and both characters applied without generation');

  phase = 'actual inpaint surface';
  const inpaintImage = page.locator('.inpaint-base-img');
  await inpaintImage.waitFor({ state: 'visible' });
  await until(() => inpaintImage.evaluate(image => image.naturalWidth), width => width === 320, 'source pixels on the actual editing surface');
  assert.equal(state.activeImageAssetId, sourceAssetId);
  assert.equal(state.activeImageContext, 'current editing surface');
  report.maskVerification.inpaintCanvasMask = await canvasMaskAlpha();
  const toggle = page.getByTestId('workspace-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  await screenshot('04-inpaint-image-and-workspace.png');
  pass('actual inpaint UI displays the source image and mask with workspace controls');

  phase = 'renderer reload';
  const previousWorkspaceId = workspaceId;
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  const next = await until(() => http('list_workspaces', {}), value => value.workspaces?.length === 1 && value.workspaces[0].workspaceId !== previousWorkspaceId, 'fresh renderer workspace');
  workspaceId = next.workspaces[0].workspaceId;
  await assert.rejects(http('read_workspace', { workspaceId: previousWorkspaceId }), error => error.code === 'workspace_mismatch');
  pass('renderer reload invalidates the old workspace', { workspaceId });
  state = await read();
  assert.equal(state.activity.isGenerating, false);
  assert.equal(state.activity.queue.length, 0);
  report.ok = true;
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.ok = false;
  report.failedPhase = phase;
  report.error = error instanceof Error ? error.message : 'Acceptance failed.';
  if (page && !page.isClosed()) await screenshot('failure.png').catch(() => {});
  process.exitCode = 1;
} finally {
  await mcp?.close().catch(() => {});
  await application?.close().catch(() => {});
  await writeFile(resolve(runtimeDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, report: resolve(runtimeDir, 'report.json'), failedPhase: report.failedPhase, error: report.error, passedSteps: report.steps.length, generated: false }));
}
