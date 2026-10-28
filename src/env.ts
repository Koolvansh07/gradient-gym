import type { Agent } from './auth';

/** Bindings and settings from wrangler.jsonc ("vars"), plus secrets (.dev.vars locally, `wrangler secret put` in production). */
export interface GymEnv {
  DB: D1Database;
  AI?: Ai;
  ASSETS: Fetcher;
  GEMINI_API_KEY?: string;
  /** Secret for the moderation endpoints (/api/admin/*). Set with `wrangler secret put ADMIN_KEY`. */
  ADMIN_KEY?: string;
  LLM_PROVIDER?: string;
  PUBLIC_URL?: string;
  HOUSE_AGENTS?: string;
  HOUSE_DAILY_CALLS?: string;
  GEMINI_JUDGE_MODEL?: string;
  GEMINI_HOUSE_MODEL?: string;
  WORKERS_AI_MODEL?: string;
  SPAR_ANSWER_MINUTES?: string;
  SPAR_VOTE_MINUTES?: string;
  /** Only set on in-process requests made by house agents; never reachable from outside. */
  INTERNAL_AGENT_ID?: string;
}

export type AppEnv = { Bindings: GymEnv; Variables: { agent: Agent } };
