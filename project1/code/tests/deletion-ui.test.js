import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const commonSource = readFileSync(new URL('../public/js/common.js', import.meta.url), 'utf8');
const listSource = readFileSync(new URL('../public/js/surveys.js', import.meta.url), 'utf8');
const editorSource = readFileSync(new URL('../public/js/editor.js', import.meta.url), 'utf8');
const surveyId = '507f1f77bcf86cd799439012';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function element(tag = 'div', text) {
  return {
    tag, textContent: text, children: [], listeners: {}, isConnected: true,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute() {},
    removeAttribute() {},
    focus() { this.focused = true; },
    remove() { this.isConnected = false; },
    showModal() { this.open = true; },
    addEventListener(type, listener) {
      (this.listeners[type] ??= []).push(listener);
    },
    emit(type) {
      const event = { preventDefault() {} };
      for (const listener of this.listeners[type] ?? []) listener(event);
    },
  };
}

function dialogFixture() {
  const body = element('body');
  const context = { window: {}, document: { body, createElement: element } };
  vm.runInNewContext(commonSource, context);
  return { app: context.window.SurveyApp, body };
}

for (const action of ['cancel-button', 'cancel', 'close', 'approve']) {
  test(`deletion dialog: ${action} only approves an explicit confirmation click`, async () => {
    const { app, body } = dialogFixture();
    const result = app.confirmDeletion('<img src=x> test survey');
    const dialog = body.children[0];
    const [cancel, approve] = dialog.children[2].children;
    assert.equal(cancel.focused, true);
    assert.equal(dialog.children[1].textContent, '<img src=x> test survey');
    if (action === 'cancel-button') cancel.emit('click');
    else if (action === 'approve') approve.emit('click');
    else dialog.emit(action);
    assert.equal(await result, action === 'approve');
    assert.equal(dialog.isConnected, false);
    // A late confirmation event must not turn a cancelled decision into approval.
    approve.emit('click');
    assert.equal(await result, action === 'approve');
    const next = app.confirmDeletion('Next');
    body.children[1].emit('close');
    assert.equal(await next, false);
  });
}

test('only one deletion dialog can be open at a time', async () => {
  const { app, body } = dialogFixture();
  const first = app.confirmDeletion('First');
  assert.equal(await app.confirmDeletion('Second'), false);
  assert.equal(body.children.length, 1);
  body.children[0].emit('cancel');
  assert.equal(await first, false);
});

test('failure to show a confirmation dialog never grants deletion', async () => {
  const { app, body } = dialogFixture();
  body.append = (dialog) => {
    body.children.push(dialog);
    dialog.showModal = () => { throw new Error('Unavailable dialog'); };
  };
  await assert.rejects(app.confirmDeletion('Test'), /Unavailable dialog/);
  assert.equal(body.children[0].isConnected, false);
});

async function listFixture(confirmDeletion) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const form = get('create-form');
  form.elements = {
    allowAnonymous: element('input'),
    allowMultipleResponses: element('input'),
  };
  const requests = [];
  const errors = [];
  let deleted = false;
  const app = {
    el: element,
    link: (text, href) => ({ ...element('a', text), href }),
    idOf: (record) => record.id,
    statusLabel: () => '草稿',
    dateLabel: () => '无截止时间',
    participationHint: () => 'Hint',
    initHeader: async () => ({ id: 'owner' }),
    confirmDeletion,
    showMessage: (node, text) => { node.textContent = text; },
    async api(path, options = {}) {
      requests.push({ path, method: options.method ?? 'GET' });
      if (options.method === 'DELETE') {
        deleted = true;
        return { deleted: true };
      }
      return {
        items: deleted ? [] : [{ id: surveyId, title: 'Keep me', status: 'draft' }],
        total: deleted ? 0 : 1,
      };
    },
    async run(node, action, control) {
      if (control) control.disabled = true;
      try { return await action(); }
      catch (error) { errors.push(error); }
      finally { if (control?.isConnected) control.disabled = false; }
    },
  };
  vm.runInNewContext(listSource, {
    window: { SurveyApp: app },
    document: { getElementById: get },
    confirm() { throw new Error('Native confirm must not be used for deletion'); },
  });
  await flush();
  const row = get('survey-list').children[0];
  const remove = row.children[2].children[0].children.at(-1);
  return { get, remove, requests, errors };
}

for (const decision of [false, undefined, 'false', true]) {
  test(`survey list sends DELETE only for boolean true, not ${String(decision)}`, async () => {
    const fixture = await listFixture(async () => decision);
    fixture.remove.emit('click');
    await flush();
    const deletions = fixture.requests.filter((request) => request.method === 'DELETE');
    assert.equal(deletions.length, decision === true ? 1 : 0);
    assert.equal(fixture.get('survey-list').children.length, decision === true ? 0 : 1);
    assert.equal(fixture.remove.disabled, false);
    assert.deepEqual(fixture.errors, []);
  });
}

test('repeated clicks while awaiting a decision never queue deletion; cancel allows retry', async () => {
  let settle;
  let calls = 0;
  const fixture = await listFixture(() => {
    calls += 1;
    return new Promise((resolve) => { settle = resolve; });
  });
  fixture.remove.emit('click');
  fixture.remove.emit('click');
  assert.equal(calls, 1);
  settle(false);
  await flush();
  assert.equal(fixture.requests.filter((request) => request.method === 'DELETE').length, 0);
  fixture.remove.emit('click');
  assert.equal(calls, 2);
  settle(true);
  await flush();
  assert.equal(fixture.requests.filter((request) => request.method === 'DELETE').length, 1);
});

test('dialog errors keep the survey and restore its delete button', async () => {
  const fixture = await listFixture(async () => { throw new Error('Dialog failed'); });
  fixture.remove.emit('click');
  await flush();
  assert.equal(fixture.requests.filter((request) => request.method === 'DELETE').length, 0);
  assert.equal(fixture.get('survey-list').children.length, 1);
  assert.equal(fixture.remove.disabled, false);
  assert.equal(fixture.errors[0].message, 'Dialog failed');
});

for (const confirmLabel of ['确认发布', '确认关闭']) {
  for (const action of ['cancel-button', 'cancel', 'close', 'approve']) {
    test(`${confirmLabel} dialog: ${action} requires an explicit approval click`, async () => {
      const { app, body } = dialogFixture();
      const result = app.confirmAction('Confirm state change', { confirmLabel });
      const dialog = body.children[0];
      const [cancel, approve] = dialog.children[2].children;
      assert.equal(approve.textContent, confirmLabel);
      assert.equal(cancel.focused, true);
      if (action === 'cancel-button') cancel.emit('click');
      else if (action === 'approve') approve.emit('click');
      else dialog.emit(action);
      assert.equal(await result, action === 'approve');
    });
  }
}

async function editorFixture(operation, confirmAction) {
  const nodes = new Map();
  const get = (id) => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  get('settings-form').elements = Object.fromEntries(
    ['title', 'description', 'deadline', 'allowAnonymous', 'allowMultipleResponses']
      .map((name) => [name, element('input')]),
  );
  const survey = {
    id: surveyId, title: 'State confirmation', description: '', deadline: null,
    status: operation === 'publish' ? 'draft' : 'published',
    questions: [], jumpRules: [],
  };
  const requests = [];
  const errors = [];
  const app = {
    el: element,
    confirmAction,
    initHeader: async () => ({ id: 'owner' }),
    effectiveStatus: (item) => item.status,
    statusLabel: (item) => item.status,
    toLocalDatetime: () => '',
    participationHint: () => '',
    showMessage: (node, text) => { node.textContent = text; },
    async api(path, options = {}) {
      requests.push({ path, method: options.method ?? 'GET' });
      if (options.method === 'POST') survey.status = operation === 'publish' ? 'published' : 'closed';
      return survey;
    },
    async run(node, action) {
      try { return await action(); }
      catch (error) { errors.push(error); }
    },
  };
  vm.runInNewContext(editorSource, {
    window: { SurveyApp: app, addEventListener() {} },
    document: { getElementById: get },
    location: { pathname: `/surveys/${surveyId}/edit`, origin: 'http://localhost', search: '' },
    confirm() { throw new Error('State changes must not use native confirm'); },
  });
  await flush();
  return { get, survey, requests, errors };
}

for (const operation of ['publish', 'close']) {
  for (const decision of [false, undefined, 'false', true]) {
    test(`editor ${operation}: only boolean true sends a state-changing request (${String(decision)})`, async () => {
      const fixture = await editorFixture(operation, async () => decision);
      const original = fixture.survey.status;
      fixture.get(operation).emit('click');
      await flush();
      assert.equal(fixture.requests.filter((request) => request.method === 'POST').length, decision === true ? 1 : 0);
      assert.equal(fixture.survey.status, decision === true ? (operation === 'publish' ? 'published' : 'closed') : original);
      assert.equal(fixture.get('editor-content').inert, false);
      assert.deepEqual(fixture.errors, []);
    });
  }

  test(`editor ${operation}: repeated clicks wait for one decision and cancellation allows retry`, async () => {
    let settle;
    let calls = 0;
    const fixture = await editorFixture(operation, () => {
      calls += 1;
      return new Promise((resolve) => { settle = resolve; });
    });
    fixture.get(operation).emit('click');
    fixture.get(operation).emit('click');
    await flush();
    assert.equal(calls, 1);
    settle(false);
    await flush();
    assert.equal(fixture.requests.filter((request) => request.method === 'POST').length, 0);
    fixture.get(operation).emit('click');
    await flush();
    assert.equal(calls, 2);
    settle(true);
    await flush();
    assert.equal(fixture.requests.filter((request) => request.method === 'POST').length, 1);
  });

  test(`editor ${operation}: dialog failure leaves state unchanged and releases the editor`, async () => {
    const fixture = await editorFixture(operation, async () => { throw new Error('Dialog failed'); });
    const original = fixture.survey.status;
    fixture.get(operation).emit('click');
    await flush();
    assert.equal(fixture.requests.filter((request) => request.method === 'POST').length, 0);
    assert.equal(fixture.survey.status, original);
    assert.equal(fixture.get('editor-content').inert, false);
    assert.equal(fixture.errors[0].message, 'Dialog failed');
  });

  test(`editor ${operation}: cancelling discard of unsaved settings also cancels the operation`, async () => {
    let confirmations = 0;
    const fixture = await editorFixture(operation, async () => {
      confirmations += 1;
      return false;
    });
    fixture.get('settings-form').emit('input');
    fixture.get(operation).emit('click');
    await flush();
    assert.equal(confirmations, 1);
    assert.equal(fixture.requests.filter((request) => request.method === 'POST').length, 0);
    assert.equal(fixture.get('editor-content').inert, false);
  });
}
