import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/errors.js';
import { LIMITS, assertAllowedFields, assertFiniteNumber, invalidField } from '../validators/basic.js';
import { assertQuestionId, validateQuestions, validateAnswer } from '../validators/questions.js';

export const END = 'END';
export const OPERATORS = Object.freeze({
  single: Object.freeze(['equals', 'not_equals']),
  multiple: Object.freeze(['contains', 'not_contains', 'contains_any', 'contains_all']),
  number: Object.freeze([
    'equals', 'not_equals', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal',
  ]),
  text: Object.freeze([]),
});

const matches = {
  equals: (answer, value) => answer === value,
  not_equals: (answer, value) => answer !== value,
  greater_than: (answer, value) => answer > value,
  greater_or_equal: (answer, value) => answer >= value,
  less_than: (answer, value) => answer < value,
  less_or_equal: (answer, value) => answer <= value,
  contains: (answer, value) => answer.includes(value),
  not_contains: (answer, value) => !answer.includes(value),
  contains_any: (answer, value) => value.some((id) => answer.includes(id)),
  contains_all: (answer, value) => value.every((id) => answer.includes(id)),
};

// Full replacement: supplied rule UUIDs are retained; omitted IDs are generated.
export function validateRules(questions, rules) {
  validateQuestions(questions);
  if (!Array.isArray(rules) || rules.length > LIMITS.jumpRules) {
    invalidField('rules', `Rules must be an array of at most ${LIMITS.jumpRules} items`);
  }
  const positions = new Map(questions.map((question, index) => [question.id, index]));
  const ids = new Set();
  const priorities = new Map();
  return rules.map((rule, index) => {
    const field = `rules[${index}]`;
    assertAllowedFields(rule,
      ['id', 'sourceQuestionId', 'operator', 'value', 'targetQuestionId', 'priority'], field);
    const id = Object.hasOwn(rule, 'id') ? assertQuestionId(rule.id, `${field}.id`) : randomUUID();
    if (ids.has(id)) invalidField(`${field}.id`, 'Duplicate rule ID');
    ids.add(id);
    const source = positions.get(rule.sourceQuestionId);
    if (source === undefined) invalidField(`${field}.sourceQuestionId`, 'Unknown source question');
    const target = positions.get(rule.targetQuestionId);
    if (rule.targetQuestionId !== END && (target === undefined || target <= source)) {
      invalidField(`${field}.targetQuestionId`, 'Target must be a later question or END');
    }
    const question = questions[source];
    if (!OPERATORS[question.type].includes(rule.operator)) {
      invalidField(`${field}.operator`, 'Operator does not match question type');
    }
    const priority = assertFiniteNumber(rule.priority, `${field}.priority`, { integer: true });
    if (priority < 0) invalidField(`${field}.priority`, 'Priority must be nonnegative');
    const used = priorities.get(question.id) ?? new Set();
    if (used.has(priority)) invalidField(`${field}.priority`, 'Duplicate priority for source question');
    used.add(priority);
    priorities.set(question.id, used);
    let value = rule.value;
    if (question.type === 'number') {
      value = assertFiniteNumber(value, `${field}.value`);
    } else {
      const optionIds = new Set(question.options.map((option) => option.id));
      if (['contains_any', 'contains_all'].includes(rule.operator)) {
        if (!Array.isArray(value) || value.length === 0 || value.length > question.options.length
            || new Set(value).size !== value.length
            || value.some((item) => typeof item !== 'string' || !optionIds.has(item))) {
          invalidField(`${field}.value`, 'Expected nonempty unique valid option IDs');
        }
        value = [...value];
      } else if (typeof value !== 'string' || !optionIds.has(value)) {
        invalidField(`${field}.value`, 'Expected a valid option ID');
      }
    }
    return { id, sourceQuestionId: question.id, operator: rule.operator,
      value, targetQuestionId: rule.targetQuestionId, priority };
  });
}

function next(questions, rules, index, answer) {
  if (answer !== null) {
    const matching = rules.filter((rule) => rule.sourceQuestionId === questions[index].id
      && matches[rule.operator](answer, rule.value));
    matching.sort((left, right) => left.priority - right.priority);
    if (matching.length) return matching[0].targetQuestionId;
  }
  return questions[index + 1]?.id ?? END;
}

// Returns a UUID or END; value is the raw answer to the current question.
export function getNextQuestion(survey, currentQuestionId, value) {
  const rules = validateRules(survey.questions, survey.jumpRules ?? []);
  const index = survey.questions.findIndex((question) => question.id === currentQuestionId);
  if (index === -1) invalidField('currentQuestionId', 'Unknown current question');
  const answer = validateAnswer(survey.questions[index], value);
  return next(survey.questions, rules, index, answer);
}

function submissionError(field, message, questionId) {
  throw new HttpError(422, 'INVALID_SUBMISSION', message,
    { field, ...(questionId === undefined ? {} : { questionId }) });
}

// Only answers are accepted here, never a client path. Survey structure is server-owned.
export function validateSubmission(survey, answers) {
  const rules = validateRules(survey.questions, survey.jumpRules ?? []);
  if (!survey.questions.length) invalidField('questions', 'A submission needs at least one question');
  if (!Array.isArray(answers) || answers.length > survey.questions.length) {
    submissionError('answers', 'Answers must be an array no longer than the question list');
  }
  const known = new Map(survey.questions.map((question, index) => [question.id, index]));
  const supplied = new Map();
  answers.forEach((answer, index) => {
    const field = `answers[${index}]`;
    try {
      assertAllowedFields(answer, ['questionId', 'value'], field);
    } catch (error) {
      if (error instanceof HttpError) submissionError(error.details?.field ?? field, error.message);
      throw error;
    }
    if (!known.has(answer.questionId)) submissionError(`${field}.questionId`, 'Unknown question ID');
    if (supplied.has(answer.questionId)) {
      submissionError(`${field}.questionId`, 'Duplicate question ID', answer.questionId);
    }
    supplied.set(answer.questionId, answer.value);
  });
  const path = [];
  const normalized = [];
  let current = survey.questions[0].id;
  while (current !== END) {
    const index = known.get(current);
    const question = survey.questions[index];
    const value = validateAnswer(question, supplied.get(current));
    path.push(current);
    if (value !== null) normalized.push({ questionId: current, value });
    supplied.delete(current);
    current = next(survey.questions, rules, index, value);
  }
  if (supplied.size) {
    const questionId = supplied.keys().next().value;
    submissionError('answers', 'Answer belongs to an unvisited question', questionId);
  }
  return { answers: normalized, path };
}

export { normalizeQuestion, validateAnswer } from '../validators/questions.js';
