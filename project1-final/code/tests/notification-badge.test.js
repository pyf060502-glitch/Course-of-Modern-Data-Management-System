import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/js/common.js', import.meta.url), 'utf8');
function setup({ user = { id: 'owner', username: 'owner' } } = {}) {
  function element() {
    return { children: [], attributes: {}, isConnected: true,
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener() {}, focus() {},
    };
  }
  const header = element();
  const message = element();
  message.textContent = '保存成功';
  const listeners = {};
  const timers = [];
  const state = { count: 0, reads: 0, read: null, status: 200 };
  function find(node, id) { return node.id === id ? node : node.children.map((child) => find(child, id)).find(Boolean); }
  const document = { visibilityState: 'visible', createElement: element,
    addEventListener(type, callback) { listeners[type] = callback; },
    getElementById(id) { return id === 'site-header' ? header : id === 'page-message' ? message : find(header, id); },
  };
  const response = (count, status = 200) => ({ ok: status === 200, status,
    json: async () => status === 200 ? { data: { pendingCount: count } } : { error: { message: 'Unavailable' } },
  });
  const context = { document, Headers, location: { pathname: '/surveys', search: '' },
    window: { addEventListener(type, callback) { listeners[type] = callback; } },
    setInterval(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearInterval() {},
    async fetch(path) {
      if (path === '/api/auth/me') return { ok: true, json: async () => ({ data: { user } }) };
      assert.equal(path, '/api/notifications/count');
      state.reads++;
      return state.read ? state.read() : response(state.count, state.status);
    },
  };
  vm.runInNewContext(source, context);
  return { app: context.window.SurveyApp, document, listeners, timers, state, response, message };
}

test('badge hides zero, displays exact pending count and schedules visible-page refresh', async () => {
  const f = setup();
  await f.app.initHeader();
  const badge = f.document.getElementById('notification-count');
  assert.equal(badge.hidden, true);
  f.state.count = 3;
  await f.app.refreshNotificationCount();
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '3');
  assert.equal(f.document.getElementById('notification-link').title, '3条待处理通知');
  f.state.count = 123;
  await f.app.refreshNotificationCount();
  assert.equal(badge.textContent, '123');
  f.state.count = 0;
  await f.app.refreshNotificationCount();
  assert.equal(badge.hidden, true);
  assert.equal(f.timers[0].delay, 15000);
  assert.equal(typeof f.listeners.focus, 'function');
  assert.equal(typeof f.listeners.visibilitychange, 'function');
});

test('anonymous navigation does not request or display a private count', async () => {
  const f = setup({ user: null });
  await f.app.initHeader();
  await f.app.refreshNotificationCount();
  assert.equal(f.state.reads, 0);
  assert.equal(f.document.getElementById('notification-count').hidden, true);
  assert.equal(f.timers.length, 0);
});

test('late badge responses cannot overwrite a newer refresh', async () => {
  const f = setup();
  await f.app.initHeader();
  const pending = [];
  f.state.read = () => new Promise((resolve) => pending.push(resolve));
  const older = f.app.refreshNotificationCount();
  const newer = f.app.refreshNotificationCount();
  pending[1](f.response(9));
  await newer;
  pending[0](f.response(2));
  await older;
  assert.equal(f.document.getElementById('notification-count').textContent, '9');
});

test('count failure preserves page feedback; expired authentication hides the badge', async () => {
  const f = setup();
  f.state.count = 2;
  await f.app.initHeader();
  f.state.status = 503;
  await f.app.refreshNotificationCount();
  assert.equal(f.message.textContent, '保存成功');
  assert.equal(f.document.getElementById('notification-count').textContent, '2');
  f.state.status = 401;
  await f.app.refreshNotificationCount();
  assert.equal(f.document.getElementById('notification-count').hidden, true);
  assert.equal(f.message.textContent, '保存成功');
});
