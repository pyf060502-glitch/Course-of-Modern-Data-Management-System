(function () {
  'use strict';
  const A = window.SurveyApp;
  const typeLabels = { single: '单选题', multiple: '多选题', text: '文本填空题', number: '数字填空题' };
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
  window.SurveyQuestionFields = function (fields, question, onDirty = () => {}) {
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
          onDirty();
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
            onDirty();
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
    return { read: () => readConfig() };
  };
})();
