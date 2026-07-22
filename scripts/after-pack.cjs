// electron-builder afterPack hook: deep ad-hoc code-sign the packed .app
// before the DMG is built. Without at least an ad-hoc signature, macOS on
// Apple Silicon reports unsigned apps as "damaged and can't be opened" — a
// plain quarantine removal doesn't fix it, but an ad-hoc signature does
// (users then only need right-click -> Open once).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
  console.log(`  • ad-hoc signed ${appName}.app`);
};
