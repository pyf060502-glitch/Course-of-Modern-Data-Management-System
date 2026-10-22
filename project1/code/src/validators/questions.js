import { randomUUID } from 'node:crypto';
import { HttpError } from '../middleware/errors.js';
import {
  LIMITS, invalidField, assertAllowedFields, assertBoolean, assertString,
  assertFiniteNumber,
} from './basic.js';

export { LIMITS };
export const QUESTION_TYPES = Object.freeze(['single', 'multiple', 'text', 'number']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const has = (object, key) => Object.hasOwn(object, key);
const choiceType = (type) => type === 'single' || type === 'multiple';

export function assertQuestionId(value, field = 'questionId') {
  if (typeof value !== 'string' || !UUID.test(value)) {
    invalidField(field, `${field} must be a canonical UUID`);
  }
  return value;
}

function count(value, field, max) {
  assertFiniteNumber(value, field, { integer: true });
  if (value < 0 || value > max) invalidField(field, `${field} is outside the allowed range`);
  return value;
}

const configHandlers = {
  single(validation) {
    assertAllowedFields(validation, [], 'question.validation');
    return {};
  },
  multiple(validation, question) {
    const keys = ['minSelections', 'maxSelections', 'exactSelections'];
    assertAllowedFields(validation, keys, 'question.validation');
    const result = {};
    for (const key of keys) {
      if (has(validation, key)) {
        result[key] = count(validation[key], `question.validation.${key}`, question.options.length);
      }
    }
    const min = result.minSelections ?? 0;
    const max = result.maxSelections ?? question.options.length;
    const exact = result.exactSelections;
    if (min > max || (exact !== undefined && (exact < min || exact > max))
        || (question.required && (max < 1 || exact === 0))) {
      invalidField('question.validation', 'Selection constraints are inconsistent or unsatisfiable');
    }
    return result;
  },
  text(validation, question) {
    assertAllowedFields(validation, ['minLength', 'maxLength'], 'question.validation');
    const result = {};
    for (const key of ['minLength', 'maxLength']) {
      if (has(validation, key)) {
        result[key] = count(validation[key], `question.validation.${key}`, LIMITS.textAnswer);
      }
    }
    if ((result.minLength ?? 0) > (result.maxLength ?? LIMITS.textAnswer)
        || (question.required && result.maxLength === 0)) {
      invalidField('question.validation', 'Text constraints are inconsistent or unsatisfiable');
    }
    return result;
  },
  number(validation) {
    assertAllowedFields(validation, ['min', 'max', 'integer'], 'question.validation');
    const result = {};
    for (const key of ['min', 'max']) {
      if (has(validation, key)) {
        result[key] = assertFiniteNumber(validation[key], `question.validation.${key}`);
      }
    }
    if (has(validation, 'integer')) {
      result.integer = assertBoolean(validation.integer, 'question.validation.integer');
    }
    const min = result.min ?? -Number.MAX_SAFE_INTEGER;
    const max = result.max ?? Number.MAX_SAFE_INTEGER;
    if (min > max || (result.integer && Math.ceil(min) > Math.floor(max))) {
      invalidField('question.validation', 'Numeric constraints are inconsistent or unsatisfiable');
    }
    return result;
  },
};

function normalizeOptions(options, existingOptions) {
  if (!Array.isArray(options) || options.length < 1 || options.length > LIMITS.options) {
    invalidField('question.options', `Choose between 1 and ${LIMITS.options} options`);
  }
  const existingIds = new Set(existingOptions.map((option) => option.id));
  const ids = new Set();
  return options.map((option, index) => {
    const field = `question.options[${index}]`;
    assertAllowedFields(option, ['id', 'label'], field);
    let id;
    if (has(option, 'id')) {
      id = assertQuestionId(option.id, `${field}.id`);
      if (!existingIds.has(id)) invalidField(`${field}.id`, 'Option ID does not belong to this question');
    } else {
      id = randomUUID();
    }
    if (ids.has(id)) invalidField(`${field}.id`, 'Duplicate option ID');
    ids.add(id);
    return { id, label: assertString(option.label, `${field}.label`, { min: 1, max: LIMITS.title }) };
  });
}

// Updates are patches; validation is replaced, not merged. A type change resets validation.
export function normalizeQuestion(input, { existing, order } = {}) {
  assertAllowedFields(input, ['title', 'type', 'required', 'options', 'validation'], 'question');
  const type = has(input, 'type') ? input.type : existing?.type;
  if (!QUESTION_TYPES.includes(type)) invalidField('question.type', 'Unsupported question type');
  const changedType = existing && existing.type !== type;
  const question = {
    id: existing ? assertQuestionId(existing.id, 'question.id') : randomUUID(),
    order: order ?? existing?.order ?? 1,
    title: assertString(has(input, 'title') ? input.title : existing?.title,
      'question.title', { min: 1, max: LIMITS.title }),
    type,
    required: assertBoolean(has(input, 'required') ? input.required : existing?.required ?? false,
      'question.required'),
    options: [],
    validation: {},
  };
  count(question.order, 'question.order', LIMITS.questions);
  if (question.order < 1) invalidField('question.order', 'Order starts at 1');
  if (choiceType(type)) {
    const previous = choiceType(existing?.type) ? existing.options : [];
    question.options = normalizeOptions(has(input, 'options') ? input.options : previous, previous);
  } else if (has(input, 'options')) {
    invalidField('question.options', 'This question type does not accept options');
  }
  const validation = has(input, 'validation') ? input.validation
    : changedType ? {} : existing?.validation ?? {};
  question.validation = configHandlers[type](validation, question);
  return question;
}

// Validate persisted structure without allocating new IDs or silently fixing order.
export function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length > LIMITS.questions) {
    invalidField('questions', `Questions must be an array of at most ${LIMITS.questions} items`);
  }
  const ids = new Set();
  questions.forEach((question, index) => {
    assertAllowedFields(question,
      ['id', 'order', 'title', 'type', 'required', 'options', 'validation'], `questions[${index}]`);
    assertQuestionId(question.id, `questions[${index}].id`);
    if (ids.has(question.id)) invalidField(`questions[${index}].id`, 'Duplicate question ID');
    ids.add(question.id);
    if (question.order !== index + 1) invalidField(`questions[${index}].order`, 'Order must be continuous');
    if (!Array.isArray(question.options) || (!choiceType(question.type) && question.options.length)) {
      invalidField(`questions[${index}].options`, 'Invalid stored options');
    }
    for (const option of question.options) assertQuestionId(option?.id, 'question.options.id');
    const input = { title: question.title, type: question.type,
      required: question.required, validation: question.validation };
    if (choiceType(question.type)) input.options = question.options;
    normalizeQuestion(input, { existing: question });
  });
  return questions;
}

function answerError(question, field, message) {
  throw new HttpError(422, 'INVALID_ANSWER', message, { questionId: question.id, field });
}

const answerHandlers = {
  single(question, value) {
    if (typeof value !== 'string' || !question.options.some((option) => option.id === value)) {
      answerError(question, 'value', 'Answer must be a valid option ID');
    }
    return value;
  },
  multiple(question, value) {
    if (!Array.isArray(value)) answerError(question, 'value', 'Answer must be an option ID array');
    const valid = new Set(question.options.map((option) => option.id));
    if (value.some((id) => typeof id !== 'string' || !valid.has(id))
        || new Set(value).size !== value.length) {
      answerError(question, 'value', 'Unknown or duplicate option ID');
    }
    if (value.length === 0) return null;
    const { minSelections = 0, maxSelections = question.options.length, exactSelections } = question.validation;
    if (value.length < minSelections || value.length > maxSelections
        || (exactSelections !== undefined && value.length !== exactSelections)) {
      answerError(question, 'value', 'Selection count violates question constraints');
    }
    return [...value];
  },
  text(question, value) {
    if (typeof value !== 'string') answerError(question, 'value', 'Answer must be a string');
    const normalized = value.trim();
    if (!normalized) return null;
    const length = [...normalized].length;
    const { minLength = 0, maxLength = LIMITS.textAnswer } = question.validation;
    if (length < minLength || length > maxLength || length > LIMITS.textAnswer) {
      answerError(question, 'value', 'Text length violates question constraints');
    }
    return normalized;
  },
  number(question, value) {
    assertFiniteNumber(value, 'value', { integer: question.validation.integer ?? false });
    const { min = -Infinity, max = Infinity } = question.validation;
    if (value < min || value > max) answerError(question, 'value', 'Number is outside the allowed range');
    return value;
  },
};

// All empty optional values normalize to null. Callers omit them from stored answers.
export function validateAnswer(question, value) {
  try {
    let result = value === undefined || value === null ? null : answerHandlers[question.type](question, value);
    if (result === null && question.required) answerError(question, 'value', 'This question is required');
    return result;
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) {
      answerError(question, error.details?.field ?? 'value', error.message);
    }
    throw error;
  }
}
