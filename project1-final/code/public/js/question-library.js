(function () {
  'use strict';
  const A = window.SurveyApp;
  const $ = (id) => document.getElementById(id);
  const message = $('page-message');
  const content = $('library-content');
  const types = { single: '单选题', multiple: '多选题', text: '文本填空题', number: '数字填空题' };
  const pageSize = 5;
  let page = 1;
  let totalPages = 0;
  let editingId = null;
  let branchBase = null;
  let fields;
  let dirty = false;
  let busy = false;

  async function discard() {
    return !dirty || await A.confirmAction('放弃当前未保存的题目修改？', {
      title: '确认放弃修改', confirmLabel: '放弃修改',
    }) === true;
  }
  function edit(record) {
    branchBase = null;
    editingId = record?.id ?? null;
    $('library-fields').replaceChildren();
    fields = window.SurveyQuestionFields($('library-fields'), record?.question, () => { dirty = true; });
    $('form-heading').textContent = editingId ? '编辑常用题目' : '创建常用题目';
    dirty = false;
  }
  function branch(record, version = record) {
    edit({ ...record, question: version.question });
    editingId = null;
    branchBase = { id: record.id, versionId: version.versionId };
    $('form-heading').textContent = `创建新版本（基于 v${version.version}）`;
    dirty = true;
    $('library-fields').querySelector('input')?.focus();
  }
  async function action(work, { saving = false } = {}) {
    if (busy) return;
    busy = true;
    content.inert = true;
    content.setAttribute('aria-busy', 'true');
    await A.run(message, async () => {
      try { return await work(); }
      finally { busy = false; content.inert = false; content.removeAttribute('aria-busy'); }
    }, undefined, { saving });
  }
  async function load() {
    let data = await A.api(`/api/question-library?page=${page}&pageSize=${pageSize}`);
    if (!data.items.length && page > 1) {
      page = Math.max(1, data.totalPages);
      data = await A.api(`/api/question-library?page=${page}&pageSize=${pageSize}`);
    }
    totalPages = data.totalPages;
    const list = $('library-list');
    list.replaceChildren();
    if (!data.items.length) list.append(A.el('p', '暂无常用题目，请在上方创建，或从问卷编辑页保存题目。', 'hint'));
    for (const record of data.items) {
      const card = A.el('article', undefined, 'question-card');
      card.append(A.el('h3', record.question.title), A.el('p', `${types[record.question.type]} · ${record.question.required ? '必答' : '选答'} · v${record.version ?? 1}`));
      if (record.question.options.length) card.append(A.el('p', record.question.options.map((option) => option.label).join(' / ')));
      const buttons = A.el('div', undefined, 'actions');
      const change = A.el('button', '编辑', 'secondary');
      change.type = 'button';
      change.addEventListener('click', () => action(async () => {
        if (await discard()) {
          const current = await A.api(`/api/question-library/${record.id}`);
          edit(current);
          $('library-fields').querySelector('input')?.focus();
        }
      }));
      const remove = A.el('button', '删除', 'danger');
      remove.type = 'button';
      remove.addEventListener('click', () => action(async () => {
        if (await A.confirmDeletion(`删除常用题目“${record.question.title}”？已选入问卷的题目不受影响。`) !== true) return;
        if (editingId === record.id && !await discard()) return;
        await A.api(`/api/question-library/${record.id}`, { method: 'DELETE' });
        if (editingId === record.id) edit();
        await load();
        A.showMessage(message, '常用题目已删除，已有问卷保持原样。');
      }));
      buttons.append(change, remove);
      const newVersion = A.el('button', '创建新版本', 'secondary');
      newVersion.type = 'button';
      newVersion.addEventListener('click', () => action(async () => {
        if (await discard()) branch(await A.api(`/api/question-library/${record.id}`));
      }));
      buttons.append(newVersion);
      const share = A.el('button', '分享题目', 'secondary');
      share.type = 'button';
      share.addEventListener('click', () => action(() => A.shareQuestion(message,
        `/api/question-library/${record.id}/share`, record.question.title)));
      buttons.append(share);
      const history = A.el('button', '历史版本', 'secondary');
      history.type = 'button';
      history.addEventListener('click', () => action(async () => {
        const result = await A.showQuestionHistory(message, `/api/question-library/${record.id}/history`, record.question.title, dirty, { allowBranch: true });
        if (result && typeof result === 'object') {
          if (await discard()) branch(record, result);
        } else if (result === true) {
          edit();
          await load();
          A.showMessage(message, '保存成功');
        }
      }));
      buttons.append(history);
      const usages = A.el('button', '查找对应问卷', 'secondary');
      usages.type = 'button';
      const usageBox = A.el('section');
      usageBox.hidden = true;
      usageBox.setAttribute('aria-label', '对应问卷');
      let usagePage = 1;
      async function loadUsages() {
        usageBox.hidden = false;
        usageBox.replaceChildren(A.el('p', '正在查找…', 'hint'));
        try {
          const data = await A.api(`/api/question-library/${record.id}/usages?page=${usagePage}&pageSize=5`);
          usageBox.replaceChildren(A.el('h4', '使用本题及关联版本的问卷'),
            A.el('p', '仅显示本人的问卷。各问卷使用的内容独立；需要保留原题时，可点击“创建新版本”后修改。', 'hint'));
          if (!data.items.length) usageBox.append(A.el('p', '暂无对应问卷。', 'hint'));
          for (const survey of data.items) {
            const entry = A.el('article', undefined, 'question-card');
            entry.append(A.link(survey.title, `/surveys/${survey.id}/edit`),
              A.el('p', A.statusLabel({ status: survey.effectiveStatus }), 'hint'));
            for (const q of survey.questions) entry.append(A.el('p', `第 ${q.order} 题：${q.title} · v${q.version}`));
            usageBox.append(entry);
          }
          const controls = A.el('div', undefined, 'actions');
          const previous = A.el('button', '上一页', 'secondary');
          const next = A.el('button', '下一页', 'secondary');
          const hide = A.el('button', '收起', 'secondary');
          previous.type = next.type = hide.type = 'button';
          previous.disabled = usagePage <= 1;
          next.disabled = usagePage >= data.totalPages;
          previous.addEventListener('click', () => action(async () => { usagePage--; await loadUsages(); }));
          next.addEventListener('click', () => action(async () => { usagePage++; await loadUsages(); }));
          hide.addEventListener('click', () => { usageBox.hidden = true; });
          controls.append(previous, A.el('span', `第 ${usagePage} 页，共 ${data.total} 份问卷`), next, hide);
          usageBox.append(controls);
        } catch (error) {
          usageBox.replaceChildren(A.el('p', '查找失败，请点击“查找对应问卷”重试。', 'hint'));
          throw error;
        }
      }
      usages.addEventListener('click', () => action(async () => { usagePage = 1; await loadUsages(); }));
      buttons.append(usages);
      const statistics = A.el('button', '跨问卷统计结果', 'secondary');
      statistics.type = 'button';
      const statisticsBox = A.el('section');
      statisticsBox.hidden = true;
      statisticsBox.setAttribute('aria-label', '跨问卷统计');
      statistics.addEventListener('click', () => action(() => window.renderLibraryStatistics(statisticsBox, record.id, action)));
      buttons.append(statistics);
      card.append(buttons);
      card.append(usageBox);
      card.append(statisticsBox);
      list.append(card);
    }
    $('library-summary').textContent = `第 ${page} 页，共 ${data.total} 题`;
    $('previous-library-page').disabled = page <= 1;
    $('next-library-page').disabled = page >= totalPages;
  }
  $('library-form').addEventListener('input', () => { dirty = true; });
  $('library-form').addEventListener('invalid', () => A.showMessage(message, '保存失败，请再试一次', true), true);
  $('library-form').addEventListener('change', () => { dirty = true; });
  $('library-form').addEventListener('submit', (event) => {
    event.preventDefault();
    action(async () => {
      const question = fields.read();
      await A.api(branchBase ? `/api/question-library/${branchBase.id}/versions`
        : editingId ? `/api/question-library/${editingId}` : '/api/question-library', {
        method: editingId ? 'PATCH' : 'POST', body: branchBase ? { question, versionId: branchBase.versionId } : { question },
      });
      edit();
      page = 1;
      await load();
    }, { saving: true });
  });
  $('cancel-library-edit').addEventListener('click', () => action(async () => { if (await discard()) edit(); }));
  $('refresh-library').addEventListener('click', () => action(load));
  $('previous-library-page').addEventListener('click', () => action(async () => { if (page > 1) { page--; await load(); } }));
  $('next-library-page').addEventListener('click', () => action(async () => { if (page < totalPages) { page++; await load(); } }));
  window.addEventListener('beforeunload', (event) => {
    if (dirty) { event.preventDefault(); event.returnValue = ''; }
  });
  A.run(message, async () => {
    if (await A.initHeader({ requireAuth: true })) {
      edit();
      await load();
      content.hidden = false;
    }
  });
})();
