/**
 * The environment the end-to-end server is given — decided here, not inherited by accident.
 *
 * Which backend an e2e run talks to is the Playwright config's decision: the Prism mock, unless
 * `E2E_STORE_API_URL` names the core. But a child process inherits the shell, and a shell that
 * exports `STORE_API_URL` (the value in `.env.example` points at the core) silently overrode that:
 * the app prefers `STORE_API_URL` over `MOCK_API_URL`, so a "mock" run talked to the core. The
 * core-only tests then skipped with the mock's reason, and the journey placed a real order — spent
 * real seed stock — while logging that it had bought "on the Prism mock" (review of #316).
 *
 * It also turns on local images (`E2E_LOCAL_IMAGES=1`, #327): every remote product image becomes a
 * placeholder served by the app, so a run never waits on picsum or a CDN. Both the build (which
 * inlines it) and the server (which refuses it outside a loopback origin) get the same value.
 *
 * `scripts/perf.mjs` has always deleted the variable for the same reason. This is the one place the
 * e2e server gets its environment from, so that both the build and the running server agree.
 *
 * @param {Record<string, string | undefined>} env the environment the script was started with
 * @returns {Record<string, string | undefined>} a copy, safe to hand to the build and the server
 */
export function e2eServerEnv(env) {
  const serverEnv = { ...env, E2E_LOCAL_IMAGES: '1' };
  const core = env.E2E_STORE_API_URL;
  if (core === undefined || core === '') {
    // A mock run: nothing the shell exports may point the app anywhere else.
    delete serverEnv.STORE_API_URL;
  } else {
    // A core run: the one backend named for the run, whatever the shell says.
    serverEnv.STORE_API_URL = core;
  }
  return serverEnv;
}
