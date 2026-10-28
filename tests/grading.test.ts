import { describe, expect, it } from 'vitest';
import challenges from '../content/challenges.json';
import { grade, type Spec } from '../src/grading';
import { eloUpdate } from '../src/elo';

describe('exact answers', () => {
  const spec = { type: 'exact' as const, answers: ['mary'] };
  it('accepts plain and decorated answers', () => {
    expect(grade(spec, 'Mary').correct).toBe(true);
    expect(grade(spec, '**Mary.**').correct).toBe(true);
    expect(grade(spec, 'Let me think.\nThe answer is Mary').correct).toBe(true);
    expect(grade(spec, 'Final answer: mary').correct).toBe(true);
  });
  it('rejects wrong answers', () => {
    expect(grade(spec, 'Nunu').correct).toBe(false);
    expect(grade(spec, 'mary or nunu').correct).toBe(false);
  });
});

describe('predict-the-output answers', () => {
  it('accepts the printed text with harmless formatting differences', () => {
    expect(grade({ type: 'exact', answers: ['2-4-6'] }, '2-4-6').correct).toBe(true);
    expect(grade({ type: 'exact', answers: ['2-4-6'] }, '`2-4-6`').correct).toBe(true);
    expect(grade({ type: 'exact', answers: ['1,10,3'] }, '1,10,3').correct).toBe(true);
    expect(grade({ type: 'exact', answers: ['1,10,3'] }, '1, 10, 3').correct).toBe(true);
    expect(grade({ type: 'exact', answers: ['false'] }, 'false').correct).toBe(true);
  });
  it('rejects the classic wrong answers', () => {
    expect(grade({ type: 'exact', answers: ['1,10,3'] }, '1,3,10').correct).toBe(false);
    expect(grade({ type: 'exact', answers: ['false'] }, 'true').correct).toBe(false);
    expect(grade({ type: 'exact', answers: ['helo'] }, 'hello').correct).toBe(false);
  });
});

describe('numeric answers', () => {
  it('reads the last number', () => {
    expect(grade({ type: 'number', value: 391 }, '17 × 23 = 391').correct).toBe(true);
    expect(grade({ type: 'number', value: 5050 }, '5,050').correct).toBe(true);
    expect(grade({ type: 'number', value: 5 }, '10').correct).toBe(false);
  });
  it('handles fractions with tolerance', () => {
    const spec = { type: 'number' as const, value: 0.16667, tolerance: 0.0005 };
    expect(grade(spec, '1/6').correct).toBe(true);
    expect(grade(spec, '0.1667').correct).toBe(true);
    expect(grade(spec, '0.2').correct).toBe(false);
  });
});

describe('multiple choice', () => {
  const spec = { type: 'choice' as const, answer: 'c' };
  it('accepts letter formats', () => {
    expect(grade(spec, 'C').correct).toBe(true);
    expect(grade(spec, 'C) Spiders are insects').correct).toBe(true);
    expect(grade(spec, 'The answer is C').correct).toBe(true);
    expect(grade(spec, 'B').correct).toBe(false);
  });
});

describe('challenge content', () => {
  const all = challenges as { id: string; tier: number; category: string; spec: Spec }[];
  it('has unique ids and only supported grader types', () => {
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    for (const c of all) expect(['exact', 'number', 'choice']).toContain(c.spec.type);
  });
  it('covers every tier', () => {
    for (const tier of [1, 2, 3]) expect(all.some((c) => c.tier === tier)).toBe(true);
  });
});

describe('elo', () => {
  it('moves ratings symmetrically', () => {
    const [a, b] = eloUpdate(1000, 1000, 1);
    expect(a).toBe(1016);
    expect(b).toBe(984);
  });
  it('rewards upsets more', () => {
    const [underdog] = eloUpdate(900, 1100, 1);
    expect(underdog - 900).toBeGreaterThan(16);
  });
  it('draw between equals changes nothing', () => {
    expect(eloUpdate(1200, 1200, 0.5)).toEqual([1200, 1200]);
  });
});
