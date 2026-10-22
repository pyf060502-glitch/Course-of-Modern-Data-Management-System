(function () {
  'use strict';
  // Only this adapter depends on the shared API/header contract.
  const app = window.SurveyApp;
  const api = (...args) => app.api(...args);
  const $ = (id) => document.getElementById(id);
  const form = $('respond-form');
  const answers = new Map();
  const path = [];
  let survey;
  let busy = false;
  let ended = false;
  const route = location.pathname.match(/^\/survey\/([a-fA-F0-9]{24})\/?$/);
  const surveyId = route?.[1];
  const operators = {
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

  function message(id, text = '', error = true) {
    const node = $(id);
    node.textContent = text;
    node.hidden = !text;
    node.className = error ? 'message error' : 'message';
    node.setAttribute('role', error ? 'alert' : 'status');
    if (text && error) node.focus();
  }

  function errorText(error) {
    const hints = {
      401: '登录已失效，请登录后重试。',
      403: '安全令牌失效，请刷新页面后重试。',
      404: '问卷不存在或尚未发布。',
      409: '无法提交：可能已填写过此问卷，或问卷状态已变化。',
      410: '问卷已关闭或过期，不能继续提交。',
      422: '答案未通过校验，请检查提示的题目。',
      503: '服务暂不可用，请稍后重试。',
    };
    return [hints[error.status], error.message].filter(Boolean).join(' ');
  }

  function currentQuestion() {
    return survey.questions.find((question) => question.id === path[path.length - 1]);
  }

  function limits(question) {
    const v = question.validation;
    const notes = [question.required ? '必答' : '可选，可留空'];
    if (question.type === 'multiple') {
      if (v.exactSelections !== undefined) notes.push(`非空时必须选择 ${v.exactSelections} 项`);
      if (v.minSelections !== undefined) notes.push(`非空时至少选择 ${v.minSelections} 项`);
      notes.push(`最多选择 ${v.maxSelections ?? question.options.length} 项`);
    }
    if (question.type === 'text') {
      notes.push(`去除首尾空白后，按 Unicode 码点计数，长度 ${v.minLength ?? 0}～${v.maxLength ?? 10000}，全局最多 10000`);
    }
    if (question.type === 'number') {
      if (v.integer) notes.push('必须为安全整数');
      else notes.push('必须为有限数字；整数不能超过安全整数范围');
      if (v.min !== undefined) notes.push(`最小值 ${v.min}`);
      if (v.max !== undefined) notes.push(`最大值 ${v.max}`);
      notes.push('0 是有效答案，留空不等于 0');
    }
    return notes.join('；');
  }

  function renderQuestion() {
    ended = false;
    form.hidden = false;
    $('submit-panel').hidden = true;
    message('answer-message');
    const question = currentQuestion();
    const fieldset = app.el('fieldset');
    fieldset.append(app.el('legend', `${question.order}. ${question.title}`));
    const hint = app.el('p', limits(question), 'hint');
    hint.id = 'answer-limits';
    fieldset.append(hint);
    const value = answers.get(question.id);
    if (['single', 'multiple'].includes(question.type)) {
      for (const option of question.options) {
        const label = app.el('label', undefined, 'check');
        const input = app.el('input');
        input.type = question.type === 'single' ? 'radio' : 'checkbox';
        input.name = 'answer';
        input.value = option.id;
        input.checked = question.type === 'single' ? value === option.id : (value ?? []).includes(option.id);
        input.setAttribute('aria-describedby', hint.id);
        // Shared input styles are wide by default, including radio inputs.
        input.style.width = '18px';
        input.style.flexShrink = '0';
        label.append(input, app.el('span', option.label, 'preserve-text'));
        fieldset.append(label);
      }
      if (question.type === 'single' && !question.required) {
        const clear = app.el('button', '清除选择', 'secondary');
        clear.type = 'button';
        clear.addEventListener('click', () => {
          fieldset.querySelectorAll('input').forEach((input) => { input.checked = false; });
        });
        fieldset.append(clear);
      }
    } else {
      const label = app.el('label', undefined, 'field');
      label.append(app.el('span', question.type === 'number' ? '请输入数字' : '请输入文本'));
      const input = app.el(question.type === 'text' ? 'textarea' : 'input');
      input.name = 'answer';
      input.id = 'answer-input';
      input.setAttribute('aria-describedby', hint.id);
      if (question.type === 'text') input.rows = 5;
      else {
        input.type = 'number';
        input.step = question.validation.integer ? '1' : 'any';
      }
      input.value = value ?? '';
      label.append(input);
      fieldset.append(label);
    }
    $('question-container').replaceChildren(fieldset);
    $('question-progress').textContent = `当前为已访问的第 ${path.length} 题；原问卷共 ${survey.questions.length} 题，跳转可能跳过部分题目。`;
    $('previous-question').disabled = path.length <= 1 || busy;
    $('next-question').disabled = busy;
    fieldset.querySelector('input, textarea')?.focus();
  }

  function readAnswer(question) {
    let value;
    if (question.type === 'single') {
      value = form.querySelector('input[name="answer"]:checked')?.value ?? null;
    } else if (question.type === 'multiple') {
      value = Array.from(form.querySelectorAll('input[name="answer"]:checked'), (node) => node.value);
      if (!value.length) value = null;
    } else {
      const input = $('answer-input');
      const raw = input.value.trim();
      // Number('') is zero, and invalid number input can expose an empty value.
      if (question.type === 'number' && input.validity.badInput) throw new Error('请输入有效数字。');
      value = raw === '' ? null : question.type === 'number' ? Number(raw) : raw;
    }
    if (value === null) {
      if (question.required) throw new Error('本题必答，请填写后继续。');
      return null;
    }
    const v = question.validation;
    if (question.type === 'multiple') {
      if (value.length < (v.minSelections ?? 0)
          || value.length > (v.maxSelections ?? question.options.length)
          || (v.exactSelections !== undefined && value.length !== v.exactSelections)) {
        throw new Error('选择数量不符合本题限制。');
      }
    }
    if (question.type === 'text') {
      const length = [...value].length;
      if (length < (v.minLength ?? 0) || length > (v.maxLength ?? 10000) || length > 10000) {
        throw new Error('去除首尾空白后的文本长度不符合本题限制。');
      }
    }
    if (question.type === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))
          || (v.integer && !Number.isSafeInteger(value))) {
        throw new Error('请输入有限数字；整数必须在安全整数范围内。');
      }
      if (value < (v.min ?? -Infinity) || value > (v.max ?? Infinity)) {
        throw new Error('数字超出本题允许范围。');
      }
    }
    return value;
  }

  function nextQuestion(question, value) {
    if (value !== null) {
      const matching = (survey.jumpRules ?? [])
        .filter((rule) => rule.sourceQuestionId === question.id
          && operators[rule.operator](value, rule.value))
        .sort((left, right) => left.priority - right.priority);
      if (matching.length) return matching[0].targetQuestionId;
    }
    const index = survey.questions.findIndex((item) => item.id === question.id);
    return survey.questions[index + 1]?.id ?? 'END';
  }

  function showEnd() {
    ended = true;
    form.hidden = true;
    $('submit-panel').hidden = false;
    $('submit-summary').textContent = `实际访问 ${path.length} 题，非空回答 ${answers.size} 题。`;
    $('submit-response').focus();
  }

  // Drop everything after the destination, including cached skipped answers.
  function returnTo(index) {
    if (busy || index < 0) return;
    const retained = new Set(path.slice(0, index + 1));
    for (const id of answers.keys()) if (!retained.has(id)) answers.delete(id);
    path.splice(index + 1);
    message('page-message');
    renderQuestion();
  }

  function loginPrompt() {
    form.hidden = true;
    $('submit-panel').hidden = true;
    $('respond-login').href = app.loginUrl();
    $('login-prompt').hidden = false;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (busy) return;
    try {
      const question = currentQuestion();
      const value = readAnswer(question);
      const next = nextQuestion(question, value);
      if (value === null) answers.delete(question.id);
      else answers.set(question.id, value);
      message('page-message');
      if (next === 'END') showEnd();
      else {
        if (!survey.questions.some((item) => item.id === next) || path.includes(next)) {
          throw new Error('问卷跳转配置无效，请联系作者。');
        }
        path.push(next);
        renderQuestion();
      }
    } catch (error) { message('answer-message', error.message); }
  });
  $('previous-question').addEventListener('click', () => returnTo(path.length - 2));
  $('edit-last-question').addEventListener('click', () => returnTo(path.length - 1));
  $('submit-response').addEventListener('click', async () => {
    if (busy || !ended) return;
    busy = true;
    $('submit-response').disabled = true;
    $('edit-last-question').disabled = true;
    message('page-message', '正在提交，请勿重复操作。', false);
    try {
      const result = await api(`/api/public/surveys/${surveyId}/responses`, {
        method: 'POST',
        body: { answers: path.filter((id) => answers.has(id)).map((id) => ({
          questionId: id, value: answers.get(id),
        })) },
      });
      const fallback = `/survey/${surveyId}/complete`;
      let destination = fallback;
      try {
        const complete = new URL(result.completionUrl ?? fallback, location.origin);
        if (complete.origin === location.origin && complete.pathname === fallback) {
          destination = complete.pathname;
        }
      } catch { /* The submission succeeded; use the generic local completion page. */ }
      // Do not propagate private IDs or answer data in query/hash.
      location.assign(destination);
    } catch (error) {
      busy = false;
      const index = path.indexOf(error.details?.questionId);
      if (index >= 0) {
        returnTo(index);
        message('answer-message', errorText(error));
      } else message('page-message', errorText(error));
      if (error.status === 401) loginPrompt();
      if (error.status === 410 || error.status === 404) {
        form.hidden = true;
        $('submit-panel').hidden = true;
      }
    } finally {
      busy = false;
      $('submit-response').disabled = false;
      $('edit-last-question').disabled = false;
    }
  });

  async function start() {
    try {
      if (!app) throw new Error('公共前端工具未加载，请刷新后重试。');
      if (!surveyId) throw new Error('问卷地址无效。');
      const user = await app.initHeader();
      survey = await api(`/api/public/surveys/${surveyId}`);
      $('survey-title').textContent = survey.title;
      $('survey-description').textContent = survey.description || '暂无问卷说明。';
      $('survey-deadline').textContent = `截止时间：${app.dateLabel(survey.deadline)}`;
      $('participation-hint').textContent = app.participationHint(survey.allowAnonymous, survey.allowMultipleResponses);
      $('survey-info').hidden = false;
      message('page-message');
      const status = app.effectiveStatus(survey);
      if (status !== 'published') throw new Error('问卷未开放、已关闭或已过期，不能填写。');
      const requiresLogin = survey.requiresLogin ?? (!survey.allowAnonymous || !survey.allowMultipleResponses);
      if ((!user && requiresLogin) || survey.submissionBlockedReason === 'login_required') {
        loginPrompt();
        return;
      }
      if (survey.canSubmit === false) throw new Error('当前不能填写此问卷，请刷新页面或联系作者。');
      if (!survey.questions?.length) throw new Error('问卷没有可填写的题目。');
      path.push(survey.questions[0].id);
      renderQuestion();
    } catch (error) { message('page-message', errorText(error)); }
  }
  start();
})();
