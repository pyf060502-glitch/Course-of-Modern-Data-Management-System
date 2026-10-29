import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  normalizeQuestion, validateAnswer, validateQuestions, LIMITS,
} from '../src/validators/questions.js';
import {
  END, OPERATORS, validateRules, getNextQuestion, validateSubmission,
} from '../src/services/jump.js';

function question(type, patch = {}, order = 1) {
  return normalizeQuestion({
    title: ' Question ', type,
    ...(['single', 'multiple'].includes(type)
      ? { options: [{ label: ' A ' }, { label: 'B' }, { label: 'C' }] } : {}),
    ...patch,
  }, { order });
}
function rule(source, target, operator, value, priority = 0) {
  return { sourceQuestionId: source.id, targetQuestionId: target?.id ?? END, operator, value, priority };
}
function fails(action, status = 400) {
  assert.throws(action, (error) => error.status === status && typeof error.details?.field === 'string');
}

test('question normalization creates UUIDs and preserves identity through edits/reordering', () => {
  const original = question('single');
  assert.match(original.id, /^[0-9a-f-]{36}$/);
  assert.equal(original.title, 'Question');
  assert.equal(original.options[0].label, 'A');
  assert.equal(new Set(original.options.map((option) => option.id)).size, 3);
  const updated = normalizeQuestion({
    title: 'Changed', options: [
      { ...original.options[2], label: 'New label' }, original.options[0], { label: 'New' },
    ],
  }, { existing: original, order: 2 });
  assert.equal(updated.id, original.id);
  assert.equal(updated.order, 2);
  assert.equal(updated.options[0].id, original.options[2].id);
  assert.equal(updated.options[1].id, original.options[0].id);
  assert.ok(!original.options.some((option) => option.id === updated.options[2].id));
  assert.equal(original.options[2].label, 'C');
  fails(() => normalizeQuestion({ id: randomUUID() }, { existing: original }));
  fails(() => normalizeQuestion({ options: [{ id: randomUUID(), label: 'X' }] }, { existing: original }));
  fails(() => normalizeQuestion({ options: [original.options[0], original.options[0]] }, { existing: original }));
  fails(() => question('single', { options: [{ id: randomUUID(), label: 'X' }] }));
});

test('type changes clear old validation/options and apply only the new type configuration', () => {
  const original = question('multiple', { required: true, validation: { exactSelections: 2 } });
  const text = normalizeQuestion({ type: 'text' }, { existing: original });
  assert.equal(text.id, original.id);
  assert.deepEqual(text.options, []);
  assert.deepEqual(text.validation, {});
  const number = normalizeQuestion({ type: 'number', validation: { integer: true } }, { existing: text });
  assert.deepEqual(number.validation, { integer: true });
  fails(() => normalizeQuestion({ type: 'single' }, { existing: text }));
  fails(() => normalizeQuestion({ type: 'text', options: [] }, { existing: original }));
  fails(() => normalizeQuestion({ type: 'number', validation: original.validation }, { existing: original }));
  const single = normalizeQuestion({ type: 'single' }, { existing: original });
  assert.deepEqual(single.validation, {});
  assert.deepEqual(single.options, original.options);
  const replaced = normalizeQuestion({ validation: { minSelections: 1 } }, { existing: original });
  assert.deepEqual(replaced.validation, { minSelections: 1 });
});

test('question fields, option limits, Unicode titles, order and stored structure are strict', () => {
  assert.equal(question('text', { title: '😀'.repeat(200) }).title.length, 400);
  for (const patch of [
    { title: ' ' }, { title: '😀'.repeat(201) }, { required: 'true' }, { type: 'unknown' },
    { unknown: true }, { validation: { $gt: 0 } }, { validation: null },
  ]) fails(() => question('text', patch));
  for (const options of [[], null, [{ label: '' }], Array.from({ length: 51 }, () => ({ label: 'x' }))]) {
    fails(() => question('single', { options }));
  }
  for (const order of [0, -1, 1.5, 101]) fails(() => question('text', {}, order));
  const first = question('text');
  const second = question('number', {}, 2);
  assert.equal(validateQuestions([first, second]).length, 2);
  fails(() => validateQuestions([{ ...first, options: [{ id: randomUUID(), label: 'X' }] }]));
  fails(() => validateQuestions([{ ...first, options: null }]));
  fails(() => validateQuestions([first, { ...second, id: first.id }]));
  fails(() => validateQuestions([first, { ...second, order: 3 }]));
  fails(() => validateQuestions(Array(101).fill(first)));
});

test('selection configurations reject conflicts and required questions must be satisfiable', () => {
  for (const validation of [
    { minSelections: 4 }, { maxSelections: 4 }, { exactSelections: 4 },
    { minSelections: 2, maxSelections: 1 }, { minSelections: 2, exactSelections: 1 },
    { maxSelections: 1, exactSelections: 2 }, { minSelections: -1 },
    { exactSelections: 1.5 }, { maxSelections: '2' }, { maxLength: 1 },
  ]) fails(() => question('multiple', { validation }));
  for (const validation of [{ maxSelections: 0 }, { exactSelections: 0 }]) {
    fails(() => question('multiple', { required: true, validation }));
    assert.equal(validateAnswer(question('multiple', { validation }), []), null);
  }
  const q = question('multiple', { validation: { minSelections: 1, maxSelections: 3, exactSelections: 2 } });
  assert.equal(validateAnswer(q, []), null);
});

test('text/number configurations enforce global bounds and integer feasibility', () => {
  for (const validation of [
    { minLength: 2, maxLength: 1 }, { minLength: -1 }, { maxLength: 10001 },
    { minLength: 1.2 }, { maxLength: '1' },
  ]) fails(() => question('text', { validation }));
  fails(() => question('text', { required: true, validation: { maxLength: 0 } }));
  assert.equal(validateAnswer(question('text', { validation: { maxLength: 0 } }), ' '), null);
  for (const validation of [
    { min: 2, max: 1 }, { min: NaN }, { max: Infinity }, { min: '0' },
    { min: Number.MAX_SAFE_INTEGER + 1 }, { integer: 'true' },
    { min: 0.1, max: 0.9, integer: true },
    { min: -0.9, max: -0.1, integer: true },
  ]) fails(() => question('number', { validation }));
  const q = question('number', { validation: { min: -0.1, max: 0.1, integer: true } });
  assert.equal(validateAnswer(q, 0), 0);
  fails(() => question('single', { validation: { min: 0 } }));
});

test('single/multiple answers reject wrong types, invalid IDs and duplicates', () => {
  const single = question('single');
  const multiple = question('multiple', { validation: { minSelections: 2, exactSelections: 2 } });
  const ids = multiple.options.map((option) => option.id);
  assert.equal(validateAnswer(single, single.options[0].id), single.options[0].id);
  assert.deepEqual(validateAnswer(multiple, ids.slice(0, 2)), ids.slice(0, 2));
  for (const value of ['', [], {}, 0, randomUUID()]) fails(() => validateAnswer(single, value), 422);
  for (const value of ['', {}, [ids[0]], ids, [ids[0], ids[0]], [randomUUID()], [null]]) {
    fails(() => validateAnswer(multiple, value), 422);
  }
  assert.equal(validateAnswer(multiple, []), null);
  for (const type of ['single', 'multiple', 'text', 'number']) {
    const optional = question(type);
    for (const value of [undefined, null]) assert.equal(validateAnswer(optional, value), null);
    const required = { ...optional, required: true };
    for (const value of [undefined, null]) fails(() => validateAnswer(required, value), 422);
  }
  fails(() => validateAnswer({ ...multiple, required: true }, []), 422);
});

test('text trims, counts Unicode code points and rejects global overflow', () => {
  const q = question('text', { validation: { minLength: 2, maxLength: 2 } });
  assert.equal(validateAnswer(q, ' 😀😀 '), '😀😀');
  assert.equal(validateAnswer(q, 'e\u0301'), 'e\u0301');
  assert.equal(validateAnswer(q, ' \n\t '), null);
  for (const value of ['😀', '😀😀😀', {}, 2]) fails(() => validateAnswer(q, value), 422);
  fails(() => validateAnswer({ ...q, required: true }, ' '), 422);
  const unlimited = question('text');
  assert.equal([...validateAnswer(unlimited, '😀'.repeat(LIMITS.textAnswer))].length, LIMITS.textAnswer);
  fails(() => validateAnswer(unlimited, '😀'.repeat(LIMITS.textAnswer + 1)), 422);
});

test('numeric answers accept zero/finite fractions but reject coercion and unsafe integers', () => {
  const q = question('number', { required: true, validation: { min: -1, max: 1 } });
  for (const value of [-1, 0, 0.5, 1]) assert.equal(validateAnswer(q, value), value);
  for (const value of ['0', '', false, {}, [], NaN, Infinity, -Infinity, 2, Number.MAX_SAFE_INTEGER + 1]) {
    fails(() => validateAnswer(q, value), 422);
  }
  const integer = question('number', { validation: { integer: true } });
  assert.equal(validateAnswer(integer, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  fails(() => validateAnswer(integer, 0.5), 422);
});

test('rules retain/generate stable IDs and reject incompatible or unsafe configuration', () => {
  const a = question('single');
  const b = question('number', {}, 2);
  const c = question('text', {}, 3);
  const questions = [a, b, c];
  const base = rule(a, b, 'equals', a.options[0].id);
  const normalized = validateRules(questions, [base]);
  assert.deepEqual(validateRules(questions, normalized), normalized);
  for (const patch of [
    { sourceQuestionId: randomUUID() }, { targetQuestionId: randomUUID() },
    { targetQuestionId: a.id }, { operator: 'contains' }, { value: randomUUID() },
    { value: { $ne: null } }, { priority: -1 }, { priority: 1.5 }, { priority: '0' },
    { id: 'bad' }, { extra: true },
  ]) fails(() => validateRules(questions, [{ ...base, ...patch }]));
  fails(() => validateRules(questions, [base, { ...base, targetQuestionId: END }]));
  fails(() => validateRules(questions, [
    { ...base, id: normalized[0].id }, { ...base, priority: 1, id: normalized[0].id },
  ]));
  fails(() => validateRules(questions, [rule(b, a, 'equals', 0)]));
  fails(() => validateRules(questions, [rule(c, null, 'equals', 'x')]));
  fails(() => validateRules(questions, [rule(b, null, 'equals', '0')]));
  fails(() => validateRules(questions, Array(501).fill(base)));
});

test('all single and numeric operators match and do not match including equality boundaries', () => {
  const cases = {
    equals: [2, 1], not_equals: [1, 2], greater_than: [3, 2],
    greater_or_equal: [2, 1], less_than: [1, 2], less_or_equal: [2, 3],
  };
  const q = question('number');
  const after = question('text', {}, 2);
  for (const operator of OPERATORS.number) {
    const survey = { questions: [q, after], jumpRules: [rule(q, null, operator, 2)] };
    assert.equal(getNextQuestion(survey, q.id, cases[operator][0]), END);
    assert.equal(getNextQuestion(survey, q.id, cases[operator][1]), after.id);
    assert.equal(getNextQuestion(survey, q.id, null), after.id);
  }
  const single = question('single');
  for (const operator of OPERATORS.single) {
    const survey = { questions: [single, after],
      jumpRules: [rule(single, null, operator, single.options[0].id)] };
    assert.equal(getNextQuestion(survey, single.id, single.options[operator === 'equals' ? 0 : 1].id), END);
    assert.equal(getNextQuestion(survey, single.id, single.options[operator === 'equals' ? 1 : 0].id), after.id);
  }
});

test('all multi operators, empty answers and array rule validation', () => {
  const q = question('multiple');
  const after = question('text', {}, 2);
  const [a, b, c] = q.options.map((option) => option.id);
  const cases = {
    contains: { value: a, yes: [a], no: [b] },
    not_contains: { value: a, yes: [b], no: [a] },
    contains_any: { value: [a, b], yes: [b], no: [c] },
    contains_all: { value: [a, b], yes: [b, a], no: [a] },
  };
  for (const operator of OPERATORS.multiple) {
    const { value, yes, no } = cases[operator];
    const survey = { questions: [q, after], jumpRules: [rule(q, null, operator, value)] };
    assert.equal(getNextQuestion(survey, q.id, yes), END);
    assert.equal(getNextQuestion(survey, q.id, no), after.id);
    assert.equal(getNextQuestion(survey, q.id, []), after.id);
    assert.equal(getNextQuestion(survey, q.id, undefined), after.id);
  }
  for (const operator of ['contains_any', 'contains_all']) {
    for (const value of [[], [a, a], [randomUUID()], a, [null]]) {
      fails(() => validateRules([q, after], [rule(q, null, operator, value)]));
    }
  }
  const input = rule(q, null, 'contains_any', [a, b]);
  const normalized = validateRules([q, after], [input]);
  normalized[0].value.pop();
  assert.deepEqual(input.value, [a, b]);
});

test('priority wins independent of array order and sequential last question ends', () => {
  const a = question('number');
  const b = question('text', {}, 2);
  const c = question('text', {}, 3);
  const survey = { questions: [a, b, c], jumpRules: [
    rule(a, null, 'greater_or_equal', 0, 9), rule(a, c, 'equals', 0, 1),
  ] };
  assert.equal(getNextQuestion(survey, a.id, 0), c.id);
  assert.equal(getNextQuestion(survey, a.id, -1), b.id);
  assert.equal(getNextQuestion(survey, c.id, ' '), END);
  fails(() => getNextQuestion(survey, randomUUID(), 0));
});

test('submission replays server path, skips required hidden questions and stores normalized answers', () => {
  const a = question('single', { required: true });
  const b = question('text', { required: true }, 2);
  const c = question('text', { required: true }, 3);
  const survey = { questions: [a, b, c], jumpRules: [rule(a, c, 'equals', a.options[0].id)] };
  const answer = { questionId: a.id, value: a.options[0].id };
  const valid = [answer, { questionId: c.id, value: ' 😀 ' }];
  assert.deepEqual(validateSubmission(survey, valid),
    { answers: [answer, { questionId: c.id, value: '😀' }], path: [a.id, c.id] });
  assert.equal(valid[1].value, ' 😀 ');
  for (const value of [null, undefined, '', 'hidden']) {
    fails(() => validateSubmission(survey, [...valid, { questionId: b.id, value }]), 422);
  }
  fails(() => validateSubmission(survey, [answer]), 422);
  fails(() => validateSubmission(survey, [
    { questionId: a.id, value: a.options[1].id }, { questionId: c.id, value: 'ok' },
  ]), 422);
  const endSurvey = { ...survey, jumpRules: [rule(a, null, 'equals', a.options[0].id)] };
  assert.deepEqual(validateSubmission(endSurvey, [answer]), { answers: [answer], path: [a.id] });
  fails(() => validateSubmission(endSurvey, valid), 422);
});

test('submission rejects unknown/duplicate IDs, forged fields and unsafe object answers', () => {
  const a = question('number');
  const b = question('multiple', {}, 2);
  const survey = { questions: [a, b] };
  assert.deepEqual(validateSubmission(survey, [{ questionId: a.id, value: 0 }]),
    { answers: [{ questionId: a.id, value: 0 }], path: [a.id, b.id] });
  assert.deepEqual(validateSubmission(survey, [{ questionId: b.id, value: [] }]),
    { answers: [], path: [a.id, b.id] });
  for (const answers of [
    null, {}, { answers: [] }, [{ questionId: randomUUID(), value: 1 }],
    [{ questionId: a.id, value: 0 }, { questionId: a.id, value: 1 }],
    [{ questionId: a.id, value: 0, path: [a.id] }],
    [{ questionId: a.id, value: { $gt: 0 } }], [null], [{}],
    [{ questionId: b.id, value: [b.options[0].id, b.options[0].id] }],
  ]) fails(() => validateSubmission(survey, answers), 422);
});
