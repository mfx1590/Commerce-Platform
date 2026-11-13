/**
 * Runs once when a server instance starts, and refuses to boot a server that cannot work (see
 * `instrumentation-node.ts`): an end-to-end test build (`E2E_LOCAL_IMAGES`, #327) anywhere but a
 * loopback origin, and a production server without `KEYCLOAK_URL` (#790).
 * Imported only in the Node runtime, so the Edge bundle never sees `process.exit`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { refuseProductionWithoutKeycloak, refuseTestBuildOutsideLoopback } =
      await import('./instrumentation-node');
    refuseTestBuildOutsideLoopback();
    refuseProductionWithoutKeycloak();
  }
}
