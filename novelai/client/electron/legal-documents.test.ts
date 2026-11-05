import path from "node:path";
import { describe, expect, it } from "vitest";
import { legalDocumentPath, readLegalDocument } from "./legal-documents";

describe("legal documents for the About page", () => {
  it("reads LICENSE and THIRD_PARTY_NOTICES.md from the resources of a packaged app", () => {
    const location = { packaged: true, resourcesPath: path.join("/Applications", "MCP for NovelAI.app", "Contents", "Resources"), appPath: "/ignored" };
    expect(legalDocumentPath("license", location)).toBe(path.join(location.resourcesPath, "LICENSE"));
    expect(legalDocumentPath("notices", location)).toBe(path.join(location.resourcesPath, "THIRD_PARTY_NOTICES.md"));
  });

  it("reads them from the repository in a development run and refuses other names", async () => {
    const client = path.resolve(__dirname, "..");
    const location = { packaged: false, resourcesPath: "/ignored", appPath: client };
    expect(legalDocumentPath("license", location)).toBe(path.resolve(client, "..", "..", "LICENSE"));
    await expect(readLegalDocument("license", location)).resolves.toMatch(/^MIT License\n/);
    await expect(readLegalDocument("notices", location)).resolves.toMatch(/^# Third-party notices\n/);
    expect(() => legalDocumentPath("../settings.json" as never, location)).toThrow("Unknown legal document");
  });
});
