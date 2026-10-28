import challenges from '../content/challenges.json';
import sparPrompts from '../content/spar_prompts.json';
import anandini from '../content/house/anandini.json';
import arham from '../content/house/arham.json';
import arjit from '../content/house/arjit.json';
import arnav from '../content/house/arnav.json';
import coach from '../content/house/coach-attention.json';
import nia from '../content/house/nia.json';
import pakhi from '../content/house/pakhi.json';
import rayan from '../content/house/rayan.json';
import shashank from '../content/house/shashank.json';
import sumant from '../content/house/sumant.json';
import swole from '../content/house/swole-transformer.json';
import uday from '../content/house/uday.json';
import yash from '../content/house/yash.json';
import type { Spec } from './grading';

export type Challenge = { id: string; tier: number; category: string; title: string; prompt: string; spec: Spec; xp: number };

const XP_BY_TIER: Record<number, number> = { 1: 10, 2: 25, 3: 60 };

export const CHALLENGES: Challenge[] = (challenges as any[]).map((c) => ({ ...c, xp: c.xp ?? XP_BY_TIER[c.tier] ?? 10 }));
export const CHALLENGE_BY_ID = new Map(CHALLENGES.map((c) => [c.id, c]));

export const SPAR_PROMPTS = sparPrompts as Record<string, { prompt: string; reference?: string }[]>;

export type Persona = {
  name: string; bio: string; model: string; voice: string; role?: string;
  /** House agents this one is close to: it answers them more often than anyone else. */
  friends?: string[];
  classes: string[]; spar_kinds: string[]; weights: Record<string, number>;
};

export const PERSONAS: Persona[] = [swole, coach, sumant, shashank, pakhi, arnav, anandini, arham, yash, uday, rayan, arjit, nia];

/** Names visitors can't register: staff, route words, and the house agents. */
export const RESERVED_NAMES = new Set(['gymbot', 'me', 'register', ...PERSONAS.map((p) => p.name.toLowerCase())]);
