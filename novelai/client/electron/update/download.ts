// Downloads of update files: only from allowed URLs, redirects checked one by one, through the app's proxy setting,
// with a size limit, a stall timeout, cancellation, resumption of an interrupted download (HTTP Range) and the
// SHA-256 of what arrived and of what was written (read back from the disk). No URL with its query (GitHub's signed download links) ever reaches a message or log.
import axios from "axios";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { Readable } from "node:stream";
import { USER_AGENT } from "../../src/types";

export type DownloadErrorCode = "redirect_refused" | "http_status" | "too_large" | "network" | "cancelled" | "stalled" | "checksum_mismatch";

export class DownloadError extends Error {
  constructor(readonly code: DownloadErrorCode, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadRequest {
  /** The first URL (it must pass `allows` too). */
  url: string;
  /** Whether a URL may be requested: the first one and every redirect target. */
  allows(url: URL): boolean;
  /** The largest body accepted. */
  maxBytes: number;
  signal?: AbortSignal;
  /** Extra request configuration of every request (the proxy agents of the "update" category). */
  requestConfig?: () => Record<string, unknown>;
  /** Until the response headers arrive. */
  timeoutMs?: number;
  /** Longest time without a byte of the body. */
  stallMs?: number;
  maxRedirects?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_STALL_MS = 60_000;
const DEFAULT_MAX_REDIRECTS = 5;

/** host only: never the path or the query of a download link. */
const hostOf = (url: URL) => url.host;

interface Opened { stream: Readable; status: number; headers: Record<string, unknown>; url: URL }

/** One GET that follows redirects by hand, each target checked by `allows`. */
async function open(request: DownloadRequest, headers: Record<string, string>): Promise<Opened> {
  let url: URL;
  try { url = new URL(request.url); } catch { throw new DownloadError("redirect_refused", "The download address is not a URL.", false); }
  for (let hop = 0; ; hop++) {
    if (!request.allows(url)) throw new DownloadError("redirect_refused", `The download was refused: ${hostOf(url)} is not an allowed update address.`, false);
    if (request.signal?.aborted) throw new DownloadError("cancelled", "The download was cancelled.", true);
    let response;
    try {
      response = await axios.get(url.toString(), {
        responseType: "stream", maxRedirects: 0, decompress: false, validateStatus: () => true,
        timeout: request.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal: request.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "application/octet-stream", ...headers },
        ...(request.requestConfig?.() ?? {}),
      });
    } catch (error: any) {
      if (request.signal?.aborted) throw new DownloadError("cancelled", "The download was cancelled.", true);
      throw new DownloadError("network", `The download from ${hostOf(url)} failed (${error?.code ?? "network error"}).`, true);
    }
    const status = response.status;
    if (status >= 300 && status < 400) {
      (response.data as Readable)?.destroy?.();
      const location = response.headers?.location;
      if (typeof location !== "string" || !location) throw new DownloadError("redirect_refused", `${hostOf(url)} redirected without a target.`, false);
      if (hop >= (request.maxRedirects ?? DEFAULT_MAX_REDIRECTS)) throw new DownloadError("redirect_refused", "The download was redirected too often.", false);
      let next: URL;
      try { next = new URL(location, url); } catch { throw new DownloadError("redirect_refused", `${hostOf(url)} redirected to an address that is not a URL.`, false); }
      url = next;
      continue;
    }
    return { stream: response.data as Readable, status, headers: response.headers ?? {}, url };
  }
}

const headerNumber = (value: unknown) => { const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN; return Number.isSafeInteger(n) && n >= 0 ? n : null; };

/** Reads a stream to its end with the size limit and the stall timeout; `onChunk` sees every chunk. */
function drain(stream: Readable, request: DownloadRequest, already: number, onChunk: (chunk: Buffer) => void | Promise<void>): Promise<number> {
  return new Promise((resolve, reject) => {
    let received = already, settled = false, stall: NodeJS.Timeout | undefined;
    const stallMs = request.stallMs ?? DEFAULT_STALL_MS;
    const finish = (error: DownloadError | null) => {
      if (settled) return; settled = true;
      if (stall) clearTimeout(stall);
      request.signal?.removeEventListener("abort", onAbort);
      if (error) { stream.destroy(); reject(error); } else resolve(received);
    };
    const arm = () => { if (stall) clearTimeout(stall); stall = setTimeout(() => finish(new DownloadError("stalled", `No data arrived for ${Math.round(stallMs / 1000)} s.`, true)), stallMs); };
    const onAbort = () => finish(new DownloadError("cancelled", "The download was cancelled.", true));
    request.signal?.addEventListener("abort", onAbort);
    arm();
    stream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > request.maxBytes) { finish(new DownloadError("too_large", "The download is larger than an update file can be.", false)); return; }
      arm();
      const pending = onChunk(chunk);
      if (pending) { stream.pause(); pending.then(() => stream.resume(), error => finish(new DownloadError("network", `The download could not be written (${error?.code ?? error}).`, true))); }
    });
    stream.once("end", () => finish(null));
    stream.once("error", (error: any) => finish(request.signal?.aborted ? new DownloadError("cancelled", "The download was cancelled.", true) : new DownloadError("network", `The download broke off (${error?.code ?? "connection closed"}).`, true)));
    stream.once("aborted", () => finish(new DownloadError("network", "The download broke off.", true)));
  });
}

/** A small file (SHA256SUMS.txt, its signature) into memory. */
export async function downloadSmall(request: DownloadRequest): Promise<Buffer> {
  const opened = await open(request, {});
  if (opened.status !== 200) { opened.stream?.destroy?.(); throw new DownloadError("http_status", `${hostOf(opened.url)} answered HTTP ${opened.status}.`, opened.status >= 500 || opened.status === 429); }
  const length = headerNumber(opened.headers["content-length"]);
  if (length !== null && length > request.maxBytes) { opened.stream.destroy(); throw new DownloadError("too_large", "The file is larger than expected.", false); }
  const chunks: Buffer[] = [];
  await drain(opened.stream, request, 0, chunk => { chunks.push(chunk); });
  return Buffer.concat(chunks);
}

export interface FileDownload extends DownloadRequest {
  /** The finished file; the bytes go to `<destination>.part` until the download is complete and checked. */
  destination: string;
  /** Lowercase hex: the finished file must have this SHA-256, else it is deleted (checksum_mismatch). */
  expectedSha256: string;
  onProgress?(received: number, total: number | null): void;
}

/** SHA-256 of a file's current content (a partial download being resumed). */
async function hashFile(file: string, hash: ReturnType<typeof createHash>): Promise<number> {
  let size = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return size;
}

/**
 * Downloads one file to `destination`, resuming `<destination>.part` when the server honours a Range request (206 with
 * a matching Content-Range; anything else starts over). The finished bytes must have `expectedSha256`; only then is
 * the part file renamed to `destination`. A failure leaves the part file for a retry (except a wrong checksum or a
 * refused address, which delete it).
 */
export async function downloadFile(request: FileDownload): Promise<{ bytes: number; sha256: string }> {
  const part = `${request.destination}.part`;
  const hash = createHash("sha256");
  let offset = 0;
  try { offset = (await fsp.stat(part)).size; } catch { offset = 0; }
  if (offset > request.maxBytes) { await fsp.rm(part, { force: true }); offset = 0; }
  let opened: Opened;
  try { opened = await open(request, offset > 0 ? { Range: `bytes=${offset}-` } : {}); }
  catch (error) { if (error instanceof DownloadError && error.code === "redirect_refused") await fsp.rm(part, { force: true }); throw error; }
  let total: number | null = null;
  if (offset > 0 && opened.status === 206) {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(opened.headers["content-range"] ?? ""));
    if (!range || Number(range[1]) !== offset) { opened.stream.destroy(); await fsp.rm(part, { force: true }); throw new DownloadError("network", "The server resumed the download at the wrong place; it starts over on the next try.", true); }
    total = Number(range[3]);
    await hashFile(part, hash);
  } else if (opened.status === 200) {
    offset = 0;
    total = headerNumber(opened.headers["content-length"]);
  } else if (opened.status === 416 && offset > 0) {
    // The part file is already complete (or longer than the file): start over.
    opened.stream?.destroy?.();
    await fsp.rm(part, { force: true });
    throw new DownloadError("network", "The partial download did not fit; it starts over on the next try.", true);
  } else {
    opened.stream?.destroy?.();
    throw new DownloadError("http_status", `${hostOf(opened.url)} answered HTTP ${opened.status}.`, opened.status >= 500 || opened.status === 429 || opened.status === 408);
  }
  if (total !== null && total > request.maxBytes) { opened.stream.destroy(); throw new DownloadError("too_large", "The download is larger than an update file can be.", false); }
  const out = await fsp.open(part, offset > 0 ? "a" : "w", 0o600);
  let received: number, written = offset;
  try {
    let lastProgress = 0;
    request.onProgress?.(offset, total);
    received = await drain(opened.stream, request, offset, async chunk => {
      hash.update(chunk);
      await out.write(chunk);
      written += chunk.length;
      const now = Date.now();
      if (now - lastProgress >= 200) { lastProgress = now; request.onProgress?.(written, total); }
    });
    await out.sync();
  } finally {
    await out.close().catch(() => undefined);
  }
  request.onProgress?.(received, total);
  if (total !== null && received !== total) throw new DownloadError("network", "The download ended early.", true);
  const sha256 = hash.digest("hex");
  // Both what arrived and what is on the disk now (a short write or a changed file) must have the signed checksum.
  const readBack = createHash("sha256");
  const size = await hashFile(part, readBack);
  const onDisk = readBack.digest("hex");
  if (sha256 !== request.expectedSha256.toLowerCase() || onDisk !== sha256 || size !== received) {
    await fsp.rm(part, { force: true });
    throw new DownloadError("checksum_mismatch", "The downloaded file does not match the signed checksum.", false);
  }
  await fsp.rename(part, request.destination);
  return { bytes: received, sha256 };
}
