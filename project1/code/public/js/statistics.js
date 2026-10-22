(function () {
  'use strict';
  const app = window.SurveyApp;
  const api = (...args) => app.api(...args);
  const $ = (id) => document.getElementById(id);
  const route = location.pathname.match(/^\/surveys\/([a-fA-F0-9]{24})\/statistics\/?$/);
  const surveyId = route?.[1];
  const root = $('question-statistics');
  const refresh = $('refresh-statistics');
  let generation = 0;
  let loading = false;
  const types = { single: '单选', multiple: '多选', text: '文本', number: '数字' };

  function message(node, text = '', error = true) {
    node.textContent = text;
    node.hidden = !text;
    node.className = error ? 'message error' : 'message';
    node.setAttribute('role', error ? 'alert' : 'status');
    if (text && error) node.focus();
  }

  function fail(error, node = $('page-message')) {
    if (error.status === 401 || error.status === 404) {
      // An expired session or lost ownership must not leave private statistics visible.
      generation += 1;
      root.replaceChildren();
      $('statistics-summary').replaceChildren();
      $('statistics-summary').hidden = true;
      $('edit-survey').hidden = true;
      node = $('page-message');
    }
    message(node, app ? app.errorMessage(error) : error.message);
    if (error.status === 401 && app) location.replace(app.loginUrl());
  }

  function metric(label, value) {
    return app.el('p', `${label}：${value ?? '无数据'}`);
  }

  function table(headers, rows) {
    const wrap = app.el('div', undefined, 'table-wrap');
    const node = app.el('table');
    const head = app.el('thead');
    const heading = app.el('tr');
    for (const title of headers) {
      const cell = app.el('th', title);
      cell.scope = 'col';
      heading.append(cell);
    }
    head.append(heading);
    const body = app.el('tbody');
    for (const row of rows) {
      const tr = app.el('tr');
      for (const value of row) tr.append(app.el('td', value, 'preserve-text'));
      body.append(tr);
    }
    node.append(head, body);
    wrap.append(node);
    return wrap;
  }

  function renderCounts(node, question) {
    node.replaceChildren(
      metric('访问次数', question.visitedCount),
      metric('有效非空回答数', question.answeredCount),
    );
  }

  function renderNumeric(node, numeric) {
    if (!numeric) return;
    node.replaceChildren(
      metric('有效数字数', numeric.count),
      metric('平均值', numeric.average),
      metric('最小值', numeric.min),
      metric('最大值', numeric.max),
    );
    if (numeric.count === 0) node.append(app.el('p', '暂无有效数字回答。', 'hint'));
  }

  function renderContents(card, question, counts, numeric, epoch) {
    const output = app.el('div');
    const errorNode = app.el('div');
    errorNode.hidden = true;
    errorNode.tabIndex = -1;
    const controls = app.el('div', undefined, 'actions');
    const previous = app.el('button', '上一页', 'secondary');
    const next = app.el('button', '下一页', 'secondary');
    const retry = app.el('button', '重新加载', 'secondary');
    const pageLabel = app.el('span');
    for (const button of [previous, next, retry]) button.type = 'button';
    controls.append(previous, next, retry, pageLabel);
    card.append(app.el('h3', '填写内容'), errorNode, output, controls);
    let page = 1;
    let totalPages = 0;
    let pending = false;

    async function loadPage(target) {
      if (pending || epoch !== generation) return;
      pending = true;
      previous.disabled = next.disabled = retry.disabled = true;
      message(errorNode);
      try {
        const data = await api(`/api/surveys/${surveyId}/statistics/questions/${question.questionId}?page=${target}&pageSize=20`);
        if (epoch !== generation || !card.isConnected) return;
        const contents = data.contents;
        if (!contents || !Array.isArray(contents.items)) {
          throw new Error('统计接口未返回有效的内容分页。');
        }
        page = contents.page;
        totalPages = contents.totalPages;
        renderCounts(counts, data);
        if (numeric) renderNumeric(numeric, data.numeric);
        output.replaceChildren();
        if (!contents.items.length) output.append(app.el('p', '本页暂无填写内容。', 'hint'));
        else output.append(table(['内容', '提交时间'], contents.items.map((item) => [
          item.value, app.dateLabel(item.submittedAt),
        ])));
        pageLabel.textContent = `第 ${page} 页 / 共 ${totalPages} 页；共 ${contents.totalItems} 条，每页 ${contents.pageSize} 条`;
      } catch (error) {
        if (epoch !== generation) return;
        fail(error, errorNode);
      } finally {
        pending = false;
        previous.disabled = page <= 1;
        next.disabled = page >= totalPages;
        retry.disabled = false;
      }
    }
    previous.addEventListener('click', () => loadPage(page - 1));
    next.addEventListener('click', () => loadPage(page + 1));
    retry.addEventListener('click', () => loadPage(page));
    return () => loadPage(1);
  }

  function renderQuestion(question, index, epoch) {
    const card = app.el('section', undefined, 'panel');
    card.append(app.el('h2', `${index + 1}. ${question.title}`, 'preserve-text'));
    card.append(app.el('p', `题型：${types[question.type] ?? question.type}`, 'hint'));
    const counts = app.el('div', undefined, 'grid');
    renderCounts(counts, question);
    card.append(counts);
    let startContents;
    if (question.type === 'single' || question.type === 'multiple') {
      card.append(app.el('p', '比例以本题有效非空回答数为分母；无人回答时为 0%。多选各项比例合计可能超过 100%。', 'hint'));
      card.append(table(['选项', '选择次数', '比例'], question.options.map((option) => [
        option.label, option.count, `${(option.ratio * 100).toFixed(2)}%`,
      ])));
    } else {
      let numeric;
      if (question.type === 'number') {
        numeric = app.el('div', undefined, 'grid');
        renderNumeric(numeric, question.numeric);
        card.append(numeric);
      }
      startContents = renderContents(card, question, counts, numeric, epoch);
    }
    root.append(card);
    return startContents;
  }

  async function load() {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    const epoch = ++generation;
    message($('page-message'), '正在加载统计……', false);
    root.replaceChildren();
    $('statistics-summary').hidden = true;
    try {
      const data = await api(`/api/surveys/${surveyId}/statistics`);
      if (epoch !== generation) return;
      const summary = $('statistics-summary');
      summary.replaceChildren(
        app.el('h2', '问卷摘要'),
        metric('总提交次数', data.totalResponses),
        metric('去重登录填写人数', data.uniqueRegisteredRespondents),
        metric('匿名提交次数', data.anonymousResponses),
        app.el('p', '重复填写会重复计入提交次数；匿名提交次数不代表可确定的匿名人数。访问次数包含可选留空，有效回答数只计非空答案。', 'hint'),
      );
      summary.hidden = false;
      message($('page-message'));
      if (data.totalResponses === 0) message($('page-message'), '暂无提交记录，以下为零回答统计。', false);
      if (!data.questions.length) root.append(app.el('p', '问卷尚无题目。', 'notice'));
      const pages = data.questions.map((question, index) => renderQuestion(question, index, epoch));
      // Fetch bounded pages sequentially, not all content or hundreds of requests at once.
      for (const startPage of pages) {
        if (epoch !== generation) break;
        if (startPage) await startPage();
      }
    } catch (error) { if (epoch === generation) fail(error); }
    finally {
      loading = false;
      refresh.disabled = false;
    }
  }

  refresh.addEventListener('click', load);
  async function start() {
    try {
      if (!app) throw new Error('公共前端工具未加载，请刷新后重试。');
      if (!surveyId) throw new Error('统计地址无效。');
      const user = await app.initHeader({ requireAuth: true });
      if (!user) return;
      $('edit-survey').href = `/surveys/${surveyId}/edit`;
      await load();
      if (!$('statistics-summary').hidden) $('edit-survey').hidden = false;
    } catch (error) { fail(error); }
  }
  start();
})();
