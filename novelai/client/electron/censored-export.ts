import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { CENSORED_EXPORT_LIMITS as limits, censoredExportStem, type CensoredExportResult } from '../src/censor/export-types';

/**
 * JPEG bytes of opaque RGBA pixels. The encoder gets pixels only, so the file carries no EXIF, XMP, ICC profile,
 * comment or text of any kind (sharp writes none unless asked), and JPEG has no alpha channel for NovelAI's stealth
 * data to live in. Full-resolution chroma (4:4:4): mosaic cell edges and line art stay clean.
 */
export async function encodeCensoredJpeg(pixels: Uint8Array, width: number, height: number, quality: number): Promise<Buffer> {
  return sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), { raw: { width, height, channels: 4 }, limitInputPixels: limits.pixels })
    .removeAlpha().jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true }).timeout({ seconds: 30 }).toBuffer();
}

type Session = { id: string; mode: 'file' | 'folder'; target: string; count: number; written: string[] };
const invalid = (): never => { throw new Error('invalid'); };

/** `<stem>.jpg` in the folder, or `<stem> (2).jpg`… when taken; an existing file is never replaced. */
async function writeNew(folder: string, stem: string, bytes: Buffer): Promise<string> {
  for (let attempt = 1; attempt <= 999; attempt++) {
    const file = path.join(folder, attempt === 1 ? `${stem}.jpg` : `${stem} (${attempt}).jpg`);
    try { await fs.writeFile(file, bytes, { flag: 'wx' }); return file; }
    catch (error: any) { if (error?.code !== 'EEXIST') throw error; }
  }
  throw new Error('names');
}
/** The file the user chose in the save dialog (which asked before replacing): written beside it first, then renamed. */
async function writeChosen(file: string, bytes: Buffer): Promise<string> {
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  try { await fs.writeFile(temporary, bytes, { flag: 'wx' }); await fs.rename(temporary, file); }
  catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
  return file;
}

export function createCensoredExporter(options: { chooseFile(defaultName: string): Promise<string | undefined>; chooseFolder(): Promise<string | undefined> }) {
  let session: Session | null = null;
  const current = (id: unknown): Session => session && id === session.id ? session : invalid();
  return async (raw: unknown): Promise<CensoredExportResult> => {
    const args = raw && typeof raw === 'object' ? raw as Record<string, unknown> : invalid();
    if (args.action === 'begin') {
      const count = args.count as number;
      if (!Number.isSafeInteger(count) || count < 1 || count > limits.images) return invalid();
      session = null;
      if (count === 1) {
        const chosen = await options.chooseFile(`${censoredExportStem(args.name)}.jpg`);
        if (!chosen) return { status: 'cancelled' };
        if (!path.isAbsolute(chosen)) return invalid();
        const file = /\.jpe?g$/i.test(chosen) ? chosen : `${chosen}.jpg`;
        session = { id: randomUUID(), mode: 'file', target: file, count, written: [] };
      } else {
        const chosen = await options.chooseFolder();
        if (!chosen) return { status: 'cancelled' };
        if (!path.isAbsolute(chosen) || !(await fs.stat(chosen)).isDirectory()) return invalid();
        session = { id: randomUUID(), mode: 'folder', target: chosen, count, written: [] };
      }
      return { status: 'ready', session: session.id };
    }
    if (args.action === 'write') {
      const active = current(args.session);
      const width = args.width as number, height = args.height as number, quality = args.quality as number, pixels = args.pixels;
      if (active.written.length >= active.count) return invalid();
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > limits.pixels) return invalid();
      if (!Number.isSafeInteger(quality) || quality < limits.minQuality || quality > limits.maxQuality) return invalid();
      if (!(pixels instanceof Uint8Array) || pixels.byteLength !== width * height * 4) return invalid();
      const bytes = await encodeCensoredJpeg(pixels, width, height, quality);
      const file = active.mode === 'file' ? await writeChosen(active.target, bytes) : await writeNew(active.target, censoredExportStem(args.name), bytes);
      active.written.push(file);
      return { status: 'written', bytes: bytes.length, file: path.basename(file) };
    }
    if (args.action === 'finish') {
      const active = current(args.session);
      session = null;
      return { status: 'done', written: active.written.length, reveal: active.written[0] ?? null };
    }
    return invalid();
  };
}

/** Dedicated desktop IPC (like the image export): only the main window's main frame may call it. */
export async function handleCensoredExport(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, window: BrowserWindow | null, args: unknown, run: (args: unknown) => Promise<CensoredExportResult>) {
  if (!window || window.isDestroyed() || event.sender.id !== window.webContents.id || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: { code: 'forbidden_workspace', message: 'Image exports are accepted only from the current main window.', reason: 'library.export_window_only' } };
  try { return { ok: true, result: await run(args) }; }
  catch { return { ok: false, error: { code: 'export_failed', message: 'The image was not exported. Check the destination and try again.', reason: 'library.censored_export_failed' } }; }
}
