(function () {
  'use strict';
  const A = window.SurveyApp;
  const $ = (id) => document.getElementById(id);
  const content = $('notification-content');
  const message = $('page-message');
  const types = { single: '单选题', multiple: '多选题', text: '文本填空题', number: '数字填空题' };
  let page = 1;
  let totalPages = 0;
  let busy = false;
  async function action(work, saving = false) {
    if (busy) return;
    busy = true;
    content.inert = true;
    await A.run(message, async () => {
      try { return await work(); }
      finally { busy = false; content.inert = false; }
    }, undefined, { saving });
  }
  function limits(question) {
    const v = question.validation;
    const notes = [];
    const labels = { minSelections: '最少选择数', maxSelections: '最多选择数', exactSelections: '精确选择数',
      minLength: '最短字符数', maxLength: '最长字符数', min: '最小值', max: '最大值' };
    for (const [key, label] of Object.entries(labels)) if (v[key] !== undefined) notes.push(`${label}：${v[key]}`);
    if (v.integer) notes.push('只允许整数');
    return notes.length ? notes.join('；') : '使用默认填写限制';
  }
  async function load() {
    let data = await A.api(`/api/notifications?page=${page}&pageSize=5`);
    if (!data.items.length && page > 1) {
      page = Math.max(1, data.totalPages);
      data = await A.api(`/api/notifications?page=${page}&pageSize=5`);
    }
    totalPages = data.totalPages;
    const list = $('notification-list');
    list.replaceChildren();
    if (!data.items.length) list.append(A.el('p', '暂无收到的题目。', 'hint'));
    for (const item of data.items) {
      const card = A.el('article', undefined, 'question-card');
      card.append(A.el('h3', item.question.title), A.el('p', `来自：${item.senderUsername} · ${A.dateLabel(item.createdAt)}`),
        A.el('p', `${types[item.question.type]} · ${item.question.required ? '必答' : '选答'}`));
      if (item.question.options.length) card.append(A.el('p', item.question.options.map((option) => option.label).join(' / '), 'preserve-text'));
      card.append(A.el('p', limits(item.question), 'hint'));
      const buttons = A.el('div', undefined, 'actions');
      if (item.status === 'accepted') buttons.append(A.el('span', '已加入个人题库', 'badge'));
      else {
        const accept = A.el('button', item.canAccept ? '加入个人题库' : '正在加入，请稍后刷新');
        accept.type = 'button';
        accept.disabled = !item.canAccept;
        accept.addEventListener('click', () => action(async () => {
          await A.api(`/api/notifications/${item.id}/accept`, { method: 'POST' });
          await load();
        }, true));
        buttons.append(accept);
      }
      const remove = A.el('button', '删除通知', 'danger');
      remove.type = 'button';
      remove.disabled = item.status === 'accepting';
      remove.addEventListener('click', () => action(async () => {
        if (await A.confirmAction('删除这条题目通知？分享者的原题及已加入题库的题目不受影响。', {
          title: '删除通知', confirmLabel: '确认删除', danger: true,
        }) !== true) return false;
        await A.api(`/api/notifications/${item.id}`, { method: 'DELETE' });
        await load();
        A.showMessage(message, '通知已删除。');
      }));
      buttons.append(remove);
      card.append(buttons);
      list.append(card);
    }
    $('notification-summary').textContent = `第 ${page} 页，共 ${data.total} 条通知`;
    $('previous-notifications').disabled = page <= 1;
    $('next-notifications').disabled = page >= totalPages;
    await A.refreshNotificationCount();
  }
  $('refresh-notifications').addEventListener('click', () => action(load));
  $('previous-notifications').addEventListener('click', () => action(async () => { if (page > 1) { page--; await load(); } }));
  $('next-notifications').addEventListener('click', () => action(async () => { if (page < totalPages) { page++; await load(); } }));
  A.run(message, async () => {
    if (await A.initHeader({ requireAuth: true })) { await load(); content.hidden = false; }
  });
})();
