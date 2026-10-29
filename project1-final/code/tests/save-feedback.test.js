import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/js/common.js', import.meta.url), 'utf8');
function setup() {
  const context = { window: {} };
  vm.runInNewContext(source, context);
  const message = { setAttribute() {}, focus() {}, scrollIntoView() { this.scrolled = true; } };
  return { app: context.window.SurveyApp, message };
}

test('save feedback reports success/failure, restores button and stays silent on cancellation', async () => {
  for (const outcome of ['success', 'failure', 'cancel']) {
    const { app, message } = setup();
    const control = { isConnected: true };
    await app.run(message, async () => {
      assert.equal(control.disabled, true);
      if (outcome === 'failure') throw new Error('Internal detail');
      return outcome === 'cancel' ? false : { saved: true };
    }, control, { saving: true });
    assert.equal(message.textContent, outcome === 'success' ? '保存成功'
      : outcome === 'failure' ? '保存失败，请再试一次' : '');
    assert.equal(message.hidden, outcome === 'cancel');
    assert.equal(control.disabled, false);
    if (outcome !== 'cancel') assert.equal(message.scrolled, true);
  }
});

test('ordinary operations keep their existing error hints and do not report save success', async () => {
  const { app, message } = setup();
  await app.run(message, async () => { throw new Error('Existing failure'); });
  assert.equal(message.textContent, 'Existing failure');
  await app.run(message, async () => {});
  assert.equal(message.textContent, '');
});
