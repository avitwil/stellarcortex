// Connect button for Claude. The server runs the official login; this page only relays the link and the code.
export function mountClaudeLogin(node, { api, tr, esc, onConnected }) {
  if (!node) return;
  const failures = {
    rejected: () =>
      tr(
        'הקוד לא התקבל. נסה שוב עם קוד חדש.',
        'That code was not accepted. Try again with a new one.',
      ),
    timeout: () => tr('הזמן לכניסה הסתיים. נסה שוב.', 'Sign-in timed out. Try again.'),
    network: () =>
      tr(
        'לא הייתה גישה לשרתי Claude. בדוק את הרשת ונסה שוב.',
        'Could not reach Claude. Check the network and try again.',
      ),
    missing: () =>
      tr(
        'Claude Code לא נמצא בשרת. התקן אותו ונסה שוב.',
        'Claude Code was not found on the server. Install it and try again.',
      ),
    'unexpected-link': () =>
      tr(
        'הכניסה הופסקה כי הקישור לא הוביל לאתר של Claude.',
        'Sign-in stopped because the link did not point to Claude.',
      ),
    failed: () =>
      tr(
        'הכניסה נכשלה. נסה שוב או השתמש בפקודה למטה.',
        'Sign-in failed. Try again, or use the command below.',
      ),
  };
  let shown = null,
    timer = null;
  const poll = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!node.isConnected) return;
      try {
        show(await api('/api/claude-login'));
      } catch {
        poll();
      }
    }, 2000);
  };
  const send = async body => {
    try {
      show(await api('/api/claude-login', body));
    } catch (error) {
      node.querySelector('.notice')?.remove();
      node.insertAdjacentHTML('afterbegin', '<p class="notice">' + esc(error.message) + '</p>');
    }
  };
  function connectButton() {
    return (
      '<button id="claude-connect" class="primary">' +
      tr('חיבור Claude', 'Connect Claude') +
      '</button>'
    );
  }
  function show(next) {
    const key = next.state + (next.reason || '');
    if (['waiting', 'verifying'].includes(next.state)) poll();
    if (key === shown || !node.isConnected) return;
    shown = key;
    if (next.state === 'connected') {
      node.innerHTML =
        '<p class="settings-description">' +
        tr('מחובר. בודק את החשבון…', 'Connected. Checking the account…') +
        '</p>';
      onConnected?.();
      return;
    }
    if (next.state === 'waiting') {
      node.innerHTML =
        '<a class="claude-login-link" href="' +
        esc(next.url) +
        '" target="_blank" rel="noopener noreferrer">' +
        tr('פתיחת דף הכניסה של Claude', 'Open the Claude sign-in page') +
        ' ↗</a><p class="settings-description">' +
        tr(
          'התחבר בדף שנפתח. אם מוצג קוד, הדבק אותו כאן.',
          'Sign in on that page. If it shows a code, paste it here.',
        ) +
        '</p><form class="claude-code-row"><input id="claude-login-code" dir="ltr" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="' +
        tr('קוד כניסה', 'Sign-in code') +
        '" placeholder="' +
        tr('קוד כניסה', 'Sign-in code') +
        '"><button type="submit" class="primary">' +
        tr('שליחת הקוד', 'Send code') +
        '</button><button type="button" id="claude-login-cancel" class="secondary">' +
        tr('ביטול', 'Cancel') +
        '</button></form>';
      node.querySelector('form').onsubmit = event => {
        event.preventDefault();
        const input = node.querySelector('#claude-login-code'),
          code = input.value.trim();
        input.value = '';
        if (code) send({ action: 'code', code });
      };
      node.querySelector('#claude-login-cancel').onclick = () => send({ action: 'cancel' });
      return;
    }
    if (next.state === 'verifying') {
      node.innerHTML =
        '<p class="settings-description">' + tr('בודק את הקוד…', 'Checking the code…') + '</p>';
      return;
    }
    node.innerHTML =
      (next.state === 'failed'
        ? '<p class="notice">' + esc((failures[next.reason] || failures.failed)()) + '</p>'
        : '') + connectButton();
    node.querySelector('#claude-connect').onclick = event => {
      event.target.disabled = true;
      event.target.textContent = tr('מכין את הכניסה…', 'Preparing sign-in…');
      shown = null;
      send({ action: 'start' });
    };
  }
  show({ state: 'idle' });
  api('/api/claude-login')
    .then(show)
    .catch(() => {});
}
