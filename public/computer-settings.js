import {
  COMPUTER_STAGES,
  computerInstallText,
  computerSetupText,
  computerStateLabel,
} from './computer-status.js';
export function mountComputerModes(container, { api, tr, esc, onSaved, focusBot }) {
  let snapshot,
    build,
    busy = false;
  const labels = {
    none: tr('ללא מחשב', 'No computer'),
    vm: tr('מחשב וירטואלי', 'Virtual computer'),
    host: tr('שליטה במחשב המארח', 'Host control'),
  };
  const hostNote = {
    x11: tr(
      'מעטפת ומסך אחד משותף, בוט אחד בכל פעם.',
      'Shell and one shared screen, one bot at a time.',
    ),
    wayland: tr(
      'מעטפת בלבד. אי אפשר לשלוט במסך Wayland; היכנסו לסשן X11 כדי לקבל מסך.',
      'Shell only. A Wayland screen cannot be controlled; log in to an X11 session for a screen.',
    ),
    'no-display': tr('מעטפת בלבד. השירות לא מצא מסך.', 'Shell only. The service found no display.'),
    container: tr(
      'מעטפת בתוך הקונטיינר בלבד, ללא מסך.',
      'Shell inside the container only, no screen.',
    ),
    wsl: tr('מעטפת בתוך ההפצה בלבד, ללא מסך.', 'Shell inside the distribution only, no screen.'),
    unsupported: tr('מעטפת בלבד.', 'Shell only.'),
  };
  const warning = tr(
    'בוט עם שליטה במחשב המארח פועל כמשתמש מערכת ההפעלה של השרת. המעטפת שלו יכולה לקרוא מפתחות פרטיים, את מפתח הגישה ועוגיות דפדפן, ולקרוא ל־API של האפליקציה בשמכם. אף הגדרה באפליקציה לא יכולה למנוע זאת.',
    'A host bot runs as the server’s OS user. Its shell can read private keys, the access key and browser cookies, and can call the app’s API as you. No application setting can stop that.',
  );
  function render() {
    if (!container.isConnected) return;
    const options = value =>
      Object.entries(labels)
        .map(
          ([mode, label]) =>
            `<option value="${mode}" ${mode === value ? 'selected' : ''} ${mode === 'vm' && !snapshot.vm.available && value !== 'vm' ? 'disabled' : ''}>${esc(label)}</option>`,
        )
        .join('');
    container.innerHTML =
      `<h4>${tr('מחשב לכל בוט', 'Computer for each bot')}</h4><p class="settings-description">${tr('בוט ללא מחשב לא מריץ פקודות. מחשב וירטואלי מבודד מהמארח. שליטה במחשב המארח נותנת לבוט את המחשב הזה.', 'A bot with no computer runs no commands. A virtual computer is isolated from the host. Host control gives the bot this machine.')}</p><ul class="settings-description" data-computer-status><li>${esc(labels.vm)}: ${snapshot.vm.available ? esc(computerStateLabel(build, tr)) : tr('לא מוגדר בהתקנה הזו', 'Not configured on this installation')}</li><li>${esc(labels.host)}: ${esc(hostNote[snapshot.host.state] || hostNote.unsupported)}</li></ul>` +
      snapshot.bots
        .map(
          bot =>
            `<div class="settings-section"><label for="computer-${esc(bot.id)}">${esc(bot.name)}</label><select id="computer-${esc(bot.id)}" data-computer-bot="${esc(bot.id)}">${options(bot.computer)}</select></div>`,
        )
        .join('') +
      '<p class="settings-description" role="status" data-computer-feedback></p>';
    container.querySelectorAll('[data-computer-bot]').forEach(select => {
      select.onchange = async () => {
        if (busy) return;
        const botId = select.dataset.computerBot,
          mode = select.value,
          saved = snapshot.bots.find(bot => bot.id === botId).computer,
          confirmHost = mode === 'host';
        if (confirmHost && !window.confirm(warning)) {
          select.value = saved;
          return;
        }
        busy = true;
        container.querySelectorAll('select').forEach(el => (el.disabled = true));
        try {
          snapshot = await api(
            '/api/computer-modes',
            { botId, mode, ...(confirmHost ? { confirmHost } : {}) },
            'PATCH',
          );
          await onSaved?.();
          busy = false;
          render();
          container.querySelector('[data-computer-feedback]').textContent = tr(
            'ההגדרה נשמרה',
            'Setting saved',
          );
        } catch (error) {
          busy = false;
          if (container.isConnected) {
            render();
            container.querySelector('[data-computer-feedback]').textContent = error.message;
          }
        }
      };
    });
  }
  container.innerHTML = `<p role="status">${tr('טוען הגדרות מחשב…', 'Loading computer settings…')}</p>`;
  api('/api/computer-modes')
    .then(result => {
      snapshot = result;
      render();
      [...container.querySelectorAll('[data-computer-bot]')]
        .find(select => select.dataset.computerBot === focusBot)
        ?.focus();
    })
    .catch(error => {
      if (container.isConnected) container.textContent = error.message;
    });
  return {
    setBuild(value) {
      build = value;
      if (snapshot && !busy) render();
    },
  };
}
export function mountComputerBuild(node, { api, tr, esc, onState }) {
  let timer;
  const show = build => {
    clearTimeout(timer);
    if (!node.isConnected) return;
    onState?.(build);
    node.hidden = false;
    if (build.available === false) {
      node.innerHTML = `<h4>${tr('המחשב הווירטואלי', 'The virtual computer')}</h4><p class="settings-description">${esc(computerInstallText(build.code, tr))}</p>`;
      return;
    }
    if (['ready', 'allocation-available'].includes(build.state)) {
      node.hidden = true;
      return;
    }
    const failed = ['failed', 'not-started', 'stopped'].includes(build.state),
      current = COMPUTER_STAGES.findIndex(([id]) => id === build.stage);
    node.innerHTML =
      `<h4>${tr('המחשב הווירטואלי', 'The virtual computer')}</h4>` +
      (build.state === 'building'
        ? `<ol class="computer-build-stages">${COMPUTER_STAGES.map(([id, he, en], index) => `<li data-state="${index < current ? 'done' : index === current ? 'active' : 'waiting'}">${esc(tr(he, en))}${index === current && build.percent != null ? ` ${build.percent}%` : ''}</li>`).join('')}</ol>`
        : '') +
      `<p class="settings-description" role="status">${esc(computerSetupText(build, tr))}</p>` +
      (failed
        ? `<button type="button" data-computer-retry>${build.state === 'stopped' ? tr('הפעלה', 'Start') : build.state === 'failed' ? tr('נסו שוב', 'Retry') : tr('בניית המחשב', 'Build the computer')}</button>`
        : '');
    const retry = node.querySelector('[data-computer-retry]');
    if (retry)
      retry.onclick = () => {
        retry.disabled = true;
        api('/api/computer-build', {}, 'POST')
          .then(show)
          .catch(() => {
            retry.disabled = false;
          });
      };
    if (!failed) timer = setTimeout(load, 3000);
  };
  const load = () =>
    api('/api/computer-build')
      .then(show)
      .catch(() => {
        timer = setTimeout(load, 5000);
      });
  load();
}
export function mountComputerBoot(node, { api, tr }) {
  const show = state => {
    node.hidden = !state.available;
    if (!state.available || !node.isConnected) return;
    node.innerHTML = `<h4>${tr('הפעלה אחרי אתחול', 'Start after a reboot')}</h4><label class="computer-boot-toggle"><input type="checkbox" id="computer-boot" ${state.enabled ? 'checked' : ''}><span>${tr('המחשב הווירטואלי עולה לבד אחרי אתחול של המארח', 'The virtual computer starts by itself after the host reboots')}</span></label><p class="settings-description">${state.enabled ? tr('המתג פועל באתחול הבא, ולא מפעיל עכשיו מחשב כבוי. כדי להפעיל מחשב כבוי, לחצו על הפעלה למעלה.', 'This works from the next reboot, and does not start a computer that is off now. To start one that is off, press Start above.') : tr('הוא יישאר כבוי אחרי אתחול. כדי להפעיל אותו, לחצו על הפעלה למעלה.', 'It stays off after a reboot. To start it, press Start above.')}</p><p class="settings-description" role="status" data-boot-feedback></p>`;
    const box = node.querySelector('#computer-boot');
    box.onchange = async () => {
      box.disabled = true;
      try {
        show({
          available: true,
          ...(await api('/api/computer-boot', { enabled: box.checked }, 'PATCH')),
        });
        node.querySelector('[data-boot-feedback]').textContent = tr(
          'ההגדרה נשמרה',
          'Setting saved',
        );
      } catch (error) {
        box.checked = !box.checked;
        box.disabled = false;
        node.querySelector('[data-boot-feedback]').textContent = error.message;
      }
    };
  };
  api('/api/computer-boot')
    .then(show)
    .catch(() => {
      node.hidden = true;
    });
}
