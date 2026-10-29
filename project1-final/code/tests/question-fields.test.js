import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { normalizeQuestion } from '../src/validators/questions.js';

const source = readFileSync(new URL('../public/js/question-fields.js', import.meta.url), 'utf8');
function element(tag, text) {
  let value = '';
  return {
    tag, textContent: text, children: [], listeners: {},
    get value() { return value; },
    set value(next) { value = String(next); },
    append(...nodes) { this.children.push(...nodes); },
    prepend(node) { this.children.unshift(node); },
    replaceChildren() { this.children = []; },
    setAttribute() {},
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  };
}
function setup() {
  const app = Object.freeze({ el: element });
  const context = { window: { SurveyApp: app } };
  vm.runInNewContext(source, context);
  return { app, create: context.window.SurveyQuestionFields };
}

test('shared question form loads alongside the frozen public API namespace', () => {
  const { app, create } = setup();
  assert.equal(typeof create, 'function');
  assert.ok(Object.isFrozen(app));
  assert.deepEqual(Object.keys(app), ['el']);
});

test('shared form preserves four-type validation and existing option IDs through edit/save', () => {
  const { create } = setup();
  const definitions = [
    { title: '年龄', type: 'number', required: true, validation: { min: 0, max: 120, integer: true } },
    { title: '职业', type: 'single', options: [{ label: '学生' }, { label: '其他' }] },
    { title: '爱好', type: 'multiple', options: [{ label: '甲' }, { label: '乙' }], validation: { exactSelections: 1 } },
    { title: '建议', type: 'text', validation: { minLength: 2, maxLength: 50 } },
  ];
  for (const definition of definitions) {
    const question = normalizeQuestion(definition);
    const form = create(element('fieldset'), question);
    const payload = JSON.parse(JSON.stringify(form.read()));
    assert.equal(payload.title, question.title);
    assert.deepEqual(payload.validation, question.validation);
    if (question.options.length) assert.deepEqual(payload.options, question.options);
    else assert.equal(payload.options, undefined);
  }
});
