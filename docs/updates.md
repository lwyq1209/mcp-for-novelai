# Updates

How MCP for NovelAI finds, verifies and installs a new version, how to check a release yourself, and what the update is
built to withstand. The code is in `novelai/client/electron/update/`; the release side is in
`.github/workflows/release.yml` and `.github/scripts/update-signature.mjs`.

- [What you see](#what-you-see)
- [What happens when you click Update and restart](#what-happens-when-you-click-update-and-restart)
- [Checking a release yourself](#checking-a-release-yourself)
- [macOS: signing, the Keychain and App Management](#macos-signing-the-keychain-and-app-management)
- [When the app cannot update itself](#when-the-app-cannot-update-itself)
- [Threat model](#threat-model)
- [Rehearsing an update](#rehearsing-an-update)

## What you see

An installed app asks GitHub for the latest release a few seconds after it starts and then every 6 hours (Settings ›
About & updates › Check for updates automatically; **Check for updates** works any time). When a newer version exists,
the top bar shows **Update x.y.z** and Settings › About & updates shows it with two buttons:

- **Update and restart** downloads the new version, checks its signature and its checksum, replaces this app with it and
  opens it again. The progress shows in the top bar and in Settings › About & updates; **Cancel** stops the download
  (a later try continues where it stopped).
- **Download** opens the release page in your browser, as before.

While the queue has batches generating or waiting (yours or an agent's), the button says **Update after the queue** and
waits: the app never restarts in the middle of an image. Pause the batches on the queue page to update at once — paused
batches are kept and stay paused after the restart. The app then quits the normal way (the queue, the library and the
settings are saved as on every quit) and is never killed.

The first start after an update says **Updated to x.y.z** with a link to its release notes (the CHANGELOG entry of that
version). When an update could not complete, the old version opens again and says why (Settings › About & updates and
the log: `[update] …` lines in `app.log`; the update helper's own log is `helper.log` in `updates/<id>/` of the data
folder).

**Updating from 0.1.2 to 0.1.3 is still done by hand**: 0.1.2 does not have this feature. Download 0.1.3 from the
[release page](https://github.com/lwyq1209/mcp-for-novelai/releases/latest) and install it as before (macOS: run the
`xattr` command of the README once more). From 0.1.3 on, **Update and restart** does it.

## What happens when you click Update and restart

All of it runs in the app's main process; the window only shows the state.

1. **The latest release, again.** The app asks `https://api.github.com/repos/lwyq1209/mcp-for-novelai/releases/latest`
   once more. Its tag must be `v<version>` exactly (no other characters) and the version strictly newer than the running
   one (no downgrade, no reinstall of the same version; a pre-release is never offered to a regular release).
2. **The signed manifest.** It downloads `SHA256SUMS.txt` and `SHA256SUMS.txt.sig` of that tag from
   `https://github.com/lwyq1209/mcp-for-novelai/releases/download/<tag>/` and checks the signature with the public key
   built into the app (Ed25519, raw key `Kd4drS/jkRBrI5p6sEUc0clnYHcJ8xQ6RkX+wVJccPw=`). Nothing of an unsigned or
   wrongly signed manifest is used: the update stops with "The update could not be verified" and nothing is installed.
   The manifest must be in `sha256sum`'s exact format, and every `MCP-for-NovelAI-…` file in it must carry the tag's
   version — a correctly signed manifest of another release, served under a newer tag, is refused.
3. **The file of this system**, by the release's fixed names: macOS `MCP-for-NovelAI-<version>-mac-<arm64|x64>.zip`
   (the same app as the dmg), Windows `MCP-for-NovelAI-<version>-win-x64-setup.exe`, Linux
   `MCP-for-NovelAI-<version>-linux-x64.tar.gz`. Downloads go only to github.com's download folder of that tag and the
   hosts GitHub redirects release downloads to (`release-assets.githubusercontent.com`, `objects.githubusercontent.com`),
   over https on the default port; every redirect is checked before it is followed, and any other host is refused.
   The file goes to `updates/downloads/` in the data folder as `<name>.part` (an interrupted download continues with an
   HTTP Range request; up to 3 automatic tries, then **Try again**), at most 1 GiB, and its SHA-256 must be the one in
   the signed manifest, or it is deleted and nothing is installed. Every request uses the app's proxy setting (Settings ›
   Account & network › Proxy, the "app updates" category), like the update check.
4. **Staged and checked next to the app.**
   - macOS: the zip is extracted with `ditto` into `.mcp-for-novelai-update-<random>/` in the folder of the app (the
     same volume). It must hold exactly one `.app` with this app's bundle identifier and the release's version, pass
     `codesign --verify --deep --strict`, and be signed with the same certificate as the running app (SHA-256 of the
     leaf certificate). An app without a certificate (an ad-hoc signed build) accepts only the certificate built into it
     (`40:01:B2:F7:…:75:24`, see below).
   - Linux: the tar.gz is extracted into the same kind of folder next to the app's folder; it must hold one folder with
     the app's executable and the release's version in `resources/app.asar`.
   - Windows: the checked installer stays in `updates/downloads/`.
5. **Handed to a helper; the app quits.** The app writes `updates/pending.json` and a small helper script into
   `updates/<id>/` of the data folder, starts the helper detached (Windows: outside the app's process tree through WMI,
   as the MCP server starts the app), waits until the helper says it runs, and quits normally. The helper uses only
   system tools (macOS/Linux `/bin/sh`, `mv`, `open`; Windows PowerShell and the installer); every value is a separate
   argument it never evaluates. It waits until the app has exited (up to 5 minutes; otherwise it changes nothing), then:
   - macOS and Linux: renames the app to `old/` inside the staging folder and the new version to the app's place (two
     renames in the same folder), removes a quarantine mark from the new app (macOS; a file the app downloads itself
     normally has none), starts it (macOS through LaunchServices, `open -n -a`) with `--updated-from=<old version>` and
     waits up to 2 minutes for it to confirm. Confirmed: the staging folder (the old version) is removed. Not confirmed
     and not running: the old version is put back and started. Still starting: it is left running and removes the old
     version itself once it confirms. Any failed step undoes the steps before it.
   - Windows: runs the installer silently into the same folder (`/S --updated /D=<installation folder>`: the same
     per-user installation, its shortcuts kept), checks that the installed executable has the new version, and starts it
     (WMI, outside any job, with the app's environment). The NSIS installer closes every process that still runs from
     the installation folder, including agents' MCP servers (the agent starts them again); the app itself has already
     quit. When the installer fails, whatever is installed is started again and says the update did not complete.
6. **The first start of the new version** writes `confirmed` for the helper once its window has loaded, then removes the
   old version, the downloads and `pending.json`, and shows "Updated to x.y.z". Your library, queue, settings and images
   are not touched by any of this: they live in the data folder, not in the app.

The app keeps its path, so agent configurations (which name the app's executable and its MCP server file) stay valid,
and on macOS the `xattr` command is not needed again after an in-app update.

## Checking a release yourself

`SHA256SUMS.txt.sig` is the base64 text (one line) of the raw 64-byte Ed25519 signature over the exact bytes of
`SHA256SUMS.txt`. With OpenSSL 3 or later (on macOS the system `openssl` is LibreSSL; use Homebrew's
`/opt/homebrew/bin/openssl`), in the folder with both files:

```sh
printf '%s' 'MCowBQYDK2VwAyEAKd4drS/jkRBrI5p6sEUc0clnYHcJ8xQ6RkX+wVJccPw=' | base64 -d > update-key.der
openssl pkey -pubin -inform DER -in update-key.der -out update-key.pem
base64 -d < SHA256SUMS.txt.sig > SHA256SUMS.sig.bin
openssl pkeyutl -verify -pubin -inkey update-key.pem -rawin -in SHA256SUMS.txt -sigfile SHA256SUMS.sig.bin
# Signature Verified Successfully
sha256sum --check --ignore-missing SHA256SUMS.txt     # macOS: shasum -a 256 --check --ignore-missing SHA256SUMS.txt
```

(`MCowBQYDK2VwAyEA` is the fixed DER header of an Ed25519 public key; the rest is the app's raw key.) With Node.js
instead: `node .github/scripts/update-signature.mjs verify --in SHA256SUMS.txt --sig SHA256SUMS.txt.sig --public-key
Kd4drS/jkRBrI5p6sEUc0clnYHcJ8xQ6RkX+wVJccPw=` from a clone of this repository.

The macOS app's certificate: `codesign -dvv "/Applications/MCP for NovelAI.app"` shows `Authority=MCP for NovelAI
(self-signed)`, and

```sh
codesign -d --extract-certificates=/tmp/nai-cert "/Applications/MCP for NovelAI.app" && shasum -a 256 /tmp/nai-cert0
# 4001b2f773a1f258cac351597a518c9924d294e167d298297c64cd409ee67524
codesign -d -r- "/Applications/MCP for NovelAI.app"
# designated => identifier "io.github.lwyq1209.mcp-for-novelai" and certificate leaf = H"…"
```

## macOS: signing, the Keychain and App Management

From 0.1.3 the macOS app is signed with one fixed self-signed certificate ("MCP for NovelAI (self-signed)", valid until
2036; SHA-256 `40:01:B2:F7:73:A1:F2:58:CA:C3:51:59:7A:51:8C:99:24:D2:94:E1:67:D2:98:29:7C:64:CD:40:9E:E6:75:24`)
instead of an ad-hoc signature. Its designated requirement — `identifier "io.github.lwyq1209.mcp-for-novelai" and
certificate leaf = H"<SHA-1 of the certificate>"` — is the same in every version. That matters for the Keychain:
"Always Allow" for the app's "MCP for NovelAI Safe Storage" key (where the encrypted API token's key lives) is tied to
it. With ad-hoc signatures every build had a new requirement, so macOS asked again after every update.

- **Once more, after installing 0.1.3**: the requirement changes from 0.1.2's ad-hoc one to the certificate's, so the
  Keychain asks one last time. Click **Always Allow** (with your login password); later updates keep it.
- The certificate is not from Apple and the app is not notarized, so Gatekeeper treats it exactly as before (an
  unidentified developer): the first manual install still needs **Open Anyway** and the `xattr` command. An in-app
  update is not quarantined, so neither is needed after it.
- The release workflow signs with this certificate (repository secrets `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`) through
  electron-builder's afterPack hook `novelai/client/scripts/mac-sign.mjs`, before the dmg and the zip are made.
  electron-builder's own signing cannot be used: it only picks identities `security find-identity -v` lists as valid,
  and a self-signed certificate nobody trusts is not (`CSSMERR_TP_NOT_TRUSTED`) — it would skip signing with a warning.
  `codesign` signs with it all the same. A build without the secrets fails instead of falling back to ad-hoc, and
  `.github/scripts/packaged-app-check.mjs` checks the certificate's SHA-256, the requirement and that the dmg and the
  zip hold the same signature.

**App Management (macOS 13 and later).** Privacy & Security › App Management protects *notarized* apps from being
modified by apps of another developer: TCC checks it for a signed-and-notarized bundle. MCP for NovelAI is not
notarized, and the update does not modify the files of a bundle — the helper renames whole bundles in their folder —
so App Management does not stop it. Should a future macOS extend the protection, the rename fails, the helper changes
nothing, starts the old version again, and the app says: "macOS did not allow moving the app (file permissions, or
System Settings › Privacy & Security › App Management). Allow MCP for NovelAI there and try again, or update by hand."
To allow it: **System Settings › Privacy & Security › App Management**, switch **MCP for NovelAI** on (add it with **+**
if it is not listed), then click **Update and restart** again.

## When the app cannot update itself

Then only **Download** is offered, with the reason:

| Reason | What to do |
| --- | --- |
| macOS: the app was opened from Downloads or the disk image (App Translocation, read-only) | Move it to Applications and open it from there. |
| The app's folder is not writable (for example `/Applications` for a standard user) | Update by hand, or ask an administrator. |
| Windows: installed for all users (Program Files) | Run the new installer by hand (it asks for an administrator). |
| Windows: not installed with the setup installer | Install with the setup installer. |
| Linux: `chrome-sandbox` was set up by root (setuid) | Replace the folder by hand and set `chrome-sandbox` up again ([Troubleshooting](troubleshooting.md#linux-the-app-does-not-start)). The app cannot keep a root-owned helper. |
| A build from source | Pull and build again. |

## Threat model

What the update trusts: the Ed25519 public key and, on macOS, the certificate fingerprint built into the installed app.
Nothing else — not GitHub, not TLS, not the release page, not the API's JSON — can make the app install something.

- **A tampered release file** (on GitHub, a mirror, a proxy cache, or the disk while it downloads): its SHA-256 no
  longer matches the signed `SHA256SUMS.txt`; the file is deleted and nothing is installed. On macOS the extracted app
  must also pass `codesign --verify --deep --strict` with the app's own certificate.
- **A tampered or replaced `SHA256SUMS.txt` or signature**: the signature check fails; the update stops ("could not be
  verified"), and nothing of the manifest is used.
- **A compromised GitHub account or repository without the signing key** (an attacker can upload releases, change tags,
  edit workflows): the private key exists only as the secret `UPDATE_SIGNING_KEY` of the protected environment
  `release`, whose deployments need a maintainer's approval; nothing the attacker uploads is signed by it, so no app
  installs it. A workflow change that tried to use the secret would still need that approval. (An attacker who also has
  the key and the approval can ship an update: keep the key nowhere else, and rotate it with a new app version if it is
  ever exposed.) On macOS an attacker would also need the code signing certificate's private key.
- **Downgrade and replay**: the version must be strictly newer than the running one; a correctly signed manifest of an
  older release names files of its own version, so it cannot be served as a newer tag; the same version is not
  reinstalled. Tags other than `v<semantic version>` are refused.
- **Man in the middle** (a hostile network or proxy): https to the fixed hosts only, every redirect checked against
  the allowed hosts, no credentials sent, and the signature check makes TLS a second line rather than the only one: a
  substituted file or manifest fails as above. The worst such an attacker can do is block or slow the update.
- **A switch that changes what is trusted**: there is none in a release build. The rehearsal variables
  (`NAI_UPDATE_TEST_FEED`, `NAI_UPDATE_TEST_PUBLIC_KEY`, `NAI_UPDATE_TEST_MAC_CERT_SHA256`) are read only by a build
  that carries `dist-electron/update-test-mode.json`, which only `NAI_UPDATE_TEST_BUILD=1` builds have; the release
  workflow never sets it, and `packaged-app-check.mjs` fails a package that contains the file. Changing a file inside an
  installed app is no switch either: whoever can do that can replace the app.
- **Injection into the helper**: tag and file names are checked against strict patterns before they become part of a
  URL or a path; the helper's paths are absolute, normalised and free of control characters (Windows: of quotes), and
  reach it as separate arguments that `sh`/PowerShell never evaluate; the helper removes only the staging folder whose
  name and place it checks itself.
- **Power loss, a crash or a killed helper half-way**:
  - during the download: only `<file>.part` exists; it is checked as a whole before use, and the next try continues it;
  - before the swap (the app is quitting, the helper waits): nothing changed; the old version, opened again, says the
    update did not complete and removes what the attempt left;
  - between the two renames of the swap (milliseconds): the app's place is empty and the old version is in
    `.mcp-for-novelai-update-<random>/old` next to it (macOS: Finder shows hidden files with ⌘⇧.); rename it back to the
    app's name (for example `MCP for NovelAI.app`) — or install the release by hand;
  - after the swap: the new version is in place; whenever it starts (by the helper or by you) it confirms itself and
    removes the old version. A new version that crashes at once is replaced by the old one again.
  - Windows: the installer's own behaviour; a failed installer leaves the version it did not replace, and the app says
    the update did not complete. If an installation is left broken, run the release's setup by hand.
- **Secrets in logs**: the app logs no URL of a download (GitHub's signed download links carry tokens in their query),
  only host names, file names, versions and short reason codes; the release workflow never prints the signing key.

## Rehearsing an update

`node novelai/client/dev-tools/update-rehearsal.mjs` builds two rehearsal versions of a checkout (bundle identifier
`io.github.lwyq1209.mcp-for-novelai.test`, product name "MCP for NovelAI Test", a throwaway update key and, on macOS,
a throwaway self-signed certificate), serves the newer one from a local fake GitHub (`dev-tools/lib/fake-release-server.mjs`,
with faults: another key, a tampered file, a downgrade or replay, cut-off and slow downloads, foreign redirects), installs
the older one into a folder of the work directory and clicks **Update and restart** through DevTools; see
[the dev-tools README](../novelai/client/dev-tools/README.md#update-rehearsal). The CI workflow runs it on all three
platforms when started by hand with `update-rehearsal: true` (`gh workflow run ci.yml -f update-rehearsal=true`),
together with the release signing step and the macOS release build signed with a throwaway certificate.
