export type Spec =
  | { type: 'exact'; answers: string[] }
  | { type: 'number'; value: number; tolerance?: number }
  | { type: 'choice'; answer: string };

export type GradeResult = { correct: boolean; feedback: string };

export function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/^\s*(final\s+)?answer\s*(is)?\s*[:\-]?\s*/i, '')
    .replace(/[`*_"'“”‘’]/g, '')
    .replace(/[^a-z0-9\s.\-\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(a|an|the)\s+/, '')
    .replace(/[.\s]+$/, '');
}

/** Agents ramble. Consider the whole answer, an explicit "answer:" line, and the last line. */
function candidates(raw: string) {
  const t = raw.trim();
  const out = [t];
  const explicit = [...t.matchAll(/\b(?:final answer|answer)\s*(?:is)?\s*[:\-]?\s*(\S.*)/gi)].pop();
  if (explicit) out.unshift(explicit[1]);
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) out.push(lines[lines.length - 1]);
  return out;
}

function lastNumber(s: string): number | null {
  const matches = [...s.replace(/(\d),(\d{3})/g, '$1$2').matchAll(/-?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?|-?\.\d+/g)];
  const m = matches.pop()?.[0];
  if (!m) return null;
  if (m.includes('/')) {
    const [a, b] = m.split('/').map((x) => Number(x.trim()));
    return b ? a / b : null;
  }
  return Number(m);
}

export function grade(spec: Spec, answer: string): GradeResult {
  switch (spec.type) {
    case 'exact': {
      const ok = spec.answers.map(normalize);
      const correct = candidates(answer).some((c) => ok.includes(normalize(c)));
      return { correct, feedback: correct ? 'Clean rep.' : 'Not quite. Check your form and try again.' };
    }
    case 'number': {
      const tol = spec.tolerance ?? 1e-9;
      const cs = candidates(answer);
      const correct = [cs[0], cs[cs.length - 1]].some((c) => {
        const n = lastNumber(c);
        return n !== null && Math.abs(n - spec.value) <= tol;
      });
      return { correct, feedback: correct ? 'Numbers check out.' : 'Wrong number. The barbell does not lie.' };
    }
    case 'choice': {
      const correct = candidates(answer).some((c) => {
        const m = /^\(?([a-z])\)?(?:\s|$|[.:)])/i.exec(c.trim()) || /\b(?:option|letter)\s+\(?([a-z])\b/i.exec(c);
        return !!m && m[1].toLowerCase() === spec.answer.toLowerCase();
      });
      return { correct, feedback: correct ? 'Hallucination spotted.' : 'Wrong pick. That one was true.' };
    }
  }
}
