import { ObjectId } from 'mongodb';
import { HttpError } from '../middleware/errors.js';

export const LIMITS = Object.freeze({
  title: 200, description: 5000, questions: 100, options: 50,
  jumpRules: 500, textAnswer: 10000,
});

export function invalidField(field, message) {
  throw new HttpError(400, 'INVALID_INPUT', message, { field });
}

export function assertPlainObject(value, field = 'body') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalidField(field, `${field} must be an object`);
  }
  return value;
}

export function rejectUnsafeKeys(value, field = 'body') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectUnsafeKeys(item, `${field}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    assertPlainObject(value, field);
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('$') || key.includes('.')
          || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        invalidField(`${field}.${key}`, 'Unsafe request field');
      }
      rejectUnsafeKeys(item, `${field}.${key}`);
    }
  }
  return value;
}

export function assertAllowedFields(value, allowedFields, field = 'body') {
  assertPlainObject(value, field);
  rejectUnsafeKeys(value, field);
  for (const key of Object.keys(value)) {
    if (!allowedFields.includes(key)) invalidField(`${field}.${key}`, 'Unknown request field');
  }
  return value;
}

export function parseObjectId(value, field = 'id') {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{24}$/.test(value)) {
    invalidField(field, `${field} must be a 24-character hexadecimal ID`);
  }
  return new ObjectId(value);
}

export function assertString(value, field, { min = 0, max = Infinity, trim = true } = {}) {
  if (typeof value !== 'string') invalidField(field, `${field} must be a string`);
  const result = trim ? value.trim() : value;
  const length = [...result].length;
  if (length < min || length > max) invalidField(field, `${field} has an invalid length`);
  return result;
}

export function assertBoolean(value, field) {
  if (typeof value !== 'boolean') invalidField(field, `${field} must be a boolean`);
  return value;
}

export function assertFiniteNumber(value, field, { integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)
      || (Number.isInteger(value) && !Number.isSafeInteger(value))
      || (integer && !Number.isSafeInteger(value))) {
    invalidField(field, `${field} must be a finite${integer ? ' safe integer' : ' number'}`);
  }
  return value;
}
