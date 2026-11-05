import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: { getPath: () => { throw new Error("not used"); } } }));
import { installationRoot } from "./app-mode";

// Save folders may not lie inside the folder that installing another version replaces (data-directory-guard.ts).
describe("the installation root", () => {
  it("is the whole application bundle on macOS, not just its Contents/MacOS folder", () => {
    expect(installationRoot("/Applications/MCP for NovelAI.app/Contents/MacOS/MCP for NovelAI", "darwin")).toBe("/Applications/MCP for NovelAI.app");
    expect(installationRoot("/Users/u/Downloads/Renamed Copy.APP/Contents/MacOS/MCP for NovelAI", "darwin")).toBe("/Users/u/Downloads/Renamed Copy.APP");
    // Development runs use Electron's own bundle the same way; an executable outside a bundle keeps its folder.
    expect(installationRoot("/repo/novelai/client/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron", "darwin")).toBe("/repo/novelai/client/node_modules/electron/dist/Electron.app");
    expect(installationRoot("/opt/tools/mcp-for-novelai", "darwin")).toBe("/opt/tools");
    expect(installationRoot("/Applications/Odd/MacOS/app", "darwin")).toBe("/Applications/Odd/MacOS");
  });

  it("is the folder of the executable on Windows and Linux", () => {
    expect(installationRoot("C:\\Users\\u\\AppData\\Local\\Programs\\MCP for NovelAI\\MCP for NovelAI.exe", "win32")).toBe("C:\\Users\\u\\AppData\\Local\\Programs\\MCP for NovelAI");
    expect(installationRoot("/tmp/.mount_MCPfoX/mcp-for-novelai", "linux")).toBe("/tmp/.mount_MCPfoX");
    // A Linux path that happens to look like a macOS bundle is still just a folder.
    expect(installationRoot("/opt/App.app/Contents/MacOS/app", "linux")).toBe("/opt/App.app/Contents/MacOS");
  });
});
