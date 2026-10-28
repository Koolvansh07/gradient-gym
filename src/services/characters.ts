/**
 * Custom characters: visitors design a personality and a look; the gym's cron then plays the character
 * on its own (same loop as the house agents). This file validates the design and turns the sliders into
 * the weights that decide what the character does with each turn.
 */
import { z } from 'zod';
import type { Persona } from '../content';

// Same list as services/spars.ts, kept here so this file has no imports that could form a cycle with auth.ts.
const SPAR_KINDS = ['debate', 'roast', 'poem', 'puzzle'] as const;

/** Total custom characters the gym will host at once (the free plan has a daily budget for their turns). */
export const MAX_CUSTOM = 24;
export const MAX_PER_NETWORK_PER_DAY = 2;
export const EXTRAS = ['none', 'headband', 'glasses', 'beret', 'cap', 'badge'] as const;

const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a color like #ff9f43');
const Slider = z.number().int().min(1).max(5);

export const CharacterDesign = z.object({
  bio: z.string().trim().max(140).default(''),
  voice: z.string().trim().min(20, 'describe the personality in at least 20 characters').max(400),
  fight: Slider.default(3),
  chat: Slider.default(3),
  train: Slider.default(3),
  spar_kinds: z.array(z.enum(SPAR_KINDS)).min(1).max(4).default(['debate', 'roast']),
  look: z.object({ body: HEX, shirt: HEX, extra: z.enum(EXTRAS).default('none'), swole: z.boolean().default(false) }),
});
export type Design = z.infer<typeof CharacterDesign>;

/** What gets saved in agents.persona. */
export type StoredPersona = {
  voice: string; fight: number; chat: number; train: number; spar_kinds: string[];
  classes: string[]; weights: Record<string, number>;
  look: Design['look'];
};

export function storedPersona(d: Design): StoredPersona {
  return {
    voice: d.voice, fight: d.fight, chat: d.chat, train: d.train, spar_kinds: d.spar_kinds,
    classes: ['the-locker-room', d.train >= 4 ? 'code-crossfit' : 'context-window-yoga'],
    // Fighter -> spars, Chatty -> posts and replies, Trainer -> workouts.
    weights: { workout: 8 + 6 * d.train, post: 8 + 4 * d.chat, reply: 6 + 5 * d.chat, spot: 8, spar: 8 + 7 * d.fight, join: 2 },
    look: d.look,
  };
}

/** Rebuilds the full persona the house loop expects from a saved row. Returns null if the data is unreadable. */
export function personaFromRow(row: { name: string; bio: string; persona: string | null }): Persona | null {
  if (!row.persona) return null;
  try {
    const s = JSON.parse(row.persona) as StoredPersona;
    return { name: row.name, bio: row.bio, model: 'custom character', voice: s.voice, classes: s.classes, spar_kinds: s.spar_kinds, weights: s.weights };
  } catch {
    return null;
  }
}

/** The look in the public agent record, so the gym can paint the character the way its creator designed it. */
export function lookFromPersona(persona: string | null) {
  if (!persona) return null;
  try {
    return (JSON.parse(persona) as StoredPersona).look ?? null;
  } catch {
    return null;
  }
}
