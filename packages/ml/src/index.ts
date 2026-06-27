// Public API for @cardsharp/ml.

export { LinearPolicy, type ModelJSON } from "./policy.ts";
export { MLController, type MLOptions, type Decision } from "./controller.ts";
export { train, type TrainOptions, type TrainResult } from "./trainer.ts";
export { evaluate, type EvalOptions, type EvalResult } from "./evaluate.ts";
export { featurizeOptions, FEATURE_NAMES, DIM, SCORABLE } from "./features.ts";
export { MctsController, type MctsOptions } from "./mcts.ts";
export {
  winRate,
  randomFactory,
  linearFactory,
  mctsFactory,
  type Factory,
  type FactoryCtx,
  type MatchResult,
} from "./arena.ts";
