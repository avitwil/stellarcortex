// Owner-only HTTP routes provide redacted audit metadata, never command text.
export function mountDesktopOperations({ element, botId, api, tr = (_h, e) => e }) {
  const button = document.createElement('button');
  button.textContent = tr('פעולות ובדיקת תוצאה', 'Operations and review');
  element.append(button);
  let dialog;
  button.onclick = async () => {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'visual-step-dialog';
    const title = document.createElement('h2'),
      description = document.createElement('p'),
      status = document.createElement('p'),
      list = document.createElement('div'),
      refresh = document.createElement('button'),
      close = document.createElement('button');
    title.textContent = button.textContent;
    description.textContent = tr(
      'ביטול מבקש להפסיק עבודה; הוא אינו מבטל שינויים שכבר קרו. בדיקת פעולה לא ידועה שומרת את התיעוד ואינה מריצה אותה מחדש.',
      'Cancellation asks running work to stop; it does not undo prior effects. Reviewing an uncertain operation preserves its audit and never replays it.',
    );
    refresh.textContent = tr('רענון', 'Refresh');
    close.textContent = tr('סגירה', 'Close');
    status.setAttribute('role', 'status');
    dialog.append(title, description, status, list, refresh, close);
    document.body.append(dialog);
    close.onclick = () => dialog.close();
    dialog.addEventListener(
      'close',
      () => {
        dialog.remove();
        dialog = null;
      },
      { once: true },
    );
    dialog.showModal();
    const endpoint = `/api/desktops/${encodeURIComponent(botId)}`;
    const load = async () => {
      try {
        const data = await api(endpoint + '/operations');
        if (!dialog) return;
        list.replaceChildren();
        for (const item of data.operations.slice(-100).reverse()) {
          const row = document.createElement('section'),
            summary = document.createElement('p');
          summary.textContent = `${item.method || item.kind} · ${item.state} · ${item.requestId}`;
          row.append(summary);
          if (
            ['shell.run', 'desktop.type'].includes(item.method) &&
            ['inflight', 'uncertain'].includes(item.state)
          ) {
            const cancel = document.createElement('button');
            cancel.textContent = tr('בקשת עצירה', 'Request stop');
            cancel.onclick = async () => {
              cancel.disabled = true;
              try {
                const r = await api(endpoint + '/cancel', { targetRequestId: item.requestId });
                status.textContent = `${r.state || 'Stop requested'}; ${tr('רענן לבדיקת התוצאה', 'refresh to inspect the outcome')}`;
              } catch (e) {
                status.textContent = e.message;
              } finally {
                cancel.disabled = false;
              }
            };
            row.append(cancel);
          }
          if (item.state === 'uncertain' && !item.active) {
            const note = document.createElement('textarea'),
              label = document.createElement('label'),
              check = document.createElement('input'),
              review = document.createElement('button');
            note.placeholder = tr(
              'מה בדקת ומה התוצאה הידועה או הלא ידועה?',
              'What did you inspect, and what remains unknown?',
            );
            note.maxLength = 4000;
            check.type = 'checkbox';
            label.append(
              check,
              document.createTextNode(
                tr(
                  'בדקתי את הפעולה המסוימת ומאשר לנטוש אותה בלי הרצה מחדש',
                  'I reviewed this specific operation and approve abandoning it without replay',
                ),
              ),
            );
            review.textContent = tr('שמירת בדיקה ונטישה', 'Record review and abandon');
            review.onclick = async () => {
              if (!check.checked || !note.value.trim()) {
                status.textContent = tr(
                  'נדרשים בדיקה מפורשת והערה',
                  'Explicit review and a note are required',
                );
                return;
              }
              review.disabled = true;
              try {
                await api(endpoint + '/review', {
                  targetRequestId: item.requestId,
                  expectedDigest: item.digest,
                  note: note.value,
                  confirm: true,
                });
                await load();
                status.textContent = tr(
                  'התיעוד נשמר; הפעולה לא הורצה שוב',
                  'Audit preserved; operation was not replayed',
                );
              } catch (e) {
                status.textContent = e.message;
                review.disabled = false;
              }
            };
            row.append(note, label, review);
          }
          list.append(row);
        }
        if (!data.operations.length)
          status.textContent = tr('אין פעולות רשומות', 'No recorded operations');
      } catch (e) {
        status.textContent = e.message;
      }
    };
    refresh.onclick = load;
    await load();
  };
  return () => {
    dialog?.close();
    button.remove();
  };
}
