/**
 * The middleware matcher as Next compiles it (#949): Next's own `getMiddlewareMatchers`, so the tests
 * check the regex Next runs, not a hand-built approximation of it. That function is internal to
 * Next (not in its public typings), so it is loaded once here, typed by what the tests use.
 * Loaded at import time, outside any test's timeout.
 */
import { createRequire } from 'node:module';

type CompiledMatcher = { regexp: string; originalSource: string };
type MatcherCompiler = (matcher: unknown, nextConfig: unknown) => CompiledMatcher[];

const require = createRequire(import.meta.url);
const { getMiddlewareMatchers } = require('next/dist/build/analysis/get-page-static-info') as {
  getMiddlewareMatchers: MatcherCompiler;
};

/** Whether the middleware runs on `path` under `matcher`, as Next decides it. */
export function matcherFor(matcher: unknown): (path: string) => boolean {
  const regexps = getMiddlewareMatchers(matcher, {}).map((m) => new RegExp(m.regexp));
  return (path) => regexps.some((re) => re.test(path));
}
