const esc = v =>
  String(v ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function openVisualStep({
  demo,
  botId,
  source,
  frameId,
  width,
  height,
  tr = (_h, e) => e,
  onAccepted = () => {},
}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'visual-step-dialog';
  dialog.dir = tr('rtl', 'ltr');
  dialog.innerHTML = `<form><header><h2>${tr('צעד חזותי ללימוד', 'Visual teaching step')}</h2><button type="button" data-close aria-label="${tr('סגירה', 'Close')}">×</button></header><p>${tr('בחר אזור בטוח והשחר פרטים רגישים לפני יצירת תצוגה. אין צילום אוטומטי או שמירת טקסט מוקלד.', 'Select a safe area and mask sensitive details before creating a preview. No automatic recording or typed-value capture.')}</p><label>${tr('מה עושים בצעד הזה?', 'What does this step do?')}<input name="purpose" required maxlength="500"></label><label>${tr('איזה כפתור או אזור משמש יעד?', 'Which control or area is the target?')}<input name="target" required maxlength="500"></label><label>${tr('איך נוודא שהצעד הצליח?', 'What confirms success?')}<input name="expectedResult" required maxlength="500"></label><div class="actions"><button type="button" data-mode="mask">${tr('השחרת אזור', 'Mask region')}</button><button type="button" data-mode="crop">${tr('בחירת אזור צילום', 'Select capture area')}</button><button type="button" data-reset>${tr('איפוס בחירה', 'Reset selection')}</button></div><canvas tabindex="0" role="img" aria-label="${tr('בחירת אזור והשחרה במסך הסוכן', 'Select area and redaction on agent screen')}"></canvas><details><summary>${tr('גודל ומיקום האזור — גם למקלדת', 'Area size and position — keyboard accessible')}</summary><label>X<input name="x" type="number" min="0" value="0"></label><label>Y<input name="y" type="number" min="0" value="0"></label><label>${tr('רוחב', 'Width')}<input name="width" type="number" min="1" value="${width}"></label><label>${tr('גובה', 'Height')}<input name="height" type="number" min="1" value="${height}"></label><button type="button" data-mask-selected>${tr('השחרת האזור הנבחר', 'Mask selected area')}</button></details><label><input type="checkbox" name="safe" required>${tr('האזור הנבחר בטוח לצילום לאחר ההשחרות', 'The selected area is safe to capture after masking')}</label><button type="submit">${tr('יצירת תצוגה מושחרת באורח', 'Create redacted guest preview')}</button><p data-status role="status"></p><section data-review hidden><img alt="${tr('תצוגה מושחרת לבדיקה', 'Redacted preview for review')}"><label><input type="checkbox" name="reviewed">${tr('בדקתי את התמונה ולא נותר בה מידע רגיש', 'I checked the image and no sensitive information remains')}</label><button type="button" data-accept>${tr('הוספת הצעד להדגמה', 'Add step to demonstration')}</button></section></form>`;
  const style = document.createElement('style');
  style.textContent =
    '.visual-step-dialog{width:min(900px,94vw);max-height:92vh;overflow:auto;border:1px solid #60708b;border-radius:18px;background:#101a2c;color:#e9edfa;padding:22px}.visual-step-dialog::backdrop{background:#0009}.visual-step-dialog header{display:flex;justify-content:space-between}.visual-step-dialog label{display:block;margin:12px 0}.visual-step-dialog input:not([type=checkbox]){width:100%;box-sizing:border-box}.visual-step-dialog canvas,.visual-step-dialog img{width:100%;height:auto;display:block;border:1px solid #697b99;touch-action:none}.visual-step-dialog .actions{display:flex;gap:8px;flex-wrap:wrap}.visual-step-dialog button{min-height:38px}.visual-step-dialog :focus-visible{outline:2px solid #b19ae8}';
  dialog.prepend(style);
  document.body.append(dialog);
  const form = dialog.querySelector('form'),
    canvas = dialog.querySelector('canvas'),
    ctx = canvas.getContext('2d'),
    image = new Image(),
    status = dialog.querySelector('[data-status]');
  canvas.width = width;
  canvas.height = height;
  let crop = { x: 0, y: 0, width, height },
    masks = [],
    mode = 'mask',
    start = null,
    busy = false;
  const invalidate = () => {
    demo.discardCandidate();
    dialog.querySelector('[data-review]').hidden = true;
    form.elements.reviewed.checked = false;
  };
  const draw = () => {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    ctx.fillStyle = '#000';
    for (const r of masks) ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.strokeStyle = '#c5a6ff';
    ctx.lineWidth = 3;
    ctx.strokeRect(crop.x, crop.y, crop.width, crop.height);
  };
  const sync = () => {
    for (const k of ['x', 'y', 'width', 'height']) form.elements[k].value = crop[k];
  };
  const point = e => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(width - 1, Math.floor(((e.clientX - r.left) * width) / r.width))),
      y: Math.max(0, Math.min(height - 1, Math.floor(((e.clientY - r.top) * height) / r.height))),
    };
  };
  image.onload = draw;
  image.src = source;
  canvas.onpointerdown = e => {
    e.preventDefault();
    start = point(e);
    canvas.setPointerCapture(e.pointerId);
  };
  canvas.onpointerup = e => {
    if (!start) return;
    const p = point(e),
      r = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        width: Math.max(1, Math.abs(p.x - start.x)),
        height: Math.max(1, Math.abs(p.y - start.y)),
      };
    start = null;
    if (mode === 'mask') masks.push(r);
    else crop = r;
    sync();
    invalidate();
    draw();
  };
  for (const b of dialog.querySelectorAll('[data-mode]'))
    b.onclick = () => {
      mode = b.dataset.mode;
    };
  dialog.querySelector('[data-reset]').onclick = () => {
    crop = { x: 0, y: 0, width, height };
    masks = [];
    sync();
    invalidate();
    draw();
  };
  const readCrop = () => {
    const r = Object.fromEntries(
      ['x', 'y', 'width', 'height'].map(k => [k, Number(form.elements[k].value)]),
    );
    if (
      !Object.values(r).every(Number.isInteger) ||
      r.x < 0 ||
      r.y < 0 ||
      r.width < 1 ||
      r.height < 1 ||
      r.x + r.width > width ||
      r.y + r.height > height
    )
      throw Error(tr('האזור חייב להיות בתוך המסך', 'Area must be inside the screen'));
    return r;
  };
  for (const k of ['x', 'y', 'width', 'height'])
    form.elements[k].onchange = () => {
      try {
        crop = readCrop();
        invalidate();
        draw();
      } catch (e) {
        status.textContent = e.message;
      }
    };
  dialog.querySelector('[data-mask-selected]').onclick = () => {
    try {
      masks.push(readCrop());
      invalidate();
      draw();
    } catch (e) {
      status.textContent = e.message;
    }
  };
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  form.onsubmit = async e => {
    e.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true;
    try {
      crop = readCrop();
      const accepted = await demo.capture({
        botId,
        frameId,
        crop,
        masks,
        purpose: form.elements.purpose.value,
        target: form.elements.target.value,
        expectedResult: form.elements.expectedResult.value,
        safeScreenConfirmed: form.elements.safe.checked,
      });
      if (!accepted) return;
      dialog.querySelector('[data-review] img').src =
        `data:${demo.candidate.frame.mimeType};base64,${demo.candidate.frame.image}`;
      dialog.querySelector('[data-review]').hidden = false;
      status.textContent = tr('בדוק את התצוגה לפני הוספה', 'Review the preview before adding');
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
    }
  };
  dialog.querySelector('[data-accept]').onclick = () => {
    try {
      demo.approveCandidate({ reviewedNoSecrets: form.elements.reviewed.checked });
      onAccepted();
      dialog.close();
    } catch (error) {
      status.textContent = error.message;
    }
  };
  dialog.addEventListener(
    'close',
    () => {
      demo.discardCandidate();
      canvas.width = 0;
      canvas.height = 0;
      image.src = '';
      dialog.remove();
    },
    { once: true },
  );
  dialog.showModal();
  form.elements.purpose.focus();
  return dialog;
}
