// A scripted stand-in for `runTools` (REQUEST #669) with its semantics, for tests and the golden set: the model's
// turns are a SCRIPT (recorded tool calls, then a final text), the loop calls the caller's `handle` exactly as the
// real gateway will, and every step is recorded (the "audit" of the fake). It never touches the network.
//   * a tool name not in `tools` gets an is_error result and `handle` is not called;
//   * a step that would exceed `maxToolCalls` ends the run with AiToolLoopError (no partial answer);
//   * a step may be a function of the run so far (to answer from the tool results), or a gateway error to throw.
import { randomUUID } from 'node:crypto';
import type {
  AiToolCall,
  AiToolResult,
  AiToolRun,
  BiQaVariables,
  GatewayFactory,
  GatewayLike,
  RunToolsOptions,
} from '../gateway';

export interface RunSoFar {
  variables: BiQaVariables;
  /** every tool result returned so far, in order (parsed JSON) */
  results: { call: AiToolCall; result: AiToolResult; parsed: unknown }[];
}

export type ScriptStep =
  | { toolUse: { name: string; input: unknown }[] }
  | { text: string }
  | { fail: string; details?: Record<string, unknown> }
  | ((run: RunSoFar) => { toolUse: { name: string; input: unknown }[] } | { text: string });

export interface FakeStep {
  step: number;
  toolNames: string[];
}

export interface FakeRun {
  scope: { organizationId: string; storeId: string | null; actorId: string };
  key: string;
  variables: BiQaVariables;
  toolNames: string[];
  steps: FakeStep[];
  conversationId: string;
  outcome: 'ok' | 'tool_loop_cap' | 'error';
}

class FakeGatewayError extends Error {
  constructor(
    name: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(name);
    this.name = name;
  }
}

/** A gateway factory whose every gateway plays `script`; `runs` records what happened. */
export function scriptedGateways(
  script: readonly ScriptStep[],
): GatewayFactory & { runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const factory = ((scope) => {
    const gateway: GatewayLike = {
      async runTools(key, variables, opts: RunToolsOptions): Promise<AiToolRun> {
        const run: FakeRun = {
          scope,
          key,
          variables,
          toolNames: opts.tools.map((t) => t.name),
          steps: [],
          conversationId: opts.conversationId ?? randomUUID(),
          outcome: 'ok',
        };
        runs.push(run);
        const max = opts.maxToolCalls ?? 5;
        const soFar: RunSoFar = { variables, results: [] };
        const toolCalls: AiToolRun['toolCalls'] = [];
        for (let i = 0; i < script.length; i += 1) {
          const raw = script[i]!;
          if (typeof raw !== 'function' && 'fail' in raw) {
            run.outcome = 'error';
            throw new FakeGatewayError(raw.fail, raw.details);
          }
          const step = typeof raw === 'function' ? raw(soFar) : raw;
          if ('text' in step) {
            run.steps.push({ step: i, toolNames: [] });
            return {
              text: step.text,
              toolCalls,
              steps: i + 1,
              stopReason: 'end_turn',
              usage: { inputTokens: 100 * (i + 1), outputTokens: step.text.length },
              conversationId: run.conversationId,
              model: 'claude-sonnet-5-5',
              servedModel: 'claude-sonnet-5-5',
              template: { id: 'bi-qa-answer', version: 1 },
            };
          }
          run.steps.push({ step: i, toolNames: step.toolUse.map((u) => u.name) });
          if (toolCalls.length + step.toolUse.length > max) {
            run.outcome = 'tool_loop_cap';
            throw new FakeGatewayError('AiToolLoopError', { max_tool_calls: max });
          }
          for (const [j, use] of step.toolUse.entries()) {
            const call: AiToolCall = { id: `toolu_${i}_${j}`, name: use.name, input: use.input };
            const known = opts.tools.some((t) => t.name === use.name);
            const result: AiToolResult = known
              ? await opts.handle(call)
              : { isError: true, content: JSON.stringify({ error: { code: 'unknown_tool' } }) };
            toolCalls.push({ ...call, isError: result.isError === true });
            soFar.results.push({ call, result, parsed: JSON.parse(result.content) as unknown });
          }
        }
        run.outcome = 'error';
        throw new FakeGatewayError('AiTransportError', { error_class: 'ScriptEnded' });
      },
    };
    return gateway;
  }) as GatewayFactory & { runs: FakeRun[] };
  factory.runs = runs;
  return factory;
}
