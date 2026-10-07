const { execFileSync } = require('node:child_process')
const path = require('node:path')

// Ad-hoc sign the whole bundle so Apple Silicon accepts it after electron-builder modifies Electron's resources.
exports.default = async function afterPack(context) {
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
