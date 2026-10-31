import { Tiktoken } from 'js-tiktoken/lite';
import ranks from 'js-tiktoken/ranks/o200k_base';
import { AgentFailure } from './agent-evaluation.js';

export const liveModel = 'gpt-4.1-mini-2025-04-14' as const;
export const liveCompatibilityProfile = 'gpt41-mini-text-v1-2026-10-29' as const;
export const modelShutdown = Date.parse('2027-01-14T00:00:00Z');
export interface LiveInputEstimator {
  readonly mode: 'model_compatible';
  readonly model: typeof liveModel;
  estimate(serializedRequest: string): number;
}
const estimators = new WeakSet<object>();
let encoding: Tiktoken | undefined;
/** Bundled ranks only. No runtime vocabulary downloads or model-list requests. */
export function createLiveInputEstimator(model: string): LiveInputEstimator {
  if (model !== liveModel) throw new AgentFailure('provider_configuration');
  encoding ??= new Tiktoken(ranks);
  const tokenizer = encoding;
  const estimator: LiveInputEstimator = Object.freeze({
    mode: 'model_compatible',
    model: liveModel,
    estimate(serializedRequest: string) {
      if (Buffer.byteLength(serializedRequest) > 131072)
        throw new AgentFailure('request_size_limit');
      // Literal special-token text remains data. Framing is reserved separately.
      return Math.ceil(tokenizer.encode(serializedRequest, [], []).length * 1.25);
    },
  });
  estimators.add(estimator);
  return estimator;
}
export function assertLiveInputEstimator(estimator: object, model: string): void {
  if (!estimators.has(estimator) || model !== liveModel)
    throw new AgentFailure('provider_configuration');
}
