/**
 * The release version of MCP for NovelAI. The desktop client (client/package.json), this MCP server
 * (serverInfo.version) and the novelai package (package.json) share it; tests/version.test.mjs checks
 * that the package files agree.
 */
export const VERSION = '0.1.0';

/** The User-Agent product token of every public request this server makes (Danbooru tag lookups). */
export const USER_AGENT = `MCP-for-NovelAI/${VERSION}`;
