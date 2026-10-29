// Optional real-browser check. Uses its own guarded test database, never a business DB.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTestDatabase } from '../tests/helpers/database.js';
import { startServer } from '../src/server.js';
import { createQuestionLibraryService } from '../src/services/question-library.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.argv[2] || process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const executablePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const f = await createTestDatabase();
let runtime;
let browser;
let page;
const artifactDirectory = process.argv[3] ? resolve(process.argv[3]) : null;
async function screenshot(target, name) {
  if (!artifactDirectory) return;
  await mkdir(artifactDirectory, { recursive: true });
  await target.screenshot({ path: resolve(artifactDirectory, name), fullPage: true });
}
try {
  runtime = await startServer(f.config);
  const base = `http://127.0.0.1:${runtime.server.address().port}`;
  browser = await chromium.launch({ executablePath, headless: true });
  page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const username = `browser_${randomUUID().slice(0, 8)}`;
  const password = randomUUID();
  await page.goto(`${base}/register`);
  await page.locator('[name=username]').fill(username);
  await page.locator('[name=password]').fill(password);
  await page.locator('[name=confirmPassword]').fill(password);
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.waitForURL('**/login?*');
  await page.locator('[name=username]').fill(username);
  await page.locator('[name=password]').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/surveys');
  await page.getByRole('link', { name: '常用题库', exact: true }).click();
  await page.locator('#library-content').waitFor({ state: 'visible' });
  // Create each type through the shared interactive form.
  for (const type of ['number', 'single', 'multiple', 'text']) {
    await page.locator('#library-fields').getByLabel('题目标题').fill(`常用${type}`);
    await page.locator('#library-fields select').selectOption(type);
    if (['single', 'multiple'].includes(type)) {
      await page.getByLabel('选项标签', { exact: true }).nth(0).fill('甲');
      await page.getByLabel('选项标签', { exact: true }).nth(1).fill('乙');
    }
    if (type === 'number') {
      await page.getByLabel('最小值（可留空）', { exact: true }).fill('0');
      await page.getByLabel('最大值（可留空）', { exact: true }).fill('120');
      await page.getByLabel('只允许整数', { exact: true }).check();
    }
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/question-library') && response.request().method() === 'POST');
    await page.locator('#save-library-question').click();
    assert.equal((await saved).status(), 201);
    await page.locator('#library-form').getByLabel('题目标题', { exact: true }).waitFor();
    await page.waitForFunction(() => !document.getElementById('library-content').inert);
    assert.equal(await page.locator('#page-message').textContent(), '保存成功');
  }
  assert.equal(await page.locator('#library-list article').count(), 4);
  // Edit the source via the actual form, including preservation of option IDs.
  const singleCard = page.locator('#library-list article').filter({ has: page.getByRole('heading', { name: '常用single', exact: true }) });
  await singleCard.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('heading', { name: '编辑常用题目', exact: true }).waitFor();
  await page.getByLabel('选项标签', { exact: true }).nth(0).fill('修改甲');
  await page.locator('#save-library-question').click();
  await page.getByRole('heading', { name: '创建常用题目', exact: true }).waitFor();
  await page.waitForFunction(() => !document.getElementById('library-content').inert);
  assert.equal(await page.locator('#page-message').textContent(), '保存成功');
  await page.getByRole('link', { name: '我的问卷', exact: true }).click();
  async function createSurvey(title) {
    await page.locator('#create-fields [name=title]').fill(title);
    await page.getByRole('button', { name: '创建并编辑', exact: true }).click();
    await page.waitForURL('**/surveys/*/edit');
    await page.locator('#editor-content').waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.getElementById('library-picker').disabled);
    return page.url();
  }
  const a = await createSurvey('复用问卷A');
  async function importNumber() {
    assert.equal(await page.locator('#load-library').textContent(), '刷新题目');
    await page.waitForFunction(() => document.querySelectorAll('#library-options [role=option]').length === 4);
    await page.locator('#library-selection').click();
    await page.getByRole('option', { name: '数字填空题：常用number', exact: true }).click();
    await page.locator('#import-library-question').click();
    await page.locator('#question-list').getByLabel('题目标题').waitFor();
    await page.waitForFunction(() => !document.getElementById('editor-content').inert);
    assert.equal(await page.locator('#page-message').textContent(), '保存成功');
  }
  await importNumber();
  assert.equal(await page.getByLabel('最大值（可留空）', { exact: true }).inputValue(), '120');
  const aId = a.match(/surveys\/([^/]+)/)[1];
  await page.getByRole('link', { name: '我的问卷', exact: true }).click();
  const b = await createSurvey('复用问卷B');
  await importNumber();
  await page.locator('#question-list').getByLabel('题目标题').fill('本卷年龄');
  await page.getByRole('button', { name: '保存题目', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('editor-content').inert);
  assert.equal(await page.locator('#page-message').textContent(), '保存成功');
  const bId = b.match(/surveys\/([^/]+)/)[1];
  const surveys = await f.db.collection('surveys').find({}).toArray();
  const qa = surveys.find((s) => String(s._id) === aId).questions[0];
  const qb = surveys.find((s) => String(s._id) === bId).questions[0];
  assert.equal(qa.title, '常用number');
  assert.equal(qb.title, '本卷年龄');
  assert.notEqual(qa.id, qb.id);
  // Saving an existing question must keep unsaved changes visible and untouched.
  await page.locator('#question-list').getByLabel('题目标题').fill('尚未保存');
  const saveToLibrary = page.getByRole('button', { name: '将上述题目保存到常用题库', exact: true });
  const previousRow = await page.locator('#question-list form fieldset > .actions').boundingBox();
  const libraryRow = await page.locator('#question-list .library-save-actions').boundingBox();
  assert.ok(Math.abs(libraryRow.y - previousRow.y - previousRow.height - 10) < 1);
  const failureRoute = '**/api/surveys/*/questions/*/save-to-library';
  await page.route(failureRoute, (route) => route.fulfill({ status: 503,
    contentType: 'application/json', body: JSON.stringify({ error: { message: 'Unavailable' } }) }));
  await saveToLibrary.click();
  await page.getByText('保存失败，请再试一次', { exact: true }).waitFor();
  assert.equal(await f.db.collection('questionLibrary').countDocuments({ 'question.title': '本卷年龄' }), 0);
  await page.unroute(failureRoute);
  await saveToLibrary.click();
  await page.getByText('保存成功', { exact: true }).waitFor();
  assert.equal(await page.locator('#question-list').getByLabel('题目标题').inputValue(), '尚未保存');
  assert.equal((await f.db.collection('questionLibrary').findOne({ 'question.title': '本卷年龄' })).question.title, '本卷年龄');
  const originalTemplate = await f.db.collection('questionLibrary').findOne({ 'question.title': '本卷年龄' });
  const repeatedSave = page.waitForResponse((response) => response.url().endsWith('/save-to-library'));
  await saveToLibrary.click();
  const repeated = await repeatedSave;
  assert.equal(repeated.status(), 201);
  assert.equal((await repeated.json()).data.id, String(originalTemplate._id));
  await page.getByText('保存成功', { exact: true }).waitFor();
  assert.equal(await f.db.collection('questionLibrary').countDocuments({ 'question.title': '本卷年龄' }), 1);
  await page.locator('#load-library').click();
  await page.waitForFunction(() => document.querySelectorAll('#library-options [role=option]').length === 5);
  const titles = await page.locator('#library-options [role=option]').allTextContents();
  assert.equal(new Set(titles).size, 5);
  // Cancel discard and verify that selecting another common question does not import it.
  await page.locator('#import-library-question').click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal((await f.db.collection('surveys').findOne({ _id: surveys.find((s) => String(s._id) === bId)._id })).questions.length, 1);
  // Reset just the local form by confirming its existing reload action.
  await page.locator('#reload').click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('editor-content').inert);
  await page.getByRole('link', { name: '常用题库', exact: true }).click();
  const numberCard = page.locator('#library-list article').filter({ has: page.getByRole('heading', { name: '常用number', exact: true }) });
  await numberCard.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await f.db.collection('questionLibrary').countDocuments({ 'question.title': '常用number' }), 1);
  await page.waitForFunction(() => !document.getElementById('library-content').inert);
  await numberCard.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('library-content').inert);
  assert.equal(await f.db.collection('questionLibrary').countDocuments({ 'question.title': '常用number' }), 0);
  await page.goto(a);
  await page.locator('#editor-content').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#question-list').getByLabel('题目标题').inputValue(), '常用number');
  await page.locator('#publish').click();
  await page.getByRole('dialog').getByRole('button', { name: '确认发布', exact: true }).click();
  await page.locator('#library-picker').waitFor({ state: 'hidden' });
  // Seven available templates must fit in five visible rows, with the rest scrollable.
  const library = createQuestionLibraryService(f.db);
  for (let i = 0; i < 3; i++) {
    await library.create(originalTemplate.ownerId, { question: { title: `滚动查看${i}`, type: 'text' } });
  }
  await page.goto(b);
  await page.waitForFunction(() => document.querySelectorAll('#library-options [role=option]').length === 7);
  await page.locator('#library-selection').click();
  const list = page.locator('#library-options');
  const dimensions = await list.evaluate((node) => ({
    height: node.clientHeight, rowHeight: node.firstElementChild.getBoundingClientRect().height,
    scrollHeight: node.scrollHeight,
  }));
  assert.equal(dimensions.height, dimensions.rowHeight * 5);
  assert.ok(dimensions.scrollHeight > dimensions.height);
  await list.hover();
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.getElementById('library-options').scrollTop > 0);
  const finalChoice = page.locator('#library-options [role=option]').last();
  const finalTitle = await finalChoice.textContent();
  await finalChoice.click();
  assert.equal(await list.isVisible(), false);
  assert.equal(await page.locator('#library-selection').textContent(), finalTitle);
  await page.locator('#library-selection').press('ArrowDown');
  await list.waitFor({ state: 'visible' });
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  assert.equal(await list.isVisible(), false);
  assert.equal(await page.locator('#library-selection').textContent(), '文本填空题：滚动查看2');
  await page.locator('#library-selection').click();
  await page.keyboard.press('Escape');
  assert.equal(await list.isVisible(), false);
  // A second, isolated browser session receives notifications and chooses accept/delete.
  const receiverName = `receiver_${randomUUID().slice(0, 8)}`;
  const receiver = await browser.newPage();
  receiver.setDefaultTimeout(10000);
  receiver.on('pageerror', (error) => errors.push(error.message));
  await receiver.goto(`${base}/register`);
  await receiver.locator('[name=username]').fill(receiverName);
  await receiver.locator('[name=password]').fill(password);
  await receiver.locator('[name=confirmPassword]').fill(password);
  await receiver.getByRole('button', { name: '注册', exact: true }).click();
  await receiver.waitForURL('**/login?*');
  await receiver.locator('[name=username]').fill(receiverName);
  await receiver.locator('[name=password]').fill(password);
  await receiver.getByRole('button', { name: '登录', exact: true }).click();
  await receiver.waitForURL('**/surveys');
  await receiver.locator('#notification-count').waitFor({ state: 'hidden' });
  const receiverUser = await f.db.collection('users').findOne({ username: receiverName });
  const shareButton = page.getByRole('button', { name: '分享题目', exact: true });
  await shareButton.click();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await shareButton.click();
  await page.keyboard.press('Escape');
  assert.equal(await f.db.collection('notifications').countDocuments(), 0);
  await page.locator('#question-list').getByLabel('题目标题').fill('未保存的分享修改');
  await shareButton.click();
  await page.getByRole('dialog').getByLabel('对方用户名').fill('missing_receiver');
  await page.getByRole('dialog').getByRole('button', { name: '确认分享', exact: true }).click();
  await page.getByText('分享失败，未找到该用户，请检查用户名。', { exact: true }).waitFor();
  await page.getByRole('dialog').getByLabel('对方用户名').fill(receiverName);
  await page.getByRole('dialog').getByRole('button', { name: '确认分享', exact: true }).click();
  await page.getByText('对方可在“通知”中选择是否加入题库。', { exact: true }).waitFor();
  assert.equal(await f.db.collection('questionLibrary').countDocuments({ ownerId: receiverUser._id }), 0);
  const sharedFromSurvey = await f.db.collection('notifications').findOne({ recipientId: receiverUser._id });
  assert.equal(sharedFromSurvey.question.title, '本卷年龄');
  assert.equal(await page.locator('#question-list').getByLabel('题目标题').inputValue(), '未保存的分享修改');
  await page.locator('#reload').click();
  await page.getByRole('dialog').getByRole('button', { name: '放弃修改并继续', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('editor-content').inert);
  await page.getByRole('link', { name: '常用题库', exact: true }).click();
  const sharedCard = page.locator('#library-list article').filter({ has: page.getByRole('heading', { name: '滚动查看2', exact: true }) });
  await sharedCard.getByRole('button', { name: '分享题目', exact: true }).click();
  await page.getByRole('dialog').getByLabel('对方用户名').fill(receiverName);
  await page.getByRole('dialog').getByRole('button', { name: '确认分享', exact: true }).click();
  await page.getByText('对方可在“通知”中选择是否加入题库。', { exact: true }).waitFor();
  await receiver.evaluate(() => window.SurveyApp.refreshNotificationCount());
  assert.equal(await receiver.locator('#notification-count').textContent(), '2');
  const badgeStyle = await receiver.locator('#notification-count').evaluate((node) => ({
    background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color,
    width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
  }));
  assert.equal(badgeStyle.background, 'rgb(224, 36, 36)');
  assert.equal(badgeStyle.color, 'rgb(255, 255, 255)');
  assert.equal(badgeStyle.width, badgeStyle.height);
  await screenshot(receiver, 'notification-badge.png');
  await receiver.getByRole('link', { name: '通知', exact: true }).click();
  await receiver.locator('#notification-content').waitFor({ state: 'visible' });
  assert.equal(await receiver.locator('#notification-list article').count(), 2);
  const acceptingCard = receiver.locator('#notification-list article').filter({ has: receiver.getByRole('heading', { name: '本卷年龄', exact: true }) });
  await acceptingCard.getByRole('button', { name: '加入个人题库', exact: true }).click();
  await acceptingCard.getByText('已加入个人题库', { exact: true }).waitFor();
  await receiver.waitForFunction(() => document.getElementById('notification-count').textContent === '1');
  assert.equal(await receiver.locator('#page-message').textContent(), '保存成功');
  assert.equal(await f.db.collection('questionLibrary').countDocuments({ ownerId: receiverUser._id }), 1);
  const declined = receiver.locator('#notification-list article').filter({ has: receiver.getByRole('heading', { name: '滚动查看2', exact: true }) });
  await declined.getByRole('button', { name: '删除通知', exact: true }).click();
  await receiver.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await declined.getByRole('button', { name: '删除通知', exact: true }).click();
  await receiver.keyboard.press('Escape');
  assert.equal(await f.db.collection('notifications').countDocuments({ recipientId: receiverUser._id }), 2);
  await declined.getByRole('button', { name: '删除通知', exact: true }).click();
  await receiver.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await receiver.getByText('通知已删除。', { exact: true }).waitFor();
  await receiver.locator('#notification-count').waitFor({ state: 'hidden' });
  assert.equal(await f.db.collection('notifications').countDocuments({ recipientId: receiverUser._id }), 1);
  assert.equal(await f.db.collection('questionLibrary').countDocuments({ ownerId: receiverUser._id }), 1);
  assert.ok(await f.db.collection('questionLibrary').findOne({ ownerId: originalTemplate.ownerId, 'question.title': '滚动查看2' }));
  await receiver.getByRole('link', { name: '我的问卷', exact: true }).click();
  await receiver.locator('#create-fields [name=title]').fill('使用收到的题目');
  await receiver.getByRole('button', { name: '创建并编辑', exact: true }).click();
  await receiver.waitForURL('**/surveys/*/edit');
  await receiver.waitForFunction(() => document.querySelectorAll('#library-options [role=option]').length === 1);
  await receiver.locator('#library-selection').click();
  await receiver.getByRole('option', { name: '数字填空题：本卷年龄', exact: true }).click();
  await receiver.locator('#import-library-question').click();
  await receiver.locator('#question-list').getByLabel('题目标题').waitFor();
  assert.equal(await receiver.locator('#question-list').getByLabel('题目标题').inputValue(), '本卷年龄');
  // Copy a published survey into an editable draft, then inspect/restore its history.
  await page.goto(`${base}/surveys`);
  const originalRow = page.locator('#survey-list tr').filter({ has: page.getByRole('cell', { name: '复用问卷A', exact: true }) });
  await originalRow.getByRole('button', { name: '复制新问卷', exact: true }).click();
  await page.waitForURL('**/surveys/*/edit');
  await page.locator('#editor-content').waitFor({ state: 'visible' });
  const copyId = page.url().match(/surveys\/([^/]+)/)[1];
  await page.waitForFunction(() => !document.getElementById('library-picker').disabled);
  await screenshot(page, 'copied-draft.png');
  assert.notEqual(copyId, aId);
  assert.equal(await page.locator('#survey-status').textContent(), '草稿');
  for (const title of ['副本修改1', '副本修改2']) {
    await page.locator('#question-list').getByLabel('题目标题').fill(title);
    await page.getByRole('button', { name: '保存题目', exact: true }).click();
    await page.getByText('保存成功', { exact: true }).waitFor();
  }
  const copyHistory = await page.evaluate(async (id) => {
    const s = await window.SurveyApp.api(`/api/surveys/${id}`);
    return window.SurveyApp.api(`/api/surveys/${id}/questions/${s.questions[0].id}/history`);
  }, copyId);
  const copyHead = copyHistory.currentVersion;
  const firstEdit = copyHistory.items.find((v) => v.question.title === '副本修改1').number;
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  const historyDialog = page.getByRole('dialog');
  await historyDialog.getByRole('heading', { name: `v${copyHead}（当前）`, exact: true }).waitFor();
  const versionOne = historyDialog.locator('article').filter({ has: page.getByRole('heading', { name: 'v1', exact: true }) });
  await versionOne.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await historyDialog.waitFor({ state: 'hidden' });
  await page.getByText('保存成功', { exact: true }).waitFor();
  assert.equal(await page.locator('#question-list').getByLabel('题目标题').inputValue(), '常用number');
  await page.locator('#question-list').getByLabel('题目标题').fill('尚未保存的版本修改');
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  await historyDialog.getByRole('heading', { name: `v${copyHead + 1}（当前）`, exact: true }).waitFor();
  await historyDialog.getByText(`由 v${copyHead} 恢复为 v1 的内容`, { exact: true }).waitFor();
  await screenshot(page, 'question-history.png');
  const versionTwo = historyDialog.locator('article').filter({ has: page.getByRole('heading', { name: `v${firstEdit}`, exact: true }) });
  await versionTwo.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await historyDialog.getByText('请先确认放弃未保存的修改，再恢复版本。', { exact: true }).waitFor();
  await historyDialog.getByLabel('恢复时放弃当前页面未保存的修改').check();
  await versionTwo.getByRole('button', { name: '恢复此版本', exact: true }).click();
  await page.getByText('保存成功', { exact: true }).waitFor();
  assert.equal(await page.locator('#question-list').getByLabel('题目标题').inputValue(), '副本修改1');
  const unchangedSource = await f.db.collection('surveys').findOne({ _id: surveys.find((s) => String(s._id) === aId)._id });
  assert.equal(unchangedSource.status, 'published');
  assert.equal(unchangedSource.questions[0].title, '常用number');
  await page.getByRole('link', { name: '常用题库', exact: true }).click();
  let versionedCard = page.locator('#library-list article').filter({ has: page.getByRole('heading', { name: '滚动查看2', exact: true }) });
  await versionedCard.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByRole('heading', { name: '编辑常用题目', exact: true }).waitFor();
  await page.locator('#library-fields').getByLabel('题目标题', { exact: true }).fill('滚动查看2-新版');
  await page.locator('#save-library-question').click();
  await page.getByText('保存成功', { exact: true }).waitFor();
  versionedCard = page.locator('#library-list article').filter({ has: page.getByRole('heading', { name: '滚动查看2-新版', exact: true }) });
  await versionedCard.getByRole('button', { name: '历史版本', exact: true }).click();
  await historyDialog.getByRole('heading', { name: 'v2（当前）', exact: true }).waitFor();
  await historyDialog.locator('article').filter({ has: page.getByRole('heading', { name: 'v1', exact: true }) })
    .getByRole('button', { name: '恢复此版本', exact: true }).click();
  await page.getByText('保存成功', { exact: true }).waitFor();
  await page.locator('#library-list').getByRole('heading', { name: '滚动查看2', exact: true }).waitFor();
  await screenshot(page, 'question-library.png');
  // Create a coexisting library branch, pick its version through the original
  // entry, and verify both directions share history without changing snapshots.
  const rootCard = () => page.locator('#library-list article').filter({ has: page.getByRole('heading', { name: '滚动查看2', exact: true }) });
  await rootCard().getByRole('button', { name: '创建新版本', exact: true }).click();
  await page.getByRole('heading', { name: '创建新版本（基于 v3）', exact: true }).waitFor();
  await page.locator('#library-fields').getByLabel('题目标题', { exact: true }).fill('并存版本题');
  await page.locator('#save-library-question').click();
  await page.getByText('保存成功', { exact: true }).waitFor();
  await rootCard().getByRole('heading', { name: '滚动查看2', exact: true }).waitFor();
  await page.locator('#library-list').getByRole('heading', { name: '并存版本题', exact: true }).waitFor();
  await screenshot(page, 'coexisting-versions.png');
  await page.getByRole('link', { name: '我的问卷', exact: true }).click();
  const sharedSurvey = await createSurvey('共同版本验收');
  await page.waitForFunction(() => document.querySelectorAll('#library-options [role=option]').length === 8);
  await page.locator('#library-selection').click();
  await page.getByRole('option', { name: '文本填空题：滚动查看2', exact: true }).click();
  await page.getByRole('button', { name: '选择历史版本', exact: true }).click();
  const selectedBranch = historyDialog.locator('article').filter({ has: page.getByText('并存版本题', { exact: true }) });
  await selectedBranch.getByRole('button', { name: '选用此版本', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('library-preview').textContent.includes('并存版本题'));
  await page.locator('#import-library-question').click();
  await page.waitForFunction(() => !document.getElementById('editor-content').inert);
  assert.equal(await page.locator('#question-list').getByLabel('题目标题').inputValue(), '并存版本题');
  await page.locator('#question-list').getByLabel('题目标题').fill('问卷同步新版');
  await page.getByRole('button', { name: '保存题目', exact: true }).click();
  await page.getByText('保存成功', { exact: true }).waitFor();
  await page.getByRole('link', { name: '常用题库', exact: true }).click();
  await rootCard().getByRole('button', { name: '历史版本', exact: true }).click();
  await historyDialog.getByText('问卷同步新版', { exact: true }).waitFor();
  await historyDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await rootCard().getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#library-fields').getByLabel('题目标题', { exact: true }).fill('题库同步新版');
  await page.locator('#save-library-question').click();
  await page.getByText('保存成功', { exact: true }).waitFor();
  await page.goto(sharedSurvey);
  await page.locator('#editor-content').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('library-picker').disabled);
  assert.equal(await page.locator('#question-list').getByLabel('题目标题').inputValue(), '问卷同步新版');
  // Seed a real response through authenticated APIs, then inspect the actual
  // cross-survey statistics UI (including text safety and close/reopen).
  await page.evaluate(async () => {
    const id = location.pathname.split('/')[2];
    const A = window.SurveyApp;
    const s = await A.api(`/api/surveys/${id}`);
    await A.api(`/api/surveys/${id}/publish`, { method: 'POST' });
    await A.api(`/api/public/surveys/${id}/responses`, { method: 'POST', body: {
      answers: [{ questionId: s.questions[0].id, value: '跨问卷文本 <b>安全显示</b>' }],
    } });
  });
  await page.getByRole('link', { name: '常用题库', exact: true }).click();
  const statsCard = page.locator('#library-list > article').filter({ has: page.getByRole('heading', { name: '题库同步新版', exact: true }) });
  await statsCard.getByRole('button', { name: '跨问卷统计结果', exact: true }).click();
  const statsBox = statsCard.getByRole('region', { name: '跨问卷统计', exact: true });
  await statsBox.getByText('总有效非空回答数：1', { exact: true }).waitFor();
  await statsBox.getByText('去重登录填写人数：1', { exact: true }).waitFor();
  await statsBox.getByText('跨问卷文本 <b>安全显示</b>', { exact: false }).waitFor();
  assert.equal(await statsBox.locator('b').count(), 0);
  await screenshot(page, 'cross-survey-statistics.png');
  await statsBox.getByRole('button', { name: '收起统计', exact: true }).click();
  await statsBox.waitFor({ state: 'hidden' });
  await statsCard.getByRole('button', { name: '跨问卷统计结果', exact: true }).click();
  await statsBox.getByText('总有效非空回答数：1', { exact: true }).waitFor();
  await page.goto(sharedSurvey);
  await page.locator('#editor-content').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '历史版本', exact: true }).click();
  await historyDialog.getByText('题库同步新版', { exact: true }).waitFor();
  await historyDialog.getByRole('heading', { name: 'v5（当前）', exact: true }).waitFor();
  await screenshot(page, 'shared-version-history.png');
  await historyDialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('link', { name: '常用题库', exact: true }).click();
  const usageCard = page.locator('#library-list > article').filter({ has: page.getByRole('heading', { name: '题库同步新版', exact: true }) });
  await usageCard.getByRole('button', { name: '查找对应问卷', exact: true }).click();
  await usageCard.getByRole('heading', { name: '使用本题及关联版本的问卷', exact: true }).waitFor();
  const usageLink = usageCard.getByRole('link', { name: '共同版本验收', exact: true });
  await usageLink.waitFor();
  assert.equal(await usageLink.getAttribute('href'), new URL(sharedSurvey).pathname);
  await usageCard.getByText('第 1 题：问卷同步新版 · v5', { exact: true }).waitFor();
  await usageCard.getByText('已发布', { exact: true }).waitFor();
  await screenshot(page, 'question-usages.png');
  await usageCard.getByRole('button', { name: '收起', exact: true }).click();
  await usageLink.waitFor({ state: 'hidden' });
  await usageCard.getByRole('button', { name: '查找对应问卷', exact: true }).click();
  await usageLink.click();
  await page.waitForURL(sharedSurvey);
  await page.locator('#editor-content').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#question-list').getByLabel('题目标题').inputValue(), '问卷同步新版');
  assert.deepEqual(errors, []);
  console.log('Real Chrome: coexisting branches, historical-version import, bidirectional shared history with independent snapshots, notification badge, copy, restore, sharing, dropdown and save regression passed; no page errors.');
} catch (error) {
  await screenshot(page, 'browser-failure.png').catch(() => {});
  console.error('Browser page message:', await page?.locator('#page-message').textContent().catch(() => 'unavailable'));
  console.error('Browser dialog:', await page?.locator('dialog').textContent().catch(() => 'unavailable'));
  throw error;
} finally {
  try { await browser?.close(); }
  finally {
    try { await runtime?.close(); }
    finally { await f.cleanup(); }
  }
}
