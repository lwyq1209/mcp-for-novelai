import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginInpaintDiagnosticCapture, finishInpaintDiagnosticCapture, type InpaintDiagnosticCaptureOptions } from "./inpaint-diagnostics";

let temporary: string;
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "nai-inpaint-diagnostic-test-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(temporary, { recursive: true, force: true }); });

function png(color: number) {
  const image = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = color; image.data[i + 1] = color; image.data[i + 2] = color; image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}

function fixture(): InpaintDiagnosticCaptureOptions {
  return {
    enabled: true, rootDir: path.join(temporary, "new-root", "inpaint-diagnostics"),
    sourcePng: png(20), requestMaskPng: png(255), blendAlpha: Uint8Array.from({ length: 64 }, (_, i) => i),
    width: 8, height: 8, rawBuffers: [png(180)], jobId: "test-job-1",
    request: { input: "brooch, silver jewelry", model: "nai-diffusion-5-full-inpainting", action: "infill", parameters: {
      width: 8, height: 8, steps: 28, seed: 20260910, scale: 6, sampler: "k_euler_ancestral", noise_schedule: "karras",
      uc: "text, watermark", negative_prompt: "text, watermark", strength: 0.7, inpaintImg2ImgStrength: 1,
      noise: 0, add_original_image: false, v4_prompt: { caption: { base_caption: "brooch, silver jewelry", char_captions: [] }, use_coords: false, use_order: true, legacy_uc: false },
      v4_negative_prompt: { caption: { base_caption: "text, watermark", char_captions: [] }, use_coords: false, use_order: false, legacy_uc: false },
    } },
  };
}

async function manifest(directory: string) { return JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")); }

describe("opt-in local inpaint diagnostic capture", () => {
  it("keeps source, request mask and every raw response byte unchanged before compositing", async () => {
    const options = fixture(); options.rawBuffers.push(png(210));
    const handle = await beginInpaintDiagnosticCapture(options);
    expect(handle.status).toBe("saved");
    expect(await fs.readFile(path.join(handle.directory!, "source.png"))).toEqual(options.sourcePng);
    expect(await fs.readFile(path.join(handle.directory!, "request-mask.png"))).toEqual(options.requestMaskPng);
    for (const [index, buffer] of options.rawBuffers.entries()) expect(await fs.readFile(path.join(handle.directory!, `raw-${index}.png`))).toEqual(buffer);
    const saved = await manifest(handle.directory!);
    expect(saved).toMatchObject({ schemaVersion: 1, stage: "pre-composite", jobId: options.jobId, processing: { width: 8, height: 8 }, request: options.request });
    expect(saved.files.raw[0]).toEqual({ file: "raw-0.png", width: 8, height: 8, decoded: true, bytes: options.rawBuffers[0].length, sha256: createHash("sha256").update(options.rawBuffers[0]).digest("hex") });
    expect(saved.files.composite).toBeUndefined();
    const alpha = PNG.sync.read(await fs.readFile(path.join(handle.directory!, "blend-alpha.png")));
    for (let i = 0; i < 64; i++) expect([...alpha.data.subarray(i * 4, i * 4 + 4)]).toEqual([i, i, i, 255]);
  });

  it("stores composites separately and advances the manifest without replacing raw files", async () => {
    const options = fixture(), handle = await beginInpaintDiagnosticCapture(options), composite = png(35);
    expect((await finishInpaintDiagnosticCapture(handle, [composite])).status).toBe("saved");
    expect(await fs.readFile(path.join(handle.directory!, "raw-0.png"))).toEqual(options.rawBuffers[0]);
    expect(await fs.readFile(path.join(handle.directory!, "composite-0.png"))).toEqual(composite);
    const saved = await manifest(handle.directory!);
    expect(saved.stage).toBe("complete"); expect(saved.completedAt).toEqual(expect.any(String));
    expect(saved.files.composite[0].sha256).not.toBe(saved.files.raw[0].sha256);
    expect((await finishInpaintDiagnosticCapture(handle, [png(99)])).status).toBe("saved");
    expect(await fs.readFile(path.join(handle.directory!, "composite-0.png"))).toEqual(composite);
  });

  it("drops injected credentials, arbitrary fields, image base64 and nested extras", async () => {
    const options = fixture(), parameters = options.request.parameters as Record<string, unknown>;
    Object.assign(options.request, { headers: { Authorization: "secret-header" }, token: "secret-token", cookie: "secret-cookie", config: { proxy: "secret-proxy" } });
    Object.assign(parameters, { token: "secret-param", image: "secret-image-base64", mask: "secret-mask-base64", extra_passthrough_testing: { token: "secret-extra" }, director_reference_images: ["secret-ref"], sampler: "secret-as-sampler" });
    parameters.img2img = { strength: 0.6, color_correct: true, image: "secret-nested-image", headers: { Cookie: "secret-nested-cookie" } };
    parameters.v4_prompt = { caption: { base_caption: "silver brooch", char_captions: [{ char_caption: "red shirt", centers: [{ x: 0.5, y: 0.4, token: "secret-center" }], token: "secret-character" }], token: "secret-caption" }, use_order: true, token: "secret-structured" };
    const handle = await beginInpaintDiagnosticCapture(options), saved = await manifest(handle.directory!);
    expect(JSON.stringify(saved)).not.toContain("secret-");
    expect(saved.request.parameters).not.toHaveProperty("image"); expect(saved.request.parameters).not.toHaveProperty("mask");
    expect(saved.request.parameters.img2img).toEqual({ strength: 0.6, color_correct: true });
    expect(saved.request.parameters.v4_prompt).toEqual({ use_order: true, caption: { base_caption: "silver brooch", char_captions: [{ char_caption: "red shirt", centers: [{ x: 0.5, y: 0.4 }] }] } });
  });

  it("does no filesystem IO while disabled, including finish", async () => {
    const options = fixture(); options.enabled = false;
    const mkdir = vi.spyOn(fs, "mkdir"), write = vi.spyOn(fs, "writeFile"), read = vi.spyOn(fs, "readFile"), rename = vi.spyOn(fs, "rename");
    Object.defineProperty(options, "rootDir", { get() { throw new Error("Disabled capture must not inspect the directory"); } });
    const handle = await beginInpaintDiagnosticCapture(options);
    expect(handle).toEqual({ status: "disabled" }); expect(await finishInpaintDiagnosticCapture(handle, [])).toBe(handle);
    expect(mkdir).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled();
  });

  it("creates missing directories privately and never overwrites another capture", async () => {
    const options = fixture(), first = await beginInpaintDiagnosticCapture(options), second = await beginInpaintDiagnosticCapture(options);
    expect(first.status).toBe("saved"); expect(second.status).toBe("saved"); expect(first.directory).not.toBe(second.directory);
    expect(path.dirname(first.directory!)).toBe(options.rootDir);
    expect(path.basename(first.directory!)).toMatch(/^[0-9a-f-]{36}$/);
    if (process.platform !== "win32") {
      expect((await fs.stat(first.directory!)).mode & 0o777).toBe(0o700);
      for (const file of await fs.readdir(first.directory!)) expect((await fs.stat(path.join(first.directory!, file))).mode & 0o777).toBe(0o600);
    }
  });

  it("returns failed rather than throwing on a directory error", async () => {
    const options = fixture(); options.rootDir = path.join(temporary, "not-a-directory"); await fs.writeFile(options.rootDir, "existing file");
    await expect(beginInpaintDiagnosticCapture(options)).resolves.toEqual({ status: "failed" });
    expect(await fs.readFile(options.rootDir, "utf8")).toBe("existing file");
  });

  it("retains raw evidence and the pre-composite manifest if final writes fail", async () => {
    const options = fixture(), handle = await beginInpaintDiagnosticCapture(options);
    vi.spyOn(fs, "writeFile").mockRejectedValueOnce(new Error("disk full"));
    await expect(finishInpaintDiagnosticCapture(handle, [png(99)])).resolves.toEqual({ status: "failed", directory: handle.directory });
    expect(await fs.readFile(path.join(handle.directory!, "raw-0.png"))).toEqual(options.rawBuffers[0]);
    expect((await manifest(handle.directory!)).stage).toBe("pre-composite");
  });

  it("retains raw evidence if updating the manifest fails", async () => {
    const options = fixture(), handle = await beginInpaintDiagnosticCapture(options);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
    expect((await finishInpaintDiagnosticCapture(handle, [png(55)])).status).toBe("failed");
    expect(await fs.readFile(path.join(handle.directory!, "raw-0.png"))).toEqual(options.rawBuffers[0]);
    expect((await manifest(handle.directory!)).stage).toBe("pre-composite");
  });

  it("keeps unexpected response bytes instead of destroying potentially useful evidence", async () => {
    const options = fixture(); options.rawBuffers = [Buffer.from("unexpected non-PNG response member")];
    const handle = await beginInpaintDiagnosticCapture(options);
    expect(handle.status).toBe("saved"); expect(await fs.readFile(path.join(handle.directory!, "raw-0.bin"))).toEqual(options.rawBuffers[0]);
    expect((await manifest(handle.directory!)).files.raw[0]).toMatchObject({ decoded: false, width: null, height: null });
  });

  it("preserves JPEG and WebP bytes with their real extensions and actual dimensions", async () => {
    const options = fixture(), jpeg = await sharp(png(120)).resize(16, 10).jpeg().toBuffer(), webp = await sharp(png(180)).resize(12, 14).webp().toBuffer();
    options.rawBuffers = [jpeg, webp];
    const handle = await beginInpaintDiagnosticCapture(options), saved = await manifest(handle.directory!);
    expect(saved.files.raw).toMatchObject([{ file: "raw-0.jpg", decoded: true, width: 16, height: 10 }, { file: "raw-1.webp", decoded: true, width: 12, height: 14 }]);
    expect(await fs.readFile(path.join(handle.directory!, "raw-0.jpg"))).toEqual(jpeg);
    expect(await fs.readFile(path.join(handle.directory!, "raw-1.webp"))).toEqual(webp);
    expect((await finishInpaintDiagnosticCapture(handle, [png(35)])).status).toBe("saved");
    expect((await manifest(handle.directory!)).files.composite[0].file).toBe("composite-0.png");
  });

  it("rejects an invalid alpha size without throwing or creating a capture directory", async () => {
    const options = fixture(); options.blendAlpha = new Uint8Array(1);
    expect(await beginInpaintDiagnosticCapture(options)).toEqual({ status: "failed" });
    await expect(fs.stat(options.rootDir)).rejects.toThrow();
  });

  it("does not accept forged handles or redirect writes through a mutated public directory", async () => {
    const options = fixture(), handle = await beginInpaintDiagnosticCapture(options), trusted = handle.directory!;
    const forged = { status: "saved" as const, directory: temporary };
    expect(await finishInpaintDiagnosticCapture(forged, [png(77)])).toEqual({ status: "failed" });
    handle.directory = temporary;
    expect((await finishInpaintDiagnosticCapture(handle, [png(77)])).status).toBe("saved");
    expect(await fs.readFile(path.join(trusted, "composite-0.png"))).toEqual(png(77));
    await expect(fs.stat(path.join(temporary, "composite-0.png"))).rejects.toThrow();
  });
});
