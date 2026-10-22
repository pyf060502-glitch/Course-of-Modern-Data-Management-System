(function () {
  'use strict';
  const A = window.SurveyApp;
  const message = document.getElementById('page-message');
  const form = document.getElementById('create-form');
  let page = 1;
  const pageSize = 20;
  let loading = false;
  let deleting = false;
  let hasNext = false;
  let authenticated = false;

  function hint() {
    document.getElementById('participation-hint').textContent = A.participationHint(
      form.elements.allowAnonymous.checked, form.elements.allowMultipleResponses.checked,
    );
  }

  // Keep list response adaptation here, separate from page rendering.
  function unpackList(data) {
    const items = Array.isArray(data) ? data : data.surveys || data.items;
    if (!Array.isArray(items)) throw new Error('问卷列表响应缺少 surveys 数组。');
    return { items, total: data.total ?? data.pagination?.total, pages: data.totalPages ?? data.pagination?.totalPages };
  }

  async function load() {
    if (loading || !authenticated) return;
    loading = true;
    document.getElementById('refresh').disabled = true;
    document.getElementById('previous').disabled = true;
    document.getElementById('next').disabled = true;
    try {
      const { items, total, pages } = unpackList(await A.api(`/api/surveys/mine?page=${page}&pageSize=${pageSize}`));
      const list = document.getElementById('survey-list');
      list.replaceChildren();
      for (const survey of items) {
        const id = A.idOf(survey);
        if (typeof id !== 'string' || !/^[a-fA-F0-9]{24}$/.test(id)) throw new Error('问卷返回了无效 ID。');
        const row = A.el('tr');
        row.append(A.el('td', survey.title, 'title'));
        const status = A.el('td');
        status.append(A.el('span', A.statusLabel(survey), 'badge'), A.el('p', A.dateLabel(survey.deadline), 'hint'));
        row.append(status);
        const actions = A.el('td');
        const links = A.el('div', undefined, 'actions');
        links.append(A.link('编辑 / 查看', `/surveys/${id}/edit`), A.link('统计', `/surveys/${id}/statistics`));
        if (survey.status !== 'draft') links.append(A.link('填写链接', `/survey/${id}`));
        const remove = A.el('button', '删除', 'danger');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          if (loading || deleting) return;
          deleting = true;
          A.run(message, async () => {
            try {
              const approved = await A.confirmDeletion(`删除“${survey.title}”？关联回答也会删除。建议先关闭问卷并确认无人填写；删除不可恢复。`);
              if (approved !== true) return;
              await A.api(`/api/surveys/${id}`, { method: 'DELETE' });
              await load();
              A.showMessage(message, '问卷已删除。');
            } finally {
              deleting = false;
            }
          }, remove);
        });
        links.append(remove);
        actions.append(links);
        row.append(actions);
        list.append(row);
      }
      document.getElementById('list-summary').textContent = items.length
        ? total === undefined ? '每页最多 20 份问卷。' : `共 ${total} 份问卷。`
        : '当前页暂无问卷。可以创建问卷，或返回上一页。';
      hasNext = pages !== undefined ? page < pages : total !== undefined ? page * pageSize < total : items.length === pageSize;
      document.getElementById('page-number').textContent = `第 ${page} 页`;
    } finally {
      loading = false;
      document.getElementById('refresh').disabled = false;
      document.getElementById('previous').disabled = page <= 1;
      document.getElementById('next').disabled = !hasNext;
    }
  }
  form.elements.allowAnonymous.addEventListener('change', hint);
  form.elements.allowMultipleResponses.addEventListener('change', hint);
  hint();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    A.run(message, async () => {
      const data = await A.api('/api/surveys', { method: 'POST', body: {
        title: form.elements.title.value.trim(),
        description: form.elements.description.value.trim(),
        deadline: A.deadlineValue(form.elements.deadline),
        allowAnonymous: form.elements.allowAnonymous.checked,
        allowMultipleResponses: form.elements.allowMultipleResponses.checked,
      } });
      const id = A.idOf(data.survey || data);
      if (typeof id !== 'string' || !/^[a-fA-F0-9]{24}$/.test(id)) throw new Error('问卷已创建，但响应缺少有效 ID，请刷新列表。');
      location.assign(`/surveys/${id}/edit`);
    }, form.querySelector('button[type="submit"]'));
  });
  document.getElementById('refresh').addEventListener('click', () => A.run(message, load));
  document.getElementById('previous').addEventListener('click', () => {
    if (!loading && page > 1) { page -= 1; A.run(message, load); }
  });
  document.getElementById('next').addEventListener('click', () => {
    if (!loading && hasNext) { page += 1; A.run(message, load); }
  });
  A.run(message, async () => {
    authenticated = Boolean(await A.initHeader({ requireAuth: true }));
    if (!authenticated) return;
    document.getElementById('create-fields').disabled = false;
    await load();
  });
})();
