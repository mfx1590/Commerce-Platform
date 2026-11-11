import { describe, expect, it, vi } from 'vitest';
import { refuseProductionWithoutKeycloak } from '@/instrumentation-node';

/**
 * #790: a production server without a usable KEYCLOAK_URL used to boot, report `/health` green and
 * answer 500 on every page (the CSP's form-action cannot be built). It now refuses to start.
 */

class Exited extends Error {}
const exit = vi.fn((code: number): never => {
  throw new Exited(String(code));
});

describe('refuseProductionWithoutKeycloak', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not a URL', 'auth.example.com'],
  ])('a production server with KEYCLOAK_URL %s does not come up', (_, value) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    exit.mockClear();
    expect(() =>
      refuseProductionWithoutKeycloak({ NODE_ENV: 'production', KEYCLOAK_URL: value }, exit),
    ).toThrow(Exited);
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls[0]?.[0]).toMatch(/KEYCLOAK_URL must be set/);
    error.mockRestore();
  });

  it('a production server with a valid KEYCLOAK_URL boots', () => {
    exit.mockClear();
    refuseProductionWithoutKeycloak(
      { NODE_ENV: 'production', KEYCLOAK_URL: 'https://auth.example.com/realms/customers' },
      exit,
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not run during next build, or outside production', () => {
    exit.mockClear();
    refuseProductionWithoutKeycloak(
      { NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' },
      exit,
    );
    refuseProductionWithoutKeycloak({ NODE_ENV: 'development' }, exit);
    refuseProductionWithoutKeycloak({ NODE_ENV: 'test' }, exit);
    expect(exit).not.toHaveBeenCalled();
  });
});
