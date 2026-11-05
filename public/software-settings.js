import { updateCause, updateStage } from './update-causes.js';
export function mountClaudePermissions(container, { api, tr, esc, onSaved }) {
  let snapshot,
    busy = false;
  const labels = {
    manual: tr('מצב ידני', 'Manual'),
    automatic: tr('מצב אוטומטי', 'Automatic'),
    free: tr('מצב חופשי (מסוכן)', 'Free (Dangerous)'),
  };
  const warning = tr(
    'מצב חופשי מדלג על אישורי Claude ועלול לאפשר פעולות הרסניות. במערכת זו הוא חסום כדי לשמור על גבולות סביבת העבודה. הבחירה תישמר, אך משימות Claude לא יופעלו עד לבחירת מצב נתמך. אישורי הכלים של StellarCortex נשארים בתוקף.',
    'Free mode skips Claude approvals and may allow destructive actions. It is blocked in this installation to preserve workspace boundaries. The selection will be saved, but Claude tasks will not start until you choose a supported mode. StellarCortex tool approvals remain in force.',
  );
  const options = (value, inherit = false) =>
    (inherit
      ? `<option value="inherit" ${value == null ? 'selected' : ''}>${tr('לפי ברירת המחדל', 'Use workspace default')}</option>`
      : '') +
    Object.entries(labels)
      .map(
        ([mode, label]) =>
          `<option value="${mode}" ${mode === value ? 'selected' : ''}>${label}</option>`,
      )
      .join('');
  const effective = mode =>
    mode === 'free'
      ? tr(
          'חסום — המצב המוגבל אינו מאפשר עקיפת הרשאות',
          'Blocked — restricted mode does not allow permission bypass',
        )
      : labels[mode] +
        (mode === 'automatic'
          ? tr(
              ' — בכפוף לתמיכת Claude ולמדיניות הארגון',
              ' — subject to Claude support and organization policy',
            )
          : '');
  function render() {
    if (!container.isConnected) return;
    container.innerHTML =
      `<h4>${tr('הרשאות Claude', 'Claude permissions')}</h4><p class="settings-description">${tr('מצב ידני מבקש אישור לפעולות. מצב אוטומטי משתמש בבדיקת הבטיחות של Claude; הוא אינו עוקף הרשאות. בכל מצב, הוראות מגיעות רק ממך או מבוטים אחרים בכלי: אחרי שמשימה קוראת תוכן חיצוני (Gmail,‏ Google,‏ MCP,‏ webhook או דף אינטרנט), פקודות מעטפת ושינויי קבצים נחסמים לכל השיחה, בלי אפשרות לאשר אותם. שינויים חלים על המשימות הבאות ואפשר לשמור אותם רק כשהעבודה הסתיימה.', 'Manual requests action approvals. Automatic uses Claude’s safety classifier; it does not bypass permissions. In every mode, instructions come only from you or other bots in the tool: once a task reads external content (Gmail, Google, MCP, a webhook or a web page), shell commands and file changes are blocked for the whole conversation, with no way to approve them. Changes apply to future tasks and can be saved only when work has finished.')}</p><form data-permission-default><label for="claude-default-mode">${tr('ברירת מחדל לבוטים של Claude', 'Default for Claude bots')}</label><select id="claude-default-mode" name="mode">${options(snapshot.defaultMode)}</select><p class="settings-description">${tr('מצב בפועל', 'Effective mode')}: ${esc(effective(snapshot.defaultMode))}</p><p data-permission-warning class="notice" ${snapshot.defaultMode === 'free' ? '' : 'hidden'}>${warning}</p><button class="secondary" ${busy ? 'disabled' : ''}>${tr('שמירת ברירת מחדל', 'Save default')}</button></form><h4>${tr('הגדרה נפרדת לכל בוט', 'Per-bot override')}</h4>` +
      snapshot.bots
        .filter(bot => bot.provider === 'claude')
        .map(
          bot =>
            `<form data-permission-bot="${esc(bot.id)}" class="settings-section"><label for="permission-${esc(bot.id)}">${esc(bot.name)}</label><select id="permission-${esc(bot.id)}" name="mode">${options(bot.override, true)}</select><p class="settings-description">${tr('מצב בפועל', 'Effective mode')}: ${esc(effective(bot.mode))} · ${bot.source === 'bot' ? tr('הגדרה של הבוט', 'Bot override') : tr('ברירת מחדל', 'Workspace default')}</p><p data-permission-warning class="notice" ${bot.mode === 'free' ? '' : 'hidden'}>${warning}</p><button class="secondary" ${busy ? 'disabled' : ''}>${tr('שמירת הגדרת הבוט', 'Save bot setting')}</button></form>`,
        )
        .join('') +
      `<p class="settings-description">${tr('המצב החופשי אינו זמין במצב המוגבל. אין שינוי במגבלות מערכת ההפעלה, מדיניות הארגון או הרשאות הכלים של StellarCortex. אם המצב האוטומטי אינו נתמך, המשימה תדווח על כשל בלי לעבור למצב חופשי.', 'Free mode is unavailable under restricted mode. OS limits, organization policy and StellarCortex tool permissions remain unchanged. If Automatic is unsupported, the task reports failure without switching to Free.')}</p><p data-permission-feedback role="status"></p>`;
    container.querySelectorAll('form').forEach(form => {
      form.elements.mode.onchange = () => {
        form.querySelector('[data-permission-warning]').hidden = !(
          form.elements.mode.value === 'free' ||
          (form.elements.mode.value === 'inherit' && snapshot.defaultMode === 'free')
        );
      };
      form.onsubmit = async event => {
        event.preventDefault();
        if (busy) return;
        const mode = form.elements.mode.value,
          botId = form.dataset.permissionBot || null;
        const dangerous =
          mode === 'free' || (mode === 'inherit' && snapshot.defaultMode === 'free');
        if (
          dangerous &&
          !window.confirm(
            warning +
              '\n\n' +
              (botId
                ? tr('לשמור בחירה זו לבוט הזה?', 'Save this selection for this bot?')
                : tr(
                    'לשמור עבור כל הבוטים ללא הגדרה נפרדת?',
                    'Save for every bot inheriting the workspace default?',
                  )),
          )
        )
          return;
        busy = true;
        container.querySelectorAll('button,select').forEach(el => (el.disabled = true));
        try {
          snapshot = await api(
            '/api/claude-permissions',
            { botId, mode, confirmDangerous: dangerous },
            'PATCH',
          );
          await onSaved?.();
          render();
          container.querySelector('[data-permission-feedback]').textContent = tr(
            'ההגדרה נשמרה',
            'Setting saved',
          );
        } catch (error) {
          if (container.isConnected)
            container.querySelector('[data-permission-feedback]').textContent = error.message;
        } finally {
          busy = false;
          if (container.isConnected)
            container.querySelectorAll('button,select').forEach(el => (el.disabled = false));
        }
      };
    });
  }
  container.innerHTML = `<p role="status">${tr('טוען הרשאות Claude…', 'Loading Claude permissions…')}</p>`;
  api('/api/claude-permissions')
    .then(result => {
      snapshot = result;
      render();
    })
    .catch(error => {
      if (container.isConnected) container.textContent = error.message;
    });
}

export function mountSoftwareUpdates(container, { api, tr, esc }) {
  let info = null,
    checkFailed = false,
    checkedAt = null,
    busy = false,
    error = '',
    updating = false,
    poll = null,
    before = '';
  const comparisons = {
    'same-version': tr('ההתקנה מעודכנת.', 'This installation is up to date.'),
    'newer-version': tr('יש גרסה חדשה וחתומה.', 'A newer signed version is available.'),
    'locally-modified': tr(
      'יש שינויים מקומיים, ולכן אי אפשר לעדכן מכאן. שמרו אותם קודם.',
      'Local changes exist, so this installation cannot update from here. Preserve them first.',
    ),
    'installed-ahead': tr(
      'הגרסה המותקנת חדשה מהגרסה האחרונה שפורסמה.',
      'The installed version is newer than the latest published one.',
    ),
  };
  function resultText(result) {
    if (result.status === 'updated')
      return (
        tr('העדכון הצליח: ', 'Updated: ') +
        (result.from ? result.from + ' ← ' : '') +
        result.version
      );
    if (result.status === 'rolled-back')
      return (
        tr(
          'העדכון נכשל והגרסה הקודמת הוחזרה. ',
          'The update failed, and the previous version is back. ',
        ) + updateCause(result.error, tr)
      );
    return (
      tr(
        'העדכון נעצר ונדרש טיפול. ראו את הוראות השחזור במסמכים. ',
        'The update stopped and needs attention. See the recovery guide in the docs. ',
      ) + updateCause(result.error, tr)
    );
  }
  function stopPolling() {
    clearInterval(poll);
    poll = null;
    updating = false;
  }
  function follow() {
    before = JSON.stringify(info?.lastUpdate || null);
    poll = setInterval(async () => {
      if (!container.isConnected) return stopPolling();
      // The server is down during the switch, so a failed read only means wait.
      try {
        const value = await api('/api/software-update');
        info = { ...info, ...value };
        if (JSON.stringify(value.lastUpdate || null) !== before) stopPolling();
        render();
      } catch {}
    }, 2000);
  }
  function render() {
    if (!container.isConnected) return;
    // After a failed check the last good result says nothing about now.
    const offered = checkFailed ? null : info?.offered,
      ready =
        !checkFailed &&
        info?.canApply &&
        info?.comparison === 'newer-version' &&
        !info?.installed?.modified;
    const button = updating
      ? `<button class="primary" disabled>${esc(tr('מעדכן…', 'Updating…'))}</button>`
      : ready
        ? `<button class="primary" data-update-apply ${busy ? 'disabled' : ''}>${esc(tr('עדכן עכשיו', 'Update now'))}</button>`
        : checkFailed
          ? `<button class="secondary" data-update-check ${busy ? 'disabled' : ''}>${esc(tr('בדוק עדכונים', 'Check for updates'))}</button>`
          : '';
    // A check can take seconds, so it always says it is working.
    const checking =
      busy && !updating ? `<span role="status">${esc(tr('בודק…', 'Checking…'))}</span>` : '';
    container.innerHTML =
      `<h4>${tr('עדכון תוכנה', 'Update Software')}</h4><p>${tr('גרסה מותקנת', 'Installed version')}: <strong>${esc(info?.installed?.version || '…')}</strong></p>` +
      (offered
        ? `<p>${tr('הגרסה האחרונה', 'Latest version')}: <strong>${esc(offered.version)}</strong>${offered.date ? ' · ' + esc(offered.date) : ''}</p>${offered.notes ? `<p class="settings-description" dir="auto">${esc(tr(offered.notes.he || '', offered.notes.en || ''))}</p>` : ''}<p role="status">${esc(comparisons[info.comparison])}</p>`
        : '') +
      (info && !info.canApply
        ? `<p class="notice">${tr('ההתקנה הזאת לא יכולה לעדכן את עצמה. ראו את הוראות השחזור במסמכים.', 'This installation cannot update itself. See the recovery guide in the docs.')}</p>`
        : '') +
      `<p class="settings-description">${tr('כל גרסה נבדקת מול מפתח חתימה שקבוע בהתקנה. לפני ההחלפה הנתונים מגובים, ואם הגרסה החדשה לא עוברת בדיקה, הגרסה הקודמת חוזרת.', 'Each release is checked against a signing key fixed in this installation. Your data is backed up first, and if the new version fails its check, the previous one comes back.')}</p>` +
      `<div class="actions">${button}${checking}</div>`;
    const status = text => {
      const item = document.createElement('p');
      item.setAttribute('role', 'status');
      item.textContent = text;
      container.append(item);
    };
    if (updating) status(updateStage(info?.progress, tr));
    else if (info?.lastUpdate) status(resultText(info.lastUpdate));
    // The same answer twice reads the same, so the time shows that the check really ran.
    if (checkedAt)
      status(tr('נבדק לאחרונה: ', 'Last checked: ') + checkedAt.toLocaleTimeString(tr('he', 'en')));
    if (error) {
      const item = document.createElement('p');
      // No release yet is a normal state, so it reads as a status and not as a failure.
      const normal = /No release is published/.test(info?.checkError);
      item.className = normal ? 'notice' : 'notice error';
      item.setAttribute('role', normal ? 'status' : 'alert');
      item.textContent = error;
      container.append(item);
    }
    const apply = container.querySelector('[data-update-apply]'),
      check = container.querySelector('[data-update-check]');
    if (apply)
      apply.onclick = async () => {
        if (busy || updating) return;
        const question =
          tr('לעדכן את StellarCortex מגרסה ', 'Update StellarCortex from version ') +
          info.installed.version +
          tr(' לגרסה ', ' to ') +
          offered.version +
          '?\n\n' +
          tr(
            'השרת יופעל מחדש. יש לסיים עבודה פעילה ושיחות קוליות לפני העדכון.',
            'The server will restart. Finish active work and voice calls first.',
          );
        if (!window.confirm(question)) return;
        updating = true;
        error = '';
        follow();
        render();
        try {
          await api('/api/software-update/apply', { version: offered.version, confirm: true });
        } catch (e) {
          stopPolling();
          error = updateCause(e.message, tr);
          render();
        }
      };
    if (check) check.onclick = () => runCheck();
  }
  async function runCheck() {
    if (busy || updating) return;
    // The last result stays on screen until the new one replaces it.
    busy = true;
    render();
    try {
      info = await api('/api/software-update/check', {});
      checkFailed = !!info.checkError;
      error = checkFailed ? updateCause(info.checkError, tr) : '';
    } catch (e) {
      checkFailed = true;
      error = updateCause(e.message, tr);
    } finally {
      checkedAt = info?.checkedAt && !checkFailed ? new Date(info.checkedAt) : new Date();
      busy = false;
      render();
    }
  }
  render();
  api('/api/software-update')
    .then(value => {
      if (!info) {
        info = value;
        render();
      }
    })
    .catch(e => {
      error = updateCause(e.message, tr);
    })
    .finally(() => runCheck());
}
