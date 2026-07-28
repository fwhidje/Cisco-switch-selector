// build-info.js — which code is actually deployed.
//
// OVERWRITTEN BY CI immediately before `wrangler deploy` (see
// .github/workflows/validate-kb.yml). The values committed here are what local
// `wrangler dev` and any manual `npm run deploy` report, so "local" in a
// response means "not stamped by CI", not "stale".
//
// Why this file exists: the server used to report only registry_version, which
// moves when the REGISTRY changes — so consecutive code deploys all announced
// the same version and a client holding a cached tools/list was indistinguishable
// from a fresh deploy. That cost a debugging session once.

export const BUILD_SHA = "local";
export const BUILD_TIME = "";
