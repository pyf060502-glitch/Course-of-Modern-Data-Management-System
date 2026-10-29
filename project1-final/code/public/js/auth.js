(function () {
  'use strict';
  const A = window.SurveyApp;
  const form = document.getElementById('auth-form');
  const message = document.getElementById('page-message');
  const mode = document.body.dataset.authMode;
  A.run(message, async () => {
    const user = await A.initHeader();
    if (user) location.replace(A.safeNext());
    if (new URLSearchParams(location.search).get('registered') === '1') {
      A.showMessage(message, '注册成功，请使用新账号登录。');
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    A.run(message, async () => {
      const username = form.elements.username.value.trim();
      const password = form.elements.password.value;
      if ([...password].length < 8 || new TextEncoder().encode(password).length > 72) {
        throw new Error('密码至少 8 个字符，不超过 72 个字符。');
      }
      if (mode === 'register' && password !== form.elements.confirmPassword.value) {
        throw new Error('两次输入的密码不一致。');
      }
      await A.api('/api/auth/' + mode, { method: 'POST', body: { username, password } });
      if (mode === 'login') {
        A.clearCsrfToken();
        await A.getCsrfToken();
        location.assign(A.safeNext());
      } else {
        location.assign('/login?registered=1&next=' + encodeURIComponent(A.safeNext()));
      }
    }, form.querySelector('button[type="submit"]'));
  });
})();
