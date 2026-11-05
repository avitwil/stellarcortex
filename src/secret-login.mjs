// Password pass-through for a browser login. Everything the owner is shown is read here from
// the page, never taken from the model, and the value never reaches the model or the disk.
export const SECRET_LIMIT = 4096;
const PASSWORD = 'input[type=password]:visible',
  USERNAME =
    'input:not([type]):visible,input[type=text]:visible,input[type=email]:visible,input[type=tel]:visible';
const httpsOnly = url => new URL(url).protocol === 'https:';
const readLoginForm = () => {
  const shown = el => {
    const box = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility === 'visible' &&
      style.display !== 'none' &&
      Number(style.opacity) > 0
    );
  };
  const inputs = [...document.querySelectorAll('input')].filter(shown),
    password = inputs.find(el => el.type === 'password');
  const username = inputs.find(
    el =>
      ['text', 'email', 'tel'].includes(el.type) && (!password?.form || el.form === password.form),
  );
  const form = (password || username)?.form || null,
    button = form?.querySelector('[type=submit],button:not([type])');
  const attribute = name => button?.getAttribute('form' + name) || form?.getAttribute(name) || '';
  return {
    password: !!password,
    username: !!username,
    method: attribute('method').toLowerCase(),
    action: form ? new URL(attribute('action') || location.href, document.baseURI).href : null,
  };
};
export async function loginFacts(page, secure = httpsOnly) {
  const url = page.url();
  if (!/^https?:/.test(url)) return { status: 'no-field' };
  if (!secure(url)) return { status: 'insecure' };
  const form = await page.mainFrame().evaluate(readLoginForm);
  if (!form.password && !form.username) return { status: 'no-field' };
  // An explicit GET would put the password in the URL. A form with no method is often a script's, so the delivery guard covers it.
  if (form.method === 'get' || (form.action && !secure(form.action))) return { status: 'insecure' };
  const { origin, hostname } = new URL(url);
  return {
    origin,
    host: hostname,
    submitHost: form.action ? new URL(form.action).hostname : hostname,
    password: form.password,
    username: form.username,
  };
}
async function usernameField(page) {
  const form = page
    .locator('form')
    .filter({ has: page.locator(PASSWORD) })
    .first();
  return (await form.count()) ? form.locator(USERNAME).first() : page.locator(USERNAME).first();
}
export async function submitLogin(page, target, { username, password }, secure = httpsOnly) {
  const result = (status, passwordFieldStillShown = false) => ({ status, passwordFieldStillShown });
  const facts = await loginFacts(page, secure);
  if (facts.status === 'insecure') return result('insecure');
  if (
    facts.status ||
    ['origin', 'submitHost', 'password', 'username'].some(key => facts[key] !== target[key])
  )
    return result('target-changed');
  let leaked = false;
  const guard = route => {
    let values = [];
    try {
      values = [...new URL(route.request().url()).searchParams.values()];
    } catch {}
    if (values.includes(password)) {
      leaked = true;
      return route.abort('blockedbyclient');
    }
    return route.fallback();
  };
  await page.route('**/*', guard);
  try {
    const field = page.locator(PASSWORD).first(),
      before = page.url();
    if (target.username && username) await (await usernameField(page)).fill(username);
    if (!target.password) {
      await page.keyboard.press('Enter');
      try {
        await field.waitFor({ state: 'visible', timeout: 5000 });
      } catch {
        return result('target-changed');
      }
      const next = await loginFacts(page, secure);
      if (next.status === 'insecure') return result('insecure');
      if (next.status || next.origin !== target.origin || next.submitHost !== target.submitHost)
        return result('target-changed');
    }
    await field.fill(password);
    await field.press('Enter');
    await page
      .waitForURL(url => url.href !== before, { timeout: 3000, waitUntil: 'commit' })
      .catch(() => {});
    const shown = await field.isVisible().catch(() => false);
    if (shown) await field.fill('').catch(() => {});
    return result(leaked ? 'failed' : 'submitted', shown);
  } finally {
    await page.unroute('**/*', guard).catch(() => {});
  }
}
// A bot could otherwise collect a password in the unmasked question box. The question text
// is the model's, so this catches honest wording only; the box also tells the owner not to.
export function asksForPassword({ reason = '', questions = [] } = {}) {
  const words = /pass\s*-?\s*(word|code|phrase)|\bpin\b|סיסמ|קוד סודי/i;
  return (
    words.test(String(reason)) ||
    questions.some(
      q =>
        q.isSecret === true ||
        q.is_secret === true ||
        words.test(`${q.header || ''} ${q.question || ''}`),
    )
  );
}
