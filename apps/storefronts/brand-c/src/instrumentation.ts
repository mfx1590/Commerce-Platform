/**
 * Runs once when a server instance starts. Its one job: refuse to boot an end-to-end test build
 * (`E2E_LOCAL_IMAGES`, #327) anywhere but a loopback origin — see `instrumentation-node.ts`.
 * Imported only in the Node runtime, so the Edge bundle never sees `process.exit`.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { refuseTestBuildOutsideLoopback } = await import('./instrumentation-node');
    refuseTestBuildOutsideLoopback();
  }
}
