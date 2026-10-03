// OpenCode's plugin loader resolves a plugin directory to <dir>/index.ts.
// It does not consult package.json "exports", so this re-export is what makes
// the package loadable when configured by directory.
export { default } from "./src/dm.js"
