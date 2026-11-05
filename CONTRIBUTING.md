# Contributing

Thanks for helping with MCP for NovelAI. Bug reports, fixes and documentation improvements are welcome.

## Reporting a bug

Open an issue with what you did, what you expected and what happened, the app version (Settings › About & updates),
your operating system and, for agent problems, the MCP client and the tool's error `code` and `message`. A few lines
of `app.log` (Settings › Storage & backup › Logs) often help.

**Never include your NovelAI token**, a backup file that contains API credentials, or images and prompts you do not
want to publish. Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Working on the code

Set up a build from source as described in [Building and development](docs/building.md), and use a separate data folder
for development (`node novelai/scripts/start-client.mjs --data-dir <folder>`, or the isolated test clients in
[`novelai/client/dev-tools`](novelai/client/dev-tools/README.md)) so that your own library and queue stay untouched.
Do not generate real (paid) images in tests; the dev tools include a local stand-in for the NovelAI API.

Before opening a pull request, run the checks that apply:

```sh
npm --prefix novelai test
npm --prefix novelai run check:contracts
npm --prefix novelai/client run typecheck
npm --prefix novelai/client test
npm --prefix novelai/client run build
npm --prefix novelai/client run notices:check
```

- Changes to the library schemas: edit `novelai/contracts/src/library-contracts.mts` and run
  `npm --prefix novelai run build:contracts`; commit the generated files.
- Changes to the client's dependencies: run `npm --prefix novelai/client run notices` and commit
  `THIRD_PARTY_NOTICES.md`. A sharp upgrade that changes the sharp-libvips version also needs
  `node novelai/client/scripts/fetch-libvips-licenses.mjs` and `node novelai/client/scripts/fetch-rsvg-crate-licenses.mjs`
  (network; the second needs `cargo`); review what they write.
- Changes to MCP tools: tool descriptions and errors are read by agents, so keep them exact and in English, and update
  [docs/mcp-tools.md](docs/mcp-tools.md) when behaviour changes. Anything that can spend the user's balance must stay
  explicit, idempotent under its request key and never retry on its own.
- Interface text lives in `novelai/client/src/ui/*.strings.ts` with a Chinese and an English text for every key.

Code, comments, commit messages and documentation are in English (the READMEs have a Chinese version too). Keep
commits small and focused, and describe why a change is made.

## Releases

The version is kept in `novelai/package.json`, `novelai/client/package.json` (with both lockfiles) and
`novelai/src/version.mjs`; `CHANGELOG.md` starts with an entry for it. Tests check that they agree.

## License

By contributing you agree that your contribution is licensed under the project's [MIT License](LICENSE).
