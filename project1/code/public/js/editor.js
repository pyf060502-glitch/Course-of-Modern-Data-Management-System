(function () {
  'use strict';
  const A = window.SurveyApp;
  const message = document.getElementById('page-message');
  const content = document.getElementById('editor-content');
  const settings = document.getElementById('settings-form');
  const pathMatch = location.pathname.match(/^\/surveys\/([a-fA-F0-9]{24})\/edit\/?$/);
  const surveyId = pathMatch?.[1] || new URLSearchParams(location.search).get('id');
  const validId = typeof surveyId === 'string' && /^[a-fA-F0-9]{24}$/.test(surveyId);
  const base = `/api/surveys/${encodeURIComponent(surveyId || '')}`;
  const typeLabels = { single: '单选题', multiple: '多选题', text: '文本填空题', number: '数字填空题' };
  const operators = {
    single: ['equals', 'not_equals'],
    multiple: ['contains', 'not_contains', 'contains_any', 'contains_all'],
    number: ['equals', 'not_equals', 'greater_than', 'greater_or_equal', 'less_than', 'less_or_equal'],
    text: [],
  };
  const operatorLabels = {
    equals: '等于', not_equals: '不等于', contains: '包含', not_contains: '不包含',
    contains_any: '包含任意一个', contains_all: '包含全部',
    greater_than: '大于', greater_or_equal: '大于或等于', less_than: '小于', less_or_equal: '小于或等于',
  };
  let survey;
  let busy = false;
  const dirty = new Set();
  let ruleReaders = [];
  let newQuestionCount = 0;
  const isDraft = () => A.effectiveStatus(survey) === 'draft';
  const isEditable = () => ['draft', 'published'].includes(A.effectiveStatus(survey));
  const choice = (type) => ['single', 'multiple'].includes(type);

  function input(type, value = '') {
    const node = A.el('input');
    node.type = type;
    node.value = value;
    return node;
  }
  function field(parent, text, node) {
    const label = A.el('label', undefined, 'field');
    label.append(A.el('span', text), node);
    parent.append(label);
    return node;
  }
  function check(parent, text, checked = false) {
    const node = input('checkbox');
    node.checked = checked;
    const label = A.el('label', undefined, 'check');
    label.append(node, A.el('span', text));
    parent.append(label);
    return node;
  }
  function select(parent, text, entries, value) {
    const node = A.el('select');
    for (const [id, label] of entries) {
      const option = A.el('option', label);
      option.value = id;
      node.append(option);
    }
    if (value !== undefined) {
      if (!entries.some(([id]) => id === value)) {
        const invalid = A.el('option', '原配置已失效，请重新选择');
        invalid.value = '';
        node.prepend(invalid);
        node.value = '';
      } else node.value = value;
    }
    field(parent, text, node);
    node.required = true;
    return node;
  }
  function button(parent, text, action, className = 'secondary') {
    const node = A.el('button', text, className);
    node.type = 'button';
    node.addEventListener('click', action);
    parent.append(node);
    return node;
  }
  function numberValue(node, label, { integer = false, optional = false } = {}) {
    if (!node.value.trim()) {
      if (optional) return undefined;
      throw new Error(`${label}不能为空。`);
    }
    const value = Number(node.value);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))
      || (integer && !Number.isSafeInteger(value))) throw new Error(`${label}必须是有效${integer ? '整数' : '数字'}。`);
    return value;
  }
  function mark(key, node) {
    node.addEventListener('input', () => dirty.add(key));
    node.addEventListener('change', () => dirty.add(key));
  }
  async function allowDiscard(except) {
    return ![...dirty].some((key) => key !== except)
      || await A.confirmAction('此操作会重新读取问卷，其他未保存的表单修改将丢失。继续吗？', {
        title: '确认放弃未保存的修改', confirmLabel: '放弃修改并继续',
      }) === true;
  }
  async function load() {
    const data = await A.api(base);
    survey = data.survey || data;
    if (!Array.isArray(survey.questions) || !Array.isArray(survey.jumpRules)) {
      throw new Error('管理问卷响应缺少 questions 或 jumpRules 数组。');
    }
    render();
    content.hidden = false;
  }
  async function mutation(action, success, except, structure = false, confirmation) {
    if (busy) return;
    busy = true;
    await A.run(message, async () => {
      content.inert = true;
      content.setAttribute('aria-busy', 'true');
      try {
        if (!isEditable() || (structure && !isDraft())) throw new Error('当前问卷状态不允许此修改，请重新读取。');
        if (await allowDiscard(except) !== true) return;
        if (confirmation && await A.confirmAction(confirmation.message, confirmation) !== true) return;
        const result = await action();
        if (result === false) return;
        await load();
        A.showMessage(message, typeof success === 'function' ? success(result) : success);
      } finally {
        busy = false;
        content.inert = false;
        content.removeAttribute('aria-busy');
      }
    });
  }

  function participationHint() {
    document.getElementById('participation-hint').textContent = A.participationHint(
      settings.elements.allowAnonymous.checked, settings.elements.allowMultipleResponses.checked,
    );
  }

  function render() {
    dirty.clear();
    newQuestionCount = 0;
    document.getElementById('survey-heading').textContent = survey.title;
    document.getElementById('survey-status').textContent = A.statusLabel(survey);
    document.getElementById('status-notice').textContent = isDraft()
      ? '草稿：可编辑全部配置。发布至少需要一题；发布后题目、规则和参与设置锁定。'
      : isEditable() ? '已发布：题目、规则和参与设置只读；可以修改标题、说明和有效截止时间，或关闭问卷。'
        : '问卷已关闭或过期，仅可查看、统计和删除，不能重新打开。';
    const publicLink = document.getElementById('public-link');
    publicLink.hidden = survey.status === 'draft';
    publicLink.href = `/survey/${surveyId}`;
    publicLink.textContent = `填写链接：${location.origin}/survey/${surveyId}`;
    document.getElementById('statistics-link').href = `/surveys/${surveyId}/statistics`;
    document.getElementById('publish').hidden = !isDraft();
    document.getElementById('close').hidden = A.effectiveStatus(survey) !== 'published';
    settings.elements.title.value = survey.title;
    settings.elements.description.value = survey.description || '';
    settings.elements.deadline.value = A.toLocalDatetime(survey.deadline);
    settings.elements.allowAnonymous.checked = survey.allowAnonymous;
    settings.elements.allowMultipleResponses.checked = survey.allowMultipleResponses;
    document.getElementById('settings-fields').disabled = !isEditable();
    document.getElementById('participation-fields').disabled = !isDraft();
    document.getElementById('save-settings').hidden = !isEditable();
    participationHint();
    const questions = document.getElementById('question-list');
    questions.replaceChildren();
    if (!survey.questions.length) questions.append(A.el('p', '暂无题目，请添加并保存题目。', 'hint'));
    survey.questions.forEach((question, index) => questions.append(questionForm(question, index)));
    document.getElementById('add-question').hidden = !isDraft();
    document.getElementById('add-question').disabled = survey.questions.length >= 100;
    renderRules();
  }

  function questionForm(question, index) {
    const key = question ? `question:${question.id}` : `new:${++newQuestionCount}`;
    const form = A.el('form', undefined, 'question-card');
    form.append(A.el('h3', question ? `第 ${index + 1} 题` : '新题目（尚未保存）'));
    const fields = A.el('fieldset');
    fields.disabled = !isDraft();
    form.append(fields);
    const title = field(fields, '题目标题', input('text', question?.title || ''));
    title.required = true;
    title.maxLength = 200;
    const type = select(fields, '题型', Object.entries(typeLabels), question?.type || 'single');
    const required = check(fields, '必答', question?.required || false);
    const config = A.el('div');
    fields.append(config);
    let readConfig;
    let optionDraft = choice(question?.type) ? question.options.map((option) => ({ ...option })) : [];
    let readOptions = () => optionDraft;
    let previousType = type.value;

    function drawConfig(initial = false) {
      if (!initial && choice(previousType)) optionDraft = readOptions();
      config.replaceChildren();
      const current = type.value;
      const validation = initial ? question?.validation || {} : {};
      let optionRows = [];
      if (choice(current)) {
        config.append(A.el('h3', '选项'));
        const optionsBox = A.el('div');
        config.append(optionsBox);
        const add = button(config, '添加选项', () => {
          if (optionRows.length >= 50) return;
          addOption({ label: '' });
          dirty.add(key);
        });
        function addOption(option) {
          const row = A.el('div', undefined, 'option-row');
          const label = input('text', option.label);
          label.required = true;
          label.maxLength = 200;
          label.setAttribute('aria-label', '选项标签');
          const entry = { row, label, id: option.id };
          row.append(label);
          button(row, '移除选项', () => {
            row.remove();
            optionRows = optionRows.filter((item) => item !== entry);
            add.disabled = optionRows.length >= 50;
            dirty.add(key);
          });
          optionRows.push(entry);
          optionsBox.append(row);
          add.disabled = optionRows.length >= 50;
        }
        (optionDraft.length ? optionDraft : [{ label: '' }, { label: '' }]).forEach(addOption);
        readOptions = () => optionRows.map(({ id, label }) => ({
          ...(id ? { id } : {}), label: label.value.trim(),
        }));
      }
      const validationBox = A.el('div', undefined, 'grid');
      config.append(validationBox);
      const controls = {};
      const entries = current === 'multiple'
        ? [['minSelections', '最少选择数'], ['maxSelections', '最多选择数'], ['exactSelections', '精确选择数']]
        : current === 'text' ? [['minLength', '最短字符数'], ['maxLength', '最长字符数']]
          : current === 'number' ? [['min', '最小值'], ['max', '最大值']] : [];
      for (const [name, label] of entries) {
        const node = input('number', validation[name] ?? '');
        node.step = current === 'number' ? 'any' : '1';
        if (current !== 'number') { node.min = '0'; node.max = current === 'text' ? '10000' : '50'; }
        controls[name] = { node, label };
        field(validationBox, label + '（可留空）', node);
      }
      const integer = current === 'number' ? check(config, '只允许整数', validation.integer || false) : null;
      if (current === 'single') config.append(A.el('p', '单选题无需额外校验配置。', 'hint'));
      readConfig = () => {
        const result = {};
        for (const [name, { node, label }] of Object.entries(controls)) {
          const value = numberValue(node, label, { integer: current !== 'number', optional: true });
          if (value !== undefined) result[name] = value;
        }
        if (integer) result.integer = integer.checked;
        const payload = { title: title.value.trim(), type: current, required: required.checked, validation: result };
        if (choice(current)) {
          payload.options = readOptions();
          if (!payload.options.length || payload.options.length > 50 || payload.options.some((option) => !option.label)) {
            throw new Error('选择题需要 1～50 个非空选项。');
          }
        }
        if (!payload.title) throw new Error('题目标题不能为空。');
        return payload;
      };
      previousType = current;
    }
    drawConfig(true);
    type.addEventListener('change', () => drawConfig());
    const actions = A.el('div', undefined, 'actions');
    fields.append(actions);
    const save = A.el('button', question ? '保存题目' : '保存新题目');
    save.type = 'submit';
    save.hidden = !isDraft();
    actions.append(save);
    if (isDraft() && question) {
      const up = button(actions, '上移', () => reorder(index, -1));
      up.disabled = index === 0;
      const down = button(actions, '下移', () => reorder(index, 1));
      down.disabled = index === survey.questions.length - 1;
      button(actions, '删除题目', () => {
        const count = survey.jumpRules.filter((rule) => rule.sourceQuestionId === question.id || rule.targetQuestionId === question.id).length;
        if (confirm(`删除此题目？会同时移除 ${count} 条关联规则。`)) {
          mutation(() => A.api(`${base}/questions/${question.id}`, { method: 'DELETE' }),
            `题目已删除，关联规则已移除（${count} 条）。`, key, true);
        }
      }, 'danger');
    } else if (isDraft()) {
      button(actions, '取消新题目', () => {
        if (!dirty.has(key) || confirm('放弃此新题目？')) {
          form.remove(); dirty.delete(key);
          document.getElementById('add-question').disabled = false;
        }
      });
    }
    mark(key, form);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      mutation(async () => {
        const payload = readConfig();
        if (question && (payload.type !== question.type || (payload.options && question.options.some(
          (option) => !payload.options.some((next) => next.id === option.id),
        ))) && !confirm('改变题型或删除选项会移除失效的关联跳转规则。确认保存吗？')) return false;
        return A.api(question ? `${base}/questions/${question.id}` : `${base}/questions`, {
          method: question ? 'PATCH' : 'POST', body: { question: payload },
        });
      }, (result) => result.removedRuleIds?.length
        ? `题目已保存，同时移除 ${result.removedRuleIds.length} 条失效跳转规则。` : '题目已保存。', key, true);
    });
    return form;
  }

  function reorder(index, delta) {
    const ids = survey.questions.map((question) => question.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    mutation(() => A.api(`${base}/questions/order`, { method: 'PUT', body: { questionIds: ids } }),
      '题目顺序已保存。', undefined, true);
  }

  function ruleForm(rule = {}) {
    const card = A.el('div', undefined, 'rule-card');
    const fields = A.el('fieldset');
    fields.disabled = !isDraft();
    card.append(fields);
    const sources = survey.questions.filter((question) => operators[question.type].length);
    const source = select(fields, '来源题目', sources.map((question) => [question.id, `第 ${question.order} 题：${question.title}`]),
      rule.sourceQuestionId);
    const dependencies = A.el('div', undefined, 'grid');
    fields.append(dependencies);
    let operator;
    let target;
    let readValue;
    function draw(initial = false) {
      dependencies.replaceChildren();
      const question = survey.questions.find((item) => item.id === source.value);
      if (!question) { readValue = () => { throw new Error('请选择有效的来源题目。'); }; return; }
      operator = select(dependencies, '运算符', operators[question.type].map((op) => [op, operatorLabels[op]]),
        initial ? rule.operator : undefined);
      const valuesBox = A.el('div');
      dependencies.append(valuesBox);
      function drawValue(useExisting = false) {
        valuesBox.replaceChildren();
        if (question.type === 'number') {
          const node = field(valuesBox, '判断值', input('number', useExisting ? rule.value ?? '' : ''));
          node.step = 'any';
          node.required = true;
          readValue = () => numberValue(node, '判断值');
        } else if (['contains_any', 'contains_all'].includes(operator.value)) {
          const choices = A.el('fieldset', undefined, 'choice-values');
          choices.append(A.el('legend', '判断值（至少勾选一项）'));
          valuesBox.append(choices);
          const controls = question.options.map((option) => ({
            id: option.id,
            node: check(choices, option.label, useExisting && Array.isArray(rule.value) && rule.value.includes(option.id)),
          }));
          readValue = () => {
            const selected = controls.filter((item) => item.node.checked).map((item) => item.id);
            if (!selected.length) throw new Error('包含任意一个 / 全部规则必须至少选择一项。');
            return selected;
          };
        } else {
          const node = select(valuesBox, '判断值', question.options.map((option) => [option.id, option.label]),
            useExisting ? rule.value : undefined);
          readValue = () => {
            if (!question.options.some((option) => option.id === node.value)) throw new Error('请选择合法判断值。');
            return node.value;
          };
        }
      }
      drawValue(initial);
      operator.addEventListener('change', () => drawValue());
      target = select(dependencies, '目标', [
        ...survey.questions.filter((item) => item.order > question.order).map((item) => [item.id, `第 ${item.order} 题：${item.title}`]),
        ['END', '结束问卷'],
      ], initial ? rule.targetQuestionId : 'END');
    }
    draw(true);
    source.addEventListener('change', () => draw());
    const priority = field(fields, '优先级（非负整数，越小越优先）', input('number', rule.priority ?? 0));
    priority.min = '0'; priority.step = '1'; priority.required = true;
    const reader = () => {
      const question = survey.questions.find((item) => item.id === source.value);
      if (!question || !operators[question.type].includes(operator?.value)) throw new Error('规则来源或运算符无效。');
      const number = numberValue(priority, '优先级', { integer: true });
      if (number < 0) throw new Error('优先级不能为负数。');
      if (target.value !== 'END' && !survey.questions.some((item) => item.id === target.value && item.order > question.order)) {
        throw new Error('规则目标必须是后续题目或结束。');
      }
      return { ...(rule.id ? { id: rule.id } : {}), sourceQuestionId: question.id,
        operator: operator.value, value: readValue(), targetQuestionId: target.value, priority: number };
    };
    ruleReaders.push(reader);
    if (isDraft()) button(fields, '移除此规则', () => {
      card.remove();
      ruleReaders = ruleReaders.filter((item) => item !== reader);
      dirty.add('rules');
      document.getElementById('add-rule').disabled = ruleReaders.length >= 500;
    }, 'danger');
    mark('rules', card);
    return card;
  }

  function renderRules() {
    const box = document.getElementById('rule-list');
    box.replaceChildren();
    ruleReaders = [];
    if (!survey.jumpRules.length) box.append(A.el('p', '如果未添加跳转规则，默认按题目顺序填写。', 'hint'));
    survey.jumpRules.forEach((rule) => box.append(ruleForm(rule)));
    document.getElementById('add-rule').hidden = !isDraft();
    document.getElementById('add-rule').disabled = survey.jumpRules.length >= 500
      || !survey.questions.some((question) => operators[question.type].length);
    document.getElementById('save-rules').hidden = !isDraft();
  }

  mark('settings', settings);
  settings.elements.allowAnonymous.addEventListener('change', participationHint);
  settings.elements.allowMultipleResponses.addEventListener('change', participationHint);
  settings.addEventListener('submit', (event) => {
    event.preventDefault();
    mutation(() => {
      const body = {
        title: settings.elements.title.value.trim(),
        description: settings.elements.description.value.trim(),
        deadline: settings.elements.deadline.value === A.toLocalDatetime(survey.deadline)
          ? survey.deadline || null : A.deadlineValue(settings.elements.deadline),
      };
      if (isDraft()) {
        body.allowAnonymous = settings.elements.allowAnonymous.checked;
        body.allowMultipleResponses = settings.elements.allowMultipleResponses.checked;
      }
      return A.api(base, { method: 'PATCH', body });
    }, '基础设置已保存。', 'settings');
  });
  document.getElementById('add-question').addEventListener('click', () => {
    if (!isDraft() || busy) return;
    const box = document.getElementById('question-list');
    if (box.querySelectorAll('form').length >= 100) return;
    const form = questionForm(null, survey.questions.length);
    box.append(form);
    dirty.add(`new:${newQuestionCount}`);
    document.getElementById('add-question').disabled = box.querySelectorAll('form').length >= 100;
    form.querySelector('input').focus();
  });
  document.getElementById('add-rule').addEventListener('click', () => {
    if (!isDraft() || busy || ruleReaders.length >= 500) return;
    document.getElementById('rule-list').append(ruleForm());
    dirty.add('rules');
    document.getElementById('add-rule').disabled = ruleReaders.length >= 500;
  });
  document.getElementById('save-rules').addEventListener('click', () => mutation(() => {
    const rules = ruleReaders.map((read) => read());
    const priorities = new Set();
    for (const rule of rules) {
      const key = `${rule.sourceQuestionId}:${rule.priority}`;
      if (priorities.has(key)) throw new Error('同一来源题目的规则优先级不能重复。');
      priorities.add(key);
    }
    return A.api(`${base}/jump-rules`, { method: 'PUT', body: { rules } });
  }, '全部规则已保存。', 'rules', true));
  document.getElementById('publish').addEventListener('click', () => {
    mutation(() => A.api(`${base}/publish`, { method: 'POST' }),
      '问卷已发布，填写链接已显示。', undefined, true, {
        message: '发布后题目、规则和参与设置将锁定。确定发布已保存的问卷吗？',
        title: '确认发布问卷', confirmLabel: '确认发布',
      });
  });
  document.getElementById('close').addEventListener('click', () => {
    mutation(() => A.api(`${base}/close`, { method: 'POST' }),
      '问卷已关闭。', undefined, false, {
        message: '关闭后不能重新打开，也不能继续填写。确定关闭吗？',
        title: '确认关闭问卷', confirmLabel: '确认关闭', danger: true,
      });
  });
  document.getElementById('reload').addEventListener('click', () => {
    if (busy) return;
    busy = true;
    A.run(message, async () => {
      try { if (await allowDiscard() === true) await load(); }
      finally { busy = false; }
    });
  });
  document.getElementById('delete-survey').addEventListener('click', () => {
    if (busy) return;
    busy = true;
    A.run(message, async () => {
      try {
        const approved = await A.confirmDeletion('删除问卷及全部回答？建议先关闭并确认无人填写；删除不可恢复。');
        if (approved !== true) return;
        content.inert = true;
        await A.api(base, { method: 'DELETE' });
        location.assign('/surveys');
      }
      finally { busy = false; content.inert = false; }
    });
  });
  window.addEventListener('beforeunload', (event) => {
    if (dirty.size && !busy) { event.preventDefault(); event.returnValue = ''; }
  });
  A.run(message, async () => {
    if (!validId) throw new Error('缺少有效问卷 ID。请从我的问卷进入编辑页。');
    if (await A.initHeader({ requireAuth: true })) await load();
  });
})();
