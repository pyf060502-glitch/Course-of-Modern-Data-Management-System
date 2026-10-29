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

  function shareQuestion(messageNode, endpoint, questionTitle) {
    if (confirmationDialog) return Promise.resolve(false);
    const dialog = el('dialog', undefined, 'delete-confirmation');
    const heading = el('h2', '分享题目');
    heading.id = 'share-question-title';
    dialog.setAttribute('aria-labelledby', heading.id);
    const description = el('p', `将已保存的“${questionTitle}”分享给另一位注册用户。对方会在“通知”中收到题目，自行选择加入个人题库或删除。你的原题仍可继续使用，未保存的修改不包含在内。`, 'preserve-text');
    const form = el('form');
    const label = el('label', undefined, 'field');
    const username = el('input');
    username.name = 'username';
    username.type = 'text';
    username.required = true;
    username.minLength = 3;
    username.maxLength = 32;
    username.pattern = '[A-Za-z0-9_-]{3,32}';
    username.autocomplete = 'off';
    label.append(el('span', '对方用户名'), username);
    const feedback = el('div');
    feedback.hidden = true;
    feedback.tabIndex = -1;
    const actions = el('div', undefined, 'actions');
    const cancel = el('button', '取消', 'secondary');
    const submit = el('button', '确认分享');
    cancel.type = 'button';
    submit.type = 'submit';
    actions.append(cancel, submit);
    form.append(label, feedback, actions);
    dialog.append(heading, description, form);
    confirmationDialog = dialog;
    return new Promise((resolve, reject) => {
      let pending = false;
      let settled = false;
      function finish(shared) {
        if (settled) return;
        settled = true;
        dialog.remove();
        confirmationDialog = null;
        resolve(shared);
      }
      cancel.addEventListener('click', () => { if (!pending) finish(false); });
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (!pending) finish(false); });
      dialog.addEventListener('close', () => { if (!pending) finish(false); });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (pending || settled) return;
        const recipient = username.value.trim();
        if (!/^[A-Za-z0-9_-]{3,32}$/.test(recipient)) {
          showMessage(feedback, '请输入有效的注册用户名。', true);
          return;
        }
        pending = true;
        username.disabled = cancel.disabled = submit.disabled = true;
        showMessage(feedback);
        try {
          await request(endpoint, { method: 'POST', body: { username: recipient } });
          finish(true);
          showMessage(messageNode, '对方可在“通知”中选择是否加入题库。');
          messageNode?.scrollIntoView?.({ block: 'nearest' });
        } catch (error) {
          const hints = {
            RECIPIENT_NOT_FOUND: '未找到该用户，请检查用户名。',
            INVALID_RECIPIENT: '请选择其他用户，不能分享给自己。',
          };
          showMessage(feedback, `分享失败，${hints[error.code] ?? '请检查网络、登录状态或题目权限后再试一次。'}`, true);
        } finally {
          pending = false;
          username.disabled = cancel.disabled = submit.disabled = false;
        }
      });
      try {
        document.body.append(dialog);
        dialog.showModal();
        username.focus();
      } catch (error) {
        dialog.remove();
        confirmationDialog = null;
        reject(error);
      }
    });
  }

  function showQuestionHistory(messageNode, endpoint, questionTitle, hasUnsavedChanges = false, options = {}) {
    if (confirmationDialog) return Promise.resolve(false);
    const dialog = el('dialog', undefined, 'delete-confirmation history-dialog');
    const heading = el('h2', `题目历史版本：${questionTitle}`);
    heading.id = 'question-history-title';
    dialog.setAttribute('aria-labelledby', heading.id);
    const note = el('p', options.select ? '选择要用于当前问卷的版本；不会改变题库或其他问卷的内容。'
      : '关联题库和问卷共享版本历史，各处使用的内容独立。恢复只更新本处并新增版本，已发布问卷只能查看。', 'hint');
    const summary = el('p');
    const origin = el('p', undefined, 'hint');
    const feedback = el('div');
    feedback.hidden = true;
    feedback.tabIndex = -1;
    const cards = el('div');
    const controls = el('div', undefined, 'actions');
    const previous = el('button', '上一页', 'secondary');
    const next = el('button', '下一页', 'secondary');
    const close = el('button', '关闭', 'secondary');
    previous.type = next.type = close.type = 'button';
    controls.append(previous, next, close);
    dialog.append(heading, note, summary, origin, feedback);
    let acknowledge;
    if (hasUnsavedChanges) {
      const label = el('label', undefined, 'check');
      acknowledge = el('input');
      acknowledge.type = 'checkbox';
      label.append(acknowledge, el('span', '恢复时放弃当前页面未保存的修改'));
      dialog.append(label);
    }
    dialog.append(cards, controls);
    confirmationDialog = dialog;
    return new Promise((resolve, reject) => {
      let page = 1;
      let totalPages = 1;
      let working = false;
      let restoring = false;
      let settled = false;
      function finish(restored) {
        if (settled || restoring && !restored) return;
        settled = true;
        dialog.remove();
        confirmationDialog = null;
        resolve(restored);
      }
      async function loadHistory() {
        if (working || settled) return;
        working = true;
        previous.disabled = next.disabled = true;
        showMessage(feedback);
        try {
          const data = await request(`${endpoint}?page=${page}&pageSize=5`);
          if (settled) return;
          totalPages = data.totalPages;
          summary.textContent = `当前版本 v${data.currentVersion}，共 ${data.total} 个版本 · 第 ${page} 页`;
          const kinds = { survey: '问卷', library: '个人题库', shared: '分享题目' };
          origin.textContent = data.origin
            ? `来源：${data.origin.senderUsername ? `${data.origin.senderUsername} 分享的` : kinds[data.origin.kind] ?? ''}“${data.origin.title}” v${data.origin.version}${data.origin.surveyTitle ? `（问卷：${data.origin.surveyTitle}）` : ''}` : '来源：独立创建的题目';
          cards.replaceChildren();
          for (const version of data.items) {
            const card = el('article', undefined, 'question-card');
            card.append(el('h3', `v${version.number}${version.current ? '（当前）' : ''}`));
            card.append(el('p', version.restoredFromVersion
              ? `由 v${version.parentVersion} 恢复为 v${version.restoredFromVersion} 的内容`
              : version.parentVersion ? `由 v${version.parentVersion} 修改而来` : '初始版本', 'hint'));
            if (version.importedFrom) card.append(el('p', `合并自题目“${version.importedFrom.title}”`, 'hint'));
            card.append(el('p', dateLabel(version.createdAt), 'hint'), el('p', version.question.title, 'preserve-text'));
            const types = { single: '单选题', multiple: '多选题', text: '文本题', number: '数字题' };
            card.append(el('p', `${types[version.question.type]} · ${version.question.required ? '必答' : '选答'}`));
            if (version.question.options.length) card.append(el('p', version.question.options.map((option) => option.label).join(' / '), 'preserve-text'));
            const labels = { minSelections: '最少选择', maxSelections: '最多选择', exactSelections: '精确选择',
              minLength: '最短长度', maxLength: '最长长度', min: '最小值', max: '最大值', integer: '只允许整数' };
            const limits = Object.entries(version.question.validation).map(([key, value]) => `${labels[key]}：${typeof value === 'boolean' ? value ? '是' : '否' : value}`);
            card.append(el('p', limits.length ? limits.join('；') : '默认填写限制', 'hint'));
            if (options.select || options.allowBranch) {
              const choose = el('button', options.select ? '选用此版本' : '基于此版本创建新版本', 'secondary');
              choose.type = 'button';
              choose.addEventListener('click', () => {
                if (working || restoring || settled) return;
                finish({ versionId: version.id, version: version.number, question: version.question });
              });
              card.append(choose);
            }
            if (!options.select && data.canRestore && !version.current) {
              const restore = el('button', '恢复此版本');
              restore.type = 'button';
              restore.addEventListener('click', async () => {
                if (working || restoring || settled) return;
                if (acknowledge && !acknowledge.checked) {
                  showMessage(feedback, '请先确认放弃未保存的修改，再恢复版本。', true);
                  return;
                }
                restoring = true;
                cards.inert = true;
                previous.disabled = next.disabled = close.disabled = true;
                try {
                  await request(`${endpoint}/restore`, { method: 'POST', body: { versionId: version.id } });
                  finish(true);
                } catch {
                  showMessage(feedback, '保存失败，请再试一次', true);
                } finally {
                  restoring = false;
                  cards.inert = false;
                  close.disabled = false;
                  previous.disabled = page <= 1;
                  next.disabled = page >= totalPages;
                }
              });
              card.append(restore);
            }
            cards.append(card);
          }
        } catch (error) { if (!settled) showMessage(feedback, errorMessage(error), true); }
        finally { working = false; previous.disabled = page <= 1; next.disabled = page >= totalPages; }
      }
      previous.addEventListener('click', () => { if (!working && !restoring && page > 1) { page--; loadHistory(); } });
      next.addEventListener('click', () => { if (!working && !restoring && page < totalPages) { page++; loadHistory(); } });
      close.addEventListener('click', () => finish(false));
      dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
      dialog.addEventListener('close', () => finish(false));
      try { document.body.append(dialog); dialog.showModal(); close.focus(); loadHistory(); }
      catch (error) { dialog.remove(); confirmationDialog = null; reject(error); }
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

  async function run(messageNode, action, control, { saving = false } = {}) {
    showMessage(messageNode);
    if (control) control.disabled = true;
    try {
      const result = await action();
      if (saving && result !== false) {
        showMessage(messageNode, '保存成功');
        messageNode?.scrollIntoView?.({ block: 'nearest' });
      }
      return result;
    }
    catch (error) {
      showMessage(messageNode, saving ? '保存失败，请再试一次' : errorMessage(error), true);
      if (saving) messageNode?.scrollIntoView?.({ block: 'nearest' });
      return undefined;
    }
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

  let headerUserId = null;
  let notificationTimer;
  let notificationCountVersion = 0;
  async function refreshNotificationCount() {
    const badge = document.getElementById('notification-count');
    const notificationLink = document.getElementById('notification-link');
    if (!headerUserId || !badge || !notificationLink) return;
    const version = ++notificationCountVersion;
    try {
      const { pendingCount } = await request('/api/notifications/count');
      if (version !== notificationCountVersion || !badge.isConnected) return;
      if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) return;
      badge.textContent = pendingCount ? String(pendingCount) : '';
      badge.hidden = pendingCount === 0;
      notificationLink.title = pendingCount ? `${pendingCount}条待处理通知` : '暂无待处理通知';
      notificationLink.setAttribute('aria-description', notificationLink.title);
    } catch (error) {
      // Notification polling must not block the page or overwrite its feedback.
      if (version === notificationCountVersion && error.status === 401) {
        badge.hidden = true;
        notificationLink.title = '请登录查看通知';
        notificationLink.setAttribute('aria-description', notificationLink.title);
        headerUserId = null;
        clearInterval(notificationTimer);
      }
    }
  }
  window.addEventListener?.('focus', () => { refreshNotificationCount(); });
  if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') refreshNotificationCount();
  });

  async function initHeader({ requireAuth = false } = {}) {
    clearInterval(notificationTimer);
    headerUserId = null;
    notificationCountVersion++;
    const header = document.getElementById('site-header');
    const nav = el('nav', undefined, 'header-inner');
    nav.setAttribute('aria-label', '主导航');
    const notificationLink = link('通知', '/notifications', 'notification-link');
    notificationLink.id = 'notification-link';
    const notificationBadge = el('span', '', 'notification-count');
    notificationBadge.id = 'notification-count';
    notificationBadge.hidden = true;
    notificationBadge.setAttribute('aria-hidden', 'true');
    notificationLink.append(notificationBadge);
    nav.append(el('span', '问卷系统', 'brand'), link('我的问卷', '/surveys'), link('常用题库', '/question-library'), notificationLink);
    const account = el('div', undefined, 'actions account');
    nav.append(account);
    if (header) header.replaceChildren(nav);
    const user = await getUser();
    if (user) {
      headerUserId = user.id;
      account.append(el('span', `当前用户：${user.username}`));
      const logout = el('button', '退出', 'secondary');
      logout.type = 'button';
      logout.addEventListener('click', () => run(document.getElementById('page-message'), async () => {
        await request('/api/auth/logout', { method: 'POST' });
        headerUserId = null;
        clearInterval(notificationTimer);
        clearCsrfToken();
        location.assign('/login');
      }, logout));
      account.append(logout);
      await refreshNotificationCount();
      if (headerUserId) notificationTimer = setInterval(() => {
        if (document.visibilityState !== 'hidden') refreshNotificationCount();
      }, 15000);
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
    api: request, ApiError, getCsrfToken, clearCsrfToken, getUser, initHeader, refreshNotificationCount,
    el, link, showMessage, confirmAction, confirmDeletion, shareQuestion, showQuestionHistory, errorMessage, run, safeNext, loginUrl, idOf,
    effectiveStatus, statusLabel, dateLabel, toLocalDatetime, deadlineValue, participationHint,
  });
})();
