// Update downloads (download.ts) against real loopback HTTP servers: redirects checked one by one, refusals, size
// limits, stalls, cancellation, resumption with Range, servers that ignore Range, and the SHA-256 check.
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadFile, downloadSmall, DownloadError } from "./download";

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;
const servers: http.Server[] = [];
async function serve(handler: Handler) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "nai-update-download-")); });
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(dir, { recursive: true, force: true });
});

const body = Buffer.alloc(300_000, 0).map((_, index) => (index * 7) % 251);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const onlyLoopback = (url: URL) => url.hostname === "127.0.0.1";
const code = async (promise: Promise<unknown>) => { try { await promise; return "ok"; } catch (error) { return error instanceof DownloadError ? error.code : String(error); } };

describe("downloadFile", () => {
  it("downloads through an allowed redirect, reports progress and checks the SHA-256", async () => {
    const assets = await serve((_request, response) => { response.writeHead(200, { "content-length": body.length }); response.end(body); });
    const github = await serve((_request, response) => { response.writeHead(302, { location: `${assets}/blob?sig=secret` }); response.end(); });
    const seen: Array<[number, number | null]> = [];
    const destination = path.join(dir, "app.zip");
    const result = await downloadFile({ url: `${github}/release/app.zip`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1e7, onProgress: (received, total) => seen.push([received, total]) });
    expect(result).toEqual({ bytes: body.length, sha256: sha(body) });
    expect(fs.readFileSync(destination).equals(body)).toBe(true);
    expect(fs.existsSync(`${destination}.part`)).toBe(false);
    expect(seen.at(-1)).toEqual([body.length, body.length]);
  });

  it("refuses a redirect to a host that is not allowed, without requesting it, and keeps no partial file", async () => {
    let requested = false;
    const other = await serve((_request, response) => { requested = true; response.end(body); });
    const otherPort = new URL(other).port;
    const github = await serve((_request, response) => { response.writeHead(302, { location: `${other}/x` }); response.end(); });
    const destination = path.join(dir, "app.zip");
    fs.writeFileSync(`${destination}.part`, "old");
    const error = await downloadFile({ url: `${github}/a`, allows: url => url.port !== otherPort, destination, expectedSha256: sha(body), maxBytes: 1e7 }).catch(e => e);
    expect(error).toBeInstanceOf(DownloadError);
    expect(error.code).toBe("redirect_refused");
    expect(error.message).not.toContain("/x");
    expect(requested).toBe(false);
    expect(fs.existsSync(`${destination}.part`)).toBe(false);
    // The first URL is checked too, and redirect loops end.
    expect(await code(downloadFile({ url: `${github}/a`, allows: () => false, destination, expectedSha256: sha(body), maxBytes: 1e7 }))).toBe("redirect_refused");
    const loop = await serve((request, response) => { response.writeHead(302, { location: `/${Number(request.url!.slice(1)) + 1}` }); response.end(); });
    expect(await code(downloadFile({ url: `${loop}/0`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1e7 }))).toBe("redirect_refused");
    const noTarget = await serve((_request, response) => { response.writeHead(302); response.end(); });
    expect(await code(downloadFile({ url: `${noTarget}/0`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1e7 }))).toBe("redirect_refused");
  });

  it("deletes a file whose SHA-256 differs from the signed one (a tampered release file)", async () => {
    const tampered = Buffer.from(body); tampered[1000] ^= 0xff;
    const server = await serve((_request, response) => { response.end(tampered); });
    const destination = path.join(dir, "app.zip");
    expect(await code(downloadFile({ url: `${server}/a`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1e7 }))).toBe("checksum_mismatch");
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.existsSync(`${destination}.part`)).toBe(false);
  });

  it("resumes a broken download with a Range request and checks the whole file", async () => {
    const ranges: Array<string | undefined> = [];
    let first = true;
    const server = await serve((request, response) => {
      ranges.push(request.headers.range);
      if (first) { first = false; response.writeHead(200, { "content-length": body.length }); response.write(body.subarray(0, 120_000)); setTimeout(() => response.destroy(), 30); return; }
      const start = Number(/bytes=(\d+)-/.exec(request.headers.range ?? "")?.[1] ?? 0);
      response.writeHead(206, { "content-range": `bytes ${start}-${body.length - 1}/${body.length}`, "content-length": body.length - start });
      response.end(body.subarray(start));
    });
    const destination = path.join(dir, "app.zip");
    const request = { url: `${server}/a`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1e7 };
    const broken = await downloadFile(request).catch(e => e);
    expect(broken.code).toBe("network");
    expect(broken.retryable).toBe(true);
    const kept = fs.statSync(`${destination}.part`).size;
    expect(kept).toBeGreaterThan(0);
    await downloadFile(request);
    expect(ranges).toEqual([undefined, `bytes=${kept}-`]);
    expect(fs.readFileSync(destination).equals(body)).toBe(true);
  });

  it("starts over when the server ignores Range, and refuses a resumption at the wrong place", async () => {
    const destination = path.join(dir, "app.zip");
    fs.writeFileSync(`${destination}.part`, body.subarray(0, 5000));
    const ignoring = await serve((_request, response) => { response.writeHead(200, { "content-length": body.length }); response.end(body); });
    await downloadFile({ url: `${ignoring}/a`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1e7 });
    expect(fs.readFileSync(destination).equals(body)).toBe(true);
    fs.rmSync(destination);
    fs.writeFileSync(`${destination}.part`, body.subarray(0, 5000));
    const wrong = await serve((_request, response) => { response.writeHead(206, { "content-range": `bytes 10-${body.length - 1}/${body.length}` }); response.end(body.subarray(10)); });
    expect(await code(downloadFile({ url: `${wrong}/a`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1e7 }))).toBe("network");
    expect(fs.existsSync(`${destination}.part`)).toBe(false);
  });

  it("stops at the size limit, a stalled connection, an HTTP error and a cancellation", async () => {
    const destination = path.join(dir, "app.zip");
    const big = await serve((_request, response) => { response.writeHead(200, { "content-length": body.length }); response.end(body); });
    expect(await code(downloadFile({ url: `${big}/a`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1000 }))).toBe("too_large");
    const unsized = await serve((_request, response) => { response.writeHead(200); response.end(body); });
    expect(await code(downloadFile({ url: `${unsized}/a`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1000 }))).toBe("too_large");
    const stalling = await serve((_request, response) => { response.writeHead(200, { "content-length": body.length }); response.write(body.subarray(0, 10)); });
    const stalled = await downloadFile({ url: `${stalling}/a`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1e7, stallMs: 200 }).catch(e => e);
    expect([stalled.code, stalled.retryable]).toEqual(["stalled", true]);
    const missing = await serve((_request, response) => { response.writeHead(404); response.end("no"); });
    const notFound = await downloadFile({ url: `${missing}/a`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1e7 }).catch(e => e);
    expect([notFound.code, notFound.retryable]).toEqual(["http_status", false]);
    const slow = await serve((_request, response) => { response.writeHead(200, { "content-length": body.length }); response.write(body.subarray(0, 10)); });
    const controller = new AbortController();
    const pending = downloadFile({ url: `${slow}/a`, allows: onlyLoopback, destination, expectedSha256: sha(body), maxBytes: 1e7, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    expect(await code(pending)).toBe("cancelled");
  });
});

describe("downloadSmall", () => {
  it("reads a small file and refuses one over its limit", async () => {
    const server = await serve((request, response) => { if (request.url === "/big") { response.end(Buffer.alloc(2000)); return; } response.end("hello"); });
    expect((await downloadSmall({ url: `${server}/a`, allows: onlyLoopback, maxBytes: 100 })).toString()).toBe("hello");
    expect(await code(downloadSmall({ url: `${server}/big`, allows: onlyLoopback, maxBytes: 100 }))).toBe("too_large");
  });
});
