import { createHash } from 'node:crypto';
import { LIMITS } from './basic.js';

// Only reusable content participates; survey order and generated UUIDs do not.
export function questionInput(question) {
  return {
    title: question.title, type: question.type, required: question.required,
    validation: { ...question.validation },
    ...(['single', 'multiple'].includes(question.type)
      ? { options: question.options.map(({ label }) => ({ label })) } : {}),
  };
}

// Takes an already normalized question. Explicit defaults match omitted defaults.
export function questionContentKey(question) {
  const v = question.validation;
  const validation = question.type === 'number'
    ? { min: v.min ?? null, max: v.max ?? null, integer: v.integer ?? false }
    : question.type === 'text'
      ? { minLength: v.minLength ?? 0, maxLength: v.maxLength ?? LIMITS.textAnswer }
      : question.type === 'multiple'
        ? { minSelections: v.minSelections ?? 0, maxSelections: v.maxSelections ?? question.options.length,
          exactSelections: v.exactSelections ?? null } : {};
  const content = {
    title: question.title, type: question.type, required: question.required,
    options: question.options.map(({ label }) => label), validation,
  };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
