// Passwords go only into this dialog. It sits outside the chat and sends bytes straight to the
// secret route, so the value is never in app state, the message list or a JSON body.
let openId = null;
const secureHere = () =>
  location.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
function dialogElement() {
  let dialog = document.querySelector('#secret-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'secret-dialog';
    dialog.addEventListener('cancel', event => event.preventDefault());
    document.body.append(dialog);
  }
  return dialog;
}
export function renderSecretDialog({ state, tr, esc, api, refresh, botById, direction }) {
  const request = state?.approvals?.find(a => a.kind === 'secret' && a.status === 'pending'),
    dialog = dialogElement();
  if (!request) {
    if (dialog.open) dialog.close();
    openId = null;
    return;
  }
  if (openId === request.id && dialog.open) return;
  openId = request.id;
  const d = request.details,
    secure = secureHere(),
    differs = d.submitHost && d.submitHost !== d.host;
  dialog.dir = direction();
  dialog.innerHTML = `<form class="secret-form" autocomplete="off"><h2>${tr('כניסה לאתר', 'Log in to a site')}</h2>
    <p>${esc(tr(`${botById(request.botId)?.name || d.botName} מבקש שתתחברו, בשיחה ${d.chatName}.`, `${botById(request.botId)?.name || d.botName} asks you to log in, in the conversation ${d.chatName}.`))}</p>
    <p class="secret-host"><bdi dir="ltr">${esc(d.host)}</bdi></p>
    ${differs ? `<p class="error">${tr('הסיסמה תישלח לאתר אחר:', 'The password will be sent to a different site:')} <bdi dir="ltr">${esc(d.submitHost)}</bdi></p>` : ''}
    ${d.punycode ? `<p class="error">${tr('הכתובת כוללת תווים מיוחדים (xn--), ואולי היא מתחזה לאתר אחר.', 'This address has special characters (xn--) and may imitate another site.')}</p>` : ''}
    ${d.ownerNamed ? `<p>${tr('ציינתם את האתר הזה במשימה.', 'You named this site.')}</p>` : `<p class="error">${tr('לא ציינתם את האתר הזה במשימה. בדקו את הכתובת לפני שתמשיכו.', 'You did not name this site in this task. Check the address before you go on.')}</p>`}
    ${request.external ? `<p class="error">${tr('המשימה הזו קראה תוכן חיצוני.', 'This task read external content.')}</p>` : ''}
    ${
      secure
        ? `${d.needsUsername ? `<label for="secret-username">${tr('שם משתמש', 'Username')}</label><input id="secret-username" dir="ltr" autocomplete="off">` : ''}
    <label for="secret-password">${tr('סיסמה', 'Password')}</label><input id="secret-password" type="password" dir="ltr" autocomplete="off" required>
    <p class="small">${tr('הבוט לא רואה את הסיסמה. היא נשלחת לאתר ולא נשמרת.', 'The bot never sees this password. It goes to the site and is not saved.')}</p>`
        : `<p class="error">${tr('החיבור לאפליקציה לא מאובטח, ולכן אי אפשר לשלוח סיסמה. פתחו אותה ב־HTTPS או ב־localhost, או השתמשו ב־Take control.', 'This connection to the app is not secure, so a password cannot be sent. Open it over HTTPS or localhost, or use Take control.')}</p>`
    }
    <p class="error" role="alert" data-secret-error hidden></p>
    <div class="actions">${secure ? `<button class="primary" type="submit">${tr('התחברות', 'Log in')}</button>` : ''}<button class="secondary" type="button" data-secret-decline>${tr('דחייה', 'Decline')}</button></div></form>`;
  const form = dialog.querySelector('form'),
    failed = message => {
      const el = dialog.querySelector('[data-secret-error]');
      el.textContent = message;
      el.hidden = false;
    };
  dialog.querySelector('[data-secret-decline]').onclick = async () => {
    try {
      await api(`/api/approvals/${request.id}`, { approve: false });
      dialog.close();
      openId = null;
      await refresh();
    } catch (error) {
      failed(error.message);
    }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const password = dialog.querySelector('#secret-password'),
      username = dialog.querySelector('#secret-username');
    if (username && !d.hasPasswordField && !username.value)
      return failed(tr('הקלידו שם משתמש', 'Enter a username'));
    const bytes = new TextEncoder().encode(`${username?.value || ''}\0${password.value}`);
    password.value = '';
    try {
      const response = await fetch(`/api/secret-requests/${encodeURIComponent(request.id)}`, {
        method: 'POST',
        headers: { 'X-StellarCortex-Client': '1', 'Content-Type': 'application/octet-stream' },
        body: bytes,
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error((await response.json()).error);
      dialog.close();
      openId = null;
      await refresh();
    } catch (error) {
      failed(error.message);
    } finally {
      bytes.fill(0);
    }
  };
  if (!dialog.open) dialog.showModal();
}
