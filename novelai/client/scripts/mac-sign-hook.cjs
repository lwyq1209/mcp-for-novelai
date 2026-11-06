// electron-builder afterPack hook (package.json build.afterPack): signs the macOS app before electron-builder makes the
// dmg and the zip from it, so both carry the same signature (scripts/mac-sign.mjs explains how). Other platforms: nothing.
// On every platform it first refuses to package an update rehearsal build by accident: dist-electron/update-test-mode.json
// (scripts/build-electron.mjs, NAI_UPDATE_TEST_BUILD=1) left by a rehearsal that was killed before it removed it, packaged
// by electron-builder run without `npm run build` (which empties dist-electron/ first). packaged-app-check.mjs checks the
// packaged app too.
const fs = require('node:fs');
const path = require('node:path');

/** The rehearsal marker a package would contain, unless this is meant to be a rehearsal build; throws then. */
function refuseStrayRehearsalMarker(projectDir, env = process.env) {
  const marker = path.join(projectDir, 'dist-electron', 'update-test-mode.json');
  if (fs.existsSync(marker) && env.NAI_UPDATE_TEST_BUILD !== '1')
    throw new Error(`${marker} is an update rehearsal marker (left by an interrupted rehearsal?): run npm run build first, or set NAI_UPDATE_TEST_BUILD=1 for a rehearsal build.`);
}
exports.refuseStrayRehearsalMarker = refuseStrayRehearsalMarker;

exports.default = async function afterPack(context) {
  refuseStrayRehearsalMarker(context.packager.projectDir);
  if (context.electronPlatformName !== 'darwin') return;
  const { signMacApp } = await import('./mac-sign.mjs');
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const result = signMacApp(app, { bundleId: context.packager.appInfo.id, log: message => console.log(`  • mac-sign: ${message}`) });
  console.log(`  • mac-sign: ${result.mode}${result.certificate ? ` (certificate SHA-256 ${result.certificate.sha256})` : ''}`);
};
