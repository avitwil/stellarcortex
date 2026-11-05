// Explicit visual teaching: no background screenshots or typed-text recording.
export function mountDesktopTeaching({ element, view, botId, api, tr = (_h, e) => e }) {
  const button = document.createElement('button');
  button.textContent = tr('לימוד מהמסך', 'Teach from screen');
  element.append(button);
  let dialog = null;
  button.onclick = async () => {
    if (dialog) return;
    const lease = view.lease;
    if (!lease) {
      view.onState(tr('קח שליטה לפני לימוד', 'Use desktop before teaching'));
      return;
    }
    dialog = document.createElement('dialog');
    dialog.className = 'visual-step-dialog';
    dialog.innerHTML = `<form><h2>${tr('לימוד מהמסך הנוכחי', 'Teach from the current screen')}</h2><p>${tr('הצילום נעשה רק בלחיצה. הקלדה גולמית אינה מוקלטת. לאחר עצירה אפשר להוסיף טקסט רגיל שנבדק לצעד הקלדה. אין להוסיף סיסמאות או סודות. בדוק והשחר מידע רגיש בתמונות.', 'Capture is explicit. Raw typing is not recorded. After stopping, you can add reviewed ordinary text to a typed step. Never add passwords or secrets. Review and mask images before saving.')}</p><label>${tr('תוצאה רצויה', 'Intended result')}<input name="objective" required maxlength="2000"></label><button type="button" data-capture>${tr('צילום כעת', 'Capture now')}</button><p data-status role="status"></p><section data-selection hidden><img data-source alt="Screen capture for local review" style="max-width:100%"><fieldset><legend>${tr('אזור לשמירה', 'Capture area')}</legend>${['x', 'y', 'width', 'height'].map(k => `<label>${k}<input type="number" name="${k}" min="0" required></label>`).join('')}</fieldset><label>${tr('אזורים להשחרה: בכל שורה x,y,width,height', 'Masks: one x,y,width,height rectangle per line')}<textarea name="masks"></textarea></label><label><input name="safe" type="checkbox">${tr('בדקתי את האזור ואת ההשחרות', 'I checked the capture area and masks')}</label><button type="button" data-preview>${tr('יצירת תצוגה לבדיקה', 'Create review preview')}</button></section><section data-review hidden><img data-preview-image alt="Redacted preview" style="max-width:100%"><label>${tr('שם המיומנות', 'Skill name')}<input name="name" maxlength="100"></label><label>${tr('הוראות: הסבר מטרות ואימות הצלחה, לא הרצת קואורדינטות עיוורת', 'Instructions: explain targets and success checks; never blindly replay coordinates')}<textarea name="instructions" maxlength="12000"></textarea></label><label><input name="reviewed" type="checkbox">${tr('בדקתי שלא נותר מידע רגיש ושההוראות נכונות', 'I checked that no sensitive information remains and the instructions are correct')}</label><button type="submit">${tr('שמירת מיומנות לבוט הזה', 'Save skill for this bot')}</button></section><button type="button" data-stop>${tr('עצירה ובדיקת הפעולות', 'Stop and review actions')}</button><button type="button" data-resume>${tr('המשך הדגמה', 'Continue demonstration')}</button><pre data-steps></pre><section data-text-steps></section><button type="button" data-close>${tr('סגירה', 'Close')}</button></form>`;
    (element.closest('.remote-desktop-provider') || document.body).append(dialog);
    const form = dialog.querySelector('form'),
      status = dialog.querySelector('[data-status]');
    let draft,
      frame,
      preview,
      busy = false,
      saved = false,
      reviewedDraft = null;
    const call = input => {
      if (view.lease?.connectionId !== lease.connectionId)
        throw Error(tr('השליטה השתנתה; פתח לימוד מחדש', 'Control changed; start teaching again'));
      return api(`/api/desktops/${encodeURIComponent(botId)}/teaching`, { ...input, lease });
    };
    const action = fn => async event => {
      event?.preventDefault();
      if (busy) return;
      busy = true;
      try {
        await fn();
      } catch (error) {
        status.textContent = error.message;
      } finally {
        busy = false;
      }
    };
    dialog.querySelector('[data-capture]').onclick = action(async () => {
      if (!draft) draft = await call({ action: 'start', objective: form.elements.objective.value });
      frame = await call({ action: 'capture', id: draft.id });
      preview = null;
      dialog.querySelector('[data-source]').src = `data:${frame.mimeType};base64,${frame.image}`;
      for (const k of ['x', 'y', 'width', 'height'])
        form.elements[k].value = k === 'x' || k === 'y' ? 0 : frame[k];
      dialog.querySelector('[data-selection]').hidden = false;
      dialog.querySelector('[data-review]').hidden = true;
      status.textContent = tr(
        'הצילום זמני. אם פג תוקפו, צלם שוב.',
        'Capture is temporary. Capture again if it expires.',
      );
    });
    dialog.querySelector('[data-preview]').onclick = action(async () => {
      const crop = Object.fromEntries(
        ['x', 'y', 'width', 'height'].map(k => [k, Number(form.elements[k].value)]),
      );
      const masks = form.elements.masks.value.trim()
        ? form.elements.masks.value
            .trim()
            .split('\n')
            .map(line => {
              const values = line.split(',').map(Number);
              if (values.length !== 4) throw Error('Each mask needs four numbers');
              return Object.fromEntries(
                ['x', 'y', 'width', 'height'].map((k, i) => [k, values[i]]),
              );
            })
        : [];
      preview = await call({
        action: 'preview',
        id: draft.id,
        frameId: frame.frameId,
        crop,
        masks,
        safeScreenConfirmed: form.elements.safe.checked,
      });
      dialog.querySelector('[data-source]').removeAttribute('src');
      frame = null;
      dialog.querySelector('[data-selection]').hidden = true;
      dialog.querySelector('[data-preview-image]').src =
        `data:${preview.mimeType};base64,${preview.image}`;
      dialog.querySelector('[data-review]').hidden = false;
    });
    const showReview = () => {
      dialog.querySelector('[data-steps]').textContent = reviewedDraft.instructions;
      const list = dialog.querySelector('[data-text-steps]');
      list.replaceChildren();
      reviewedDraft.steps.forEach((step, index) => {
        if (!['manual-input', 'reviewed-text'].includes(step.action)) return;
        const section = document.createElement('fieldset'),
          title = document.createElement('legend');
        title.textContent = tr('צעד טקסט', 'Text step') + ' ' + (index + 1);
        section.append(title);
        const label = document.createElement('label');
        label.textContent = tr(
          'טקסט רגיל לשימוש חוזר — לא סיסמאות או מידע פרטי',
          'Ordinary reusable text — no passwords or private information',
        );
        const value = document.createElement('textarea');
        value.maxLength = 4096;
        value.value = step.action === 'reviewed-text' ? step.text : '';
        label.append(value);
        section.append(label);
        const consent = document.createElement('label'),
          check = document.createElement('input');
        check.type = 'checkbox';
        consent.append(
          check,
          document.createTextNode(
            tr(
              'אני מאשר/ת שהטקסט אינו רגיש ויישמר במיומנות ויישלח לספק המודל בעת השימוש',
              'I confirm this text is non-sensitive and will be saved with the skill and sent to the model provider when used',
            ),
          ),
        );
        section.append(consent);
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.textContent = tr('שמירת הטקסט לצעד', 'Use this text for the step');
        apply.onclick = action(async () => {
          reviewedDraft = await call({
            action: 'review-text',
            id: draft.id,
            index,
            text: value.value,
            confirmed: check.checked,
          });
          form.elements.reviewed.checked = false;
          showReview();
        });
        section.append(apply);
        const manual = document.createElement('button');
        manual.type = 'button';
        manual.textContent = tr('בקשת קלט בכל הרצה', 'Ask for input when running');
        manual.onclick = action(async () => {
          reviewedDraft = await call({ action: 'review-text', id: draft.id, index, text: null });
          form.elements.reviewed.checked = false;
          showReview();
        });
        section.append(manual);
        list.append(section);
      });
    };
    dialog.querySelector('[data-stop]').onclick = action(async () => {
      if (!draft) throw Error('Capture a reference screen first');
      reviewedDraft = await call({ action: 'stop', id: draft.id });
      showReview();
      if (!form.elements.instructions.value)
        form.elements.instructions.value =
          form.elements.objective.value +
          '\nFollow the reviewed action outline; inspect current targets and ask for any manual-input values. Never request secrets in chat.';
      form.elements.reviewed.checked = false;
    });
    dialog.querySelector('[data-resume]').onclick = action(async () => {
      if (!draft) throw Error('Capture a reference screen first');
      if (
        !confirm(
          tr(
            'בדקת שהמסך שוב בטוח ואין קלט רגיש?',
            'Is the screen safe again, with no sensitive input?',
          ),
        )
      )
        return;
      await call({ action: 'resume', id: draft.id, safeScreenConfirmed: true });
      reviewedDraft = null;
      form.elements.reviewed.checked = false;
    });
    form.onsubmit = action(async () => {
      if (!reviewedDraft) throw Error('Stop and review the demonstrated actions before saving');
      if (!preview) throw Error('Review a visual example first');
      await call({
        action: 'review',
        id: draft.id,
        previewId: preview.previewId,
        reviewedNoSecrets: form.elements.reviewed.checked,
      });
      const skill = await call({
        action: 'save',
        id: draft.id,
        name: form.elements.name.value,
        instructions: form.elements.instructions.value,
        reviewed: form.elements.reviewed.checked,
      });
      saved = true;
      status.textContent = tr(
        'המיומנות נשמרה. השתמש בה במשימה מפורשת לבוט.',
        'Skill saved. Ask this bot to use it in an explicit task.',
      );
      form.querySelector('[type=submit]').disabled = true;
    });
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.addEventListener(
      'close',
      () => {
        if (draft && !saved)
          try {
            call({ action: 'discard', id: draft.id }).catch(() => {});
          } catch {}
        for (const img of dialog.querySelectorAll('img')) img.removeAttribute('src');
        dialog.remove();
        dialog = null;
        frame = null;
        preview = null;
      },
      { once: true },
    );
    dialog.style.cssText =
      'position:fixed;inset:auto 12px 12px auto;margin:0;width:min(440px,90vw);max-height:70vh;overflow:auto;z-index:1000';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = tr('מזעור / פתיחת הלימוד', 'Collapse / expand teaching');
    dialog.prepend(toggle);
    toggle.onclick = () => {
      form.hidden = !form.hidden;
    };
    dialog.show();
    const timer = setInterval(async () => {
      if (!draft || busy || saved || !dialog) return;
      try {
        const value = await call({ action: 'status', id: draft.id });
        if (dialog)
          status.textContent = `${value.state} · ${value.count} actions${value.reason ? ' · ' + value.reason : ''}`;
      } catch (error) {
        if (dialog) status.textContent = error.message;
      }
    }, 1000);
    dialog.addEventListener('close', () => clearInterval(timer), { once: true });
  };
  return () => {
    dialog?.close();
    button.remove();
  };
}
