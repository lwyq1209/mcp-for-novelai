# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: on the repository's **Security** tab, choose **Report a
vulnerability** (<https://github.com/lwyq1209/mcp-for-novelai/security/advisories/new>). Do not open a public issue for
them. Include the app version, your operating system and the steps to reproduce; leave out your NovelAI token and any
personal data.

This is a small volunteer project; reports are handled as time allows. Fixes go into the latest release.

## Supported versions

Only the latest release receives fixes.

## What is in scope

Examples of what matters most here:

- the NovelAI API token: how it is stored (Electron `safeStorage`), sent (only to `*.novelai.net` unless custom
  addresses are allowed) and kept out of logs, backups, tool results and the local bridge;
- the local bridge between the MCP server and the app (`127.0.0.1`, a per-run secret in `runtime/bridge.json`);
- the MCP server's file access (inbox and export folders only, plain file names, no symbolic links);
- anything that could make the app generate, and spend the user's balance, without an explicit `enqueue_recipes`, or
  generate one intent twice under one request key.

Prompts, metadata and other content are passed through as written by design; that alone is not a vulnerability.
