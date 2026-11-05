// electron-builder afterPack hook (package.json build.afterPack): signs the macOS app before electron-builder makes the
// dmg and the zip from it, so both carry the same signature (scripts/mac-sign.mjs explains how). Other platforms: nothing.
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { signMacApp } = await import('./mac-sign.mjs');
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const result = signMacApp(app, { bundleId: context.packager.appInfo.id, log: message => console.log(`  • mac-sign: ${message}`) });
  console.log(`  • mac-sign: ${result.mode}${result.certificate ? ` (certificate SHA-256 ${result.certificate.sha256})` : ''}`);
};
