(function () {
  'use strict';
  let csrfPromise = null;
  let confirmationDialog = null;
  const labels = { draft: '草稿', published: '已发布', closed: '已关闭', expired: '已过期' };

  class ApiError extends Error {
    constructor(status, error) {
      super(error.message || '请求失败');
      this.name = 'ApiError';
      this.status = status;
      this.code = error.code || 'REQUEST_FAILED';
      this.details = error.details;
    }
  }

  async function request(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      headers.set('X-CSRF-Token', await getCsrfToken());
    }
    const init = { ...options, method, headers, credentials: 'same-origin', cache: 'no-store' };
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      init.body = JSON.stringify(options.body);
    }
    let response;
    try {
      response = await fetch(path, init);
    } catch {
      throw new ApiError(0, { code: 'NETWORK_ERROR', message: '网络连接失败，请检查服务后重试。' });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(response.status, { code: 'INVALID_RESPONSE', message: '服务器未返回有效 JSON。' });
    }
    if (!response.ok || payload.error) {
      throw new ApiError(response.status, payload.error || { message: '服务器请求失败。' });
    }
    if (!Object.hasOwn(payload, 'data')) {
      throw new ApiError(response.status, { code: 'INVALID_RESPONSE', message: '服务器响应缺少 data。' });
    }
    return payload.data;
  }

  function clearCsrfToken() { csrfPromise = null; }

  function getCsrfToken() {
    if (!csrfPromise) {
      csrfPromise = request('/api/auth/csrf').then((data) => {
        if (typeof data.csrfToken !== 'string' || !data.csrfToken) {
          throw new ApiError(200, { message: '服务器未返回 CSRF token。' });
        }
        return data.csrfToken;
      }).catch((error) => { clearCsrfToken(); throw error; });
    }
    return csrfPromise;
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }

  function link(text, href, className) {
    const node = el('a', text, className);
    node.href = href;
    return node;
  }

  function showMessage(node, message = '', error = false) {
    if (!node) return;
    node.textContent = message;
    node.hidden = !message;
    node.className = error ? 'message error' : 'message success';
    node.setAttribute('role', error ? 'alert' : 'status');
    if (error) node.focus();
  }

  function confirmAction(message, {
    title: heading = '确认操作', confirmLabel = '确认', danger = false,
  } = {}) {
    if (confirmationDialog) return Promise.resolve(false);
    const dialog = el('dialog', undefined, 'delete-confirmation');
    const title = el('h2', heading);
    title.id = 'delete-confirmation-title';
    dialog.setAttribute('aria-labelledby', title.id);
    const description = el('p', message, 'preserve-text');
    const actions = el('div', undefined, 'actions');
    const cancel = el('button', '取消', 'secondary');
    const approve = el('button', confirmLabel, danger ? 'danger' : '');
    cancel.type = approve.type = 'button';
    actions.append(cancel, approve);
    dialog.append(title, description, actions);
    confirmationDialog = dialog;
    return new Promise((resolve, reject) => {
      let settled = false;
      // Closing the dialog never grants approval; only the approve button does.
      function finish(approved) {
        if (settled) return;
        settled = true;
        dialog.remove();
        confirmationDialog = null;
        resolve(approved === true);
      }
      cancel.addEventListener('click', () => finish(false));
      approve.addEventListener('click', () => finish(true));
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish(false);
      });
      dialog.addEventListener('close', () => finish(false));
      try {
        document.body.append(dialog);
        dialog.showModal();
        cancel.focus();
      } catch (error) {
        dialog.remove();
        confirmationDialog = null;
        reject(error);
      }
    });
  }

  function confirmDeletion(message) {
    return confirmAction(message, {
      title: '确认删除问卷', confirmLabel: '确认删除', danger: true,
    });
  }

  function errorMessage(error) {
    const hints = {
      401: '请先登录，或重新登录后重试。',
      403: '安全令牌失效，请刷新页面后重试。',
      404: '资源不存在，或你没有访问权限。',
      409: '操作与当前状态冲突，请检查配置或刷新页面。',
      410: '问卷已关闭或过期。',
      503: '数据库暂不可用，请稍后重试。',
    };
    const parts = error.code === 'INVALID_CREDENTIALS'
      ? ['用户名或密码错误。', '如果没有账号须先注册账号。']
      : [hints[error.status], error.message];
    if (error.details?.questionId) parts.push(`题目：${error.details.questionId}`);
    if (error.details?.field) parts.push(`字段：${error.details.field}`);
    return parts.filter(Boolean).join(' ');
  }

  async function run(messageNode, action, control) {
    showMessage(messageNode);
    if (control) control.disabled = true;
    try { return await action(); }
    catch (error) { showMessage(messageNode, errorMessage(error), true); return undefined; }
    finally { if (control?.isConnected) control.disabled = false; }
  }

  function safeNext(value = new URLSearchParams(location.search).get('next')) {
    if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return '/surveys';
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin ? url.pathname + url.search + url.hash : '/surveys';
    } catch { return '/surveys'; }
  }

  function loginUrl() {
    return '/login?next=' + encodeURIComponent(location.pathname + location.search);
  }

  async function getUser() {
    const data = await request('/api/auth/me');
    return data.user;
  }

  async function initHeader({ requireAuth = false } = {}) {
    const header = document.getElementById('site-header');
    const nav = el('nav', undefined, 'header-inner');
    nav.setAttribute('aria-label', '主导航');
    nav.append(el('span', '问卷系统', 'brand'), link('我的问卷', '/surveys'));
    const account = el('div', undefined, 'actions account');
    nav.append(account);
    if (header) header.replaceChildren(nav);
    const user = await getUser();
    if (user) {
      account.append(el('span', `当前用户：${user.username}`));
      const logout = el('button', '退出', 'secondary');
      logout.type = 'button';
      logout.addEventListener('click', () => run(document.getElementById('page-message'), async () => {
        await request('/api/auth/logout', { method: 'POST' });
        clearCsrfToken();
        location.assign('/login');
      }, logout));
      account.append(logout);
    } else {
      account.append(link('登录', loginUrl()), link('注册', '/register'));
      if (requireAuth) location.replace(loginUrl());
    }
    return user;
  }

  function effectiveStatus(survey) {
    if (survey.effectiveStatus) return survey.effectiveStatus;
    if (survey.status === 'published' && survey.deadline && new Date(survey.deadline).getTime() <= Date.now()) return 'expired';
    return survey.status;
  }

  function statusLabel(survey) { return labels[effectiveStatus(survey)] || '未知状态'; }
  function idOf(record) { return record.id || record._id; }
  function dateLabel(value) { return value ? new Date(value).toLocaleString('zh-CN') : '无截止时间'; }
  function toLocalDatetime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }
  function deadlineValue(input) {
    if (!input.value) return null;
    const date = new Date(input.value);
    if (!Number.isFinite(date.getTime())) throw new Error('请填写有效截止时间。');
    return date.toISOString();
  }
  function participationHint(anonymous, multiple) {
    return !multiple
      ? '禁止重复填写时必须登录，即使允许匿名也不例外；匿名身份无法可靠防重复。'
      : anonymous ? '允许未登录者匿名填写；每次填写独立计数。' : '填写者必须登录；允许重复填写，每次独立计数。';
  }

  window.SurveyApp = Object.freeze({
    api: request, ApiError, getCsrfToken, clearCsrfToken, getUser, initHeader,
    el, link, showMessage, confirmAction, confirmDeletion, errorMessage, run, safeNext, loginUrl, idOf,
    effectiveStatus, statusLabel, dateLabel, toLocalDatetime, deadlineValue, participationHint,
  });
})();
