(function () {
  'use strict';
  window.renderLibraryStatistics = async function (box, id, action, group, page = 1) {
    const A = window.SurveyApp;
    box.hidden = false;
    box.replaceChildren(A.el('p', '正在加载跨问卷统计…', 'hint'));
    try {
      const data = await A.api(`/api/question-library/${id}/statistics?page=${page}&pageSize=20${group ? `&group=${encodeURIComponent(group)}` : ''}`);
      box.replaceChildren(A.el('h4', '跨问卷统计结果'), A.el('p',
        '仅统计本人关联问卷。同一提交中本题出现多次时分别计次；同一用户多次回答保留，登录人数跨问卷去重。题型或选项标签及顺序不同的版本分组展示，避免混合含义不同的答案。', 'hint'));
      const metric = (name, value) => A.el('p', `${name}：${value ?? '无数据'}`);
      box.append(metric('使用问卷数', data.surveyCount), metric('题目出现次数', data.questionCount),
        metric('总提交次数', data.totalResponses), metric('去重登录填写人数', data.uniqueRegisteredRespondents),
        metric('匿名提交次数', data.anonymousResponses), metric('总访问次数', data.visitedCount), metric('总有效非空回答数', data.answeredCount));
      const types = { single: '单选题', multiple: '多选题', number: '数字题', text: '文本题' };
      if (!data.groups.length) box.append(A.el('p', '暂无对应问卷或回答。', 'hint'));
      else {
        const label = A.el('label', undefined, 'field');
        label.append(A.el('span', '统计分组'));
        const select = A.el('select');
        for (const [n, g] of data.groups.entries()) {
          const option = A.el('option', `分组 ${n + 1}：${types[g.type]}${g.options ? `（${g.options.map((o) => o.label).join(' / ')}）` : ''}`);
          option.value = g.id;
          select.append(option);
        }
        select.value = data.selectedGroup;
        select.addEventListener('change', () => action(() => window.renderLibraryStatistics(box, id, action, select.value)));
        label.append(select); box.append(label);
        const g = data.groups.find((g) => g.id === data.selectedGroup);
        box.append(metric('本组问卷数', g.surveyCount), metric('本组题目出现次数', g.questionCount),
          metric('访问次数', g.visitedCount), metric('有效非空回答数', g.answeredCount));
        if (g.options) {
          box.append(A.el('p', '比例以本组有效非空回答数为分母；无人回答时为0%。多选各项比例之和可能超过100%。', 'hint'));
          for (const o of g.options) box.append(A.el('p', `${o.label}：${o.count} 次 · ${(o.ratio * 100).toFixed(2)}%`));
        }
        if (g.numeric) box.append(metric('有效数字数', g.numeric.count), metric('平均值', g.numeric.average), metric('最小值', g.numeric.min), metric('最大值', g.numeric.max));
        if (g.contents) {
          box.append(A.el('h4', '填写内容'));
          if (!g.contents.items.length) box.append(A.el('p', '本页暂无填写内容。', 'hint'));
          for (const item of g.contents.items) box.append(A.el('p', `${item.value} · ${A.dateLabel(item.submittedAt)} · ${item.surveyTitle}`, 'preserve-text'));
          const controls = A.el('div', undefined, 'actions');
          for (const [name, target, disabled] of [['上一页', page - 1, page <= 1], ['下一页', page + 1, page >= g.contents.totalPages]]) {
            const button = A.el('button', name, 'secondary'); button.type = 'button'; button.disabled = disabled;
            button.addEventListener('click', () => action(() => window.renderLibraryStatistics(box, id, action, data.selectedGroup, target)));
            controls.append(button);
          }
          controls.append(A.el('span', `第 ${page} 页，共 ${g.contents.totalItems} 条，每页20条`)); box.append(controls);
        }
      }
      const close = A.el('button', '收起统计', 'secondary'); close.type = 'button';
      close.addEventListener('click', () => { box.hidden = true; }); box.append(close);
    } catch (error) {
      box.replaceChildren(A.el('p', '统计加载失败，请点击“跨问卷统计结果”重试。', 'hint'));
      throw error;
    }
  };
})();
