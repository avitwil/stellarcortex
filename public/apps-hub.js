import { withoutProgramOutput } from './chat-errors.js';
import {
  GOOGLE_SERVICES,
  MCP_TRANSPORTS,
  MCP_AUTH_TYPES,
  mcpConnectionDraft,
  mcpConnectionPayload,
  commandArguments,
  oauthAuthorizationUrl,
  selectedServices,
  safeMcpConnection,
  safeGoogleStatus,
} from './connection-hub.js';

const escape = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const byId = id => document.getElementById(id);

export class AppsHub {
  constructor({ api, tr, modal, toast, icon, isVisible }) {
    Object.assign(this, { api, tr, modal, toast, icon, isVisible });
    this.connections = [];
    this.google = null;
    this.loaded = false;
    this.loading = false;
    this.error = '';
    this.busy = new Set();
    this.authorization = new Map();
    this.message = '';
    this.googleDraft = null;
    this.googleDirty = false;
    window.addEventListener('focus', () => {
      if (this.isVisible() || this.authorization.size) this.load();
    });
  }
  plainError(text) {
    return withoutProgramOutput(text, (he, en) => this.tr(he, en));
  }
  mount(container) {
    this.container = container;
    this.render();
    if (!this.loaded && !this.loading) void this.load();
  }
  invalidate() {
    this.loaded = false;
    if (this.isVisible()) void this.load();
  }
  async load() {
    if (this.loading) {
      this.reloadRequested = true;
      return;
    }
    this.loading = true;
    this.render();
    const results = await Promise.allSettled([
      this.api('/api/mcp/connections'),
      this.api('/api/google/status'),
    ]);
    this.mcpStale = results[0].status === 'rejected';
    this.googleStale = results[1].status === 'rejected';
    if (results[0].status === 'fulfilled') {
      this.connections = Array.isArray(results[0].value.connections)
        ? results[0].value.connections.map(safeMcpConnection)
        : [];
      this.mcpRedirectUri = results[0].value.redirectUri || '';
    }
    if (results[1].status === 'fulfilled') {
      this.google = safeGoogleStatus(results[1].value);
      if (this.google.connected) this.message = '';
      if (!this.googleDirty)
        this.googleDraft = {
          services: selectedServices(
            this.google.services?.length
              ? this.google.services
              : GOOGLE_SERVICES.map(item => item.id),
            GOOGLE_SERVICES,
          ),
          readOnly: this.google.readOnly !== false,
        };
    }
    this.error = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason.message)
      .join(' · ');
    for (const record of [
      ...this.connections,
      ...(this.google ? [{ ...this.google, id: 'google' }] : []),
    ])
      if (record.status === 'connected' || record.connected === true)
        this.authorization.delete(record.id);
    this.loading = false;
    this.loaded = true;
    this.render();
    if (this.reloadRequested) {
      this.reloadRequested = false;
      void this.load();
    }
  }
  label(status) {
    return (
      {
        connected: this.tr('מחובר', 'Connected'),
        connecting: this.tr('מתחבר…', 'Connecting…'),
        'authorization-required': this.tr('ממתין לאישור כניסה', 'Awaiting sign-in'),
        error: this.tr('שגיאת חיבור', 'Connection error'),
        unknown: this.tr('המצב אינו עדכני', 'Status unavailable'),
        disconnected: this.tr('לא מחובר', 'Not connected'),
      }[status] || this.tr('לא מחובר', 'Not connected')
    );
  }
  authLink(id) {
    const url = this.authorization.get(id);
    if (!url) return '';
    return (
      '<div class="hub-auth-pending"><p>' +
      this.tr(
        'השלם את הכניסה בחלון שנפתח, ואז חזור לכאן ורענן.',
        'Complete sign-in in the opened window, then return here and refresh.',
      ) +
      '</p><a class="secondary" href="' +
      escape(url) +
      '" target="_blank" rel="noopener noreferrer">' +
      this.tr('המשך לחיבור', 'Continue sign-in') +
      ' ↗</a><small dir="ltr">' +
      escape(new URL(url).host) +
      '</small></div>'
    );
  }
  render() {
    if (!this.container || !this.isVisible()) return;
    const t = this.tr,
      google = this.google,
      draft = this.googleDraft || {
        services: GOOGLE_SERVICES.map(item => item.id),
        readOnly: true,
      },
      googleBusy = this.busy.has('google'),
      connected = google?.connected === true && !this.googleStale;
    const googleStatus = this.googleStale
      ? 'unknown'
      : connected
        ? 'connected'
        : this.authorization.has('google')
          ? 'authorization-required'
          : 'disconnected';
    this.container.innerHTML =
      '<div class="page app-hub"><div class="page-intro"><div><h1>' +
      t('האפליקציות של הצוות שלך', 'Your team’s apps') +
      '</h1><p>' +
      t(
        'חבר שירותים וכלים ישירות ל־StellarCortex, לשימוש הבוטים שלך.',
        'Connect services and tools directly to StellarCortex for your bots to use.',
      ) +
      '</p></div><button class="secondary" id="hub-refresh" ' +
      (this.loading ? 'disabled' : '') +
      '>' +
      this.icon('activity') +
      t(this.loading ? 'מרענן…' : 'רענון', this.loading ? 'Refreshing…' : 'Refresh') +
      '</button></div>' +
      (this.error ? '<p class="notice error" role="alert">' + escape(this.error) + '</p>' : '') +
      (this.returnResult === 'error'
        ? '<p class="notice error" role="alert">' +
          t(
            'הכניסה לא הושלמה. בדוק את פרטי החיבור ונסה להתחבר שוב.',
            'Sign-in did not complete. Review the connection settings and try connecting again.',
          ) +
          '</p>'
        : '') +
      (this.message ? '<p class="notice" role="status">' + escape(this.message) + '</p>' : '') +
      '<section class="hub-card hub-google"><div class="hub-card-heading"><span class="hub-google-mark" aria-hidden="true">G</span><div><h2>Google</h2><p>' +
      t(
        'דואר, קבצים, מסמכים ויומן במקום אחד.',
        'Mail, files, documents and calendar in one place.',
      ) +
      '</p></div><span class="hub-status ' +
      googleStatus +
      '">' +
      this.label(googleStatus) +
      '</span></div>' +
      (google?.email || google?.account?.email
        ? '<p class="hub-account" dir="auto">' +
          escape(google.email || google.account.email) +
          '</p>'
        : '') +
      '<fieldset class="hub-services" ' +
      (googleBusy ? 'disabled' : '') +
      '><legend>' +
      t('בחר שירותים לחיבור', 'Choose services to connect') +
      '</legend>' +
      GOOGLE_SERVICES.map(
        service =>
          '<label><input type="checkbox" data-google-service="' +
          service.id +
          '" ' +
          (draft.services.includes(service.id) ? 'checked' : '') +
          '><span><strong>' +
          service.name +
          '</strong><small>' +
          t(
            service.he,
            {
              gmail: 'Mail',
              drive: 'Files',
              docs: 'Documents',
              sheets: 'Spreadsheets',
              calendar: 'Events',
              contacts: 'People',
            }[service.id],
          ) +
          '</small></span></label>',
      ).join('') +
      '</fieldset>' +
      '<label class="hub-readonly"><input id="hub-google-readonly" type="checkbox" ' +
      (draft.readOnly ? 'checked' : '') +
      ' ' +
      (googleBusy ? 'disabled' : '') +
      '><span>' +
      t('גישה לקריאה בלבד', 'Read-only access') +
      '<small>' +
      t(
        'כבה כדי לבקש גם הרשאות כתיבה בשירותים שנבחרו.',
        'Turn off to request write permissions for the selected services.',
      ) +
      '</small></span></label>' +
      (!google?.configured
        ? '<p class="hub-description">' +
          t(
            'בהתקנה עצמאית מגדירים פעם אחת אפליקציית OAuth משלך ב־Google Cloud. לאחר מכן הכניסה מתבצעת במסך ההרשאות הרגיל של Google.',
            'A self-hosted installation needs your own Google Cloud OAuth app configured once. Sign-in then uses Google’s regular consent screen.',
          ) +
          '</p>'
        : '') +
      (this.googleDirty
        ? '<p class="hub-description">' +
          t(
            'שינוי השירותים או הרשאות הכתיבה דורש אישור חיבור מחדש.',
            'Changing services or write permissions requires renewed consent.',
          ) +
          '</p>'
        : '') +
      (google?.error
        ? '<p class="error hub-description">' + escape(this.plainError(google.error)) + '</p>'
        : '') +
      '<div class="actions"><button class="primary" id="hub-google-connect" ' +
      (!google || googleBusy ? 'disabled' : '') +
      '>' +
      t(
        googleBusy
          ? 'מתחבר…'
          : !google?.configured
            ? 'הגדרת Google'
            : connected && !this.googleDirty
              ? 'חיבור מחדש'
              : 'התחברות ל־Google',
        googleBusy
          ? 'Connecting…'
          : !google?.configured
            ? 'Set up Google'
            : connected && !this.googleDirty
              ? 'Reconnect'
              : 'Connect Google',
      ) +
      '</button>' +
      (connected
        ? '<button class="secondary" id="hub-google-tools">' +
          t('הכלים הזמינים', 'Available tools') +
          (Number.isFinite(google.toolCount) ? ' · ' + google.toolCount : '') +
          '</button><button class="secondary" id="hub-google-disconnect" ' +
          (googleBusy ? 'disabled' : '') +
          '>' +
          t('ניתוק', 'Disconnect') +
          '</button>'
        : '') +
      '<button class="hub-text-button" id="hub-google-setup" ' +
      (!google || googleBusy ? 'disabled' : '') +
      '>' +
      t('הגדרות OAuth', 'OAuth setup') +
      '</button></div>' +
      this.authLink('google') +
      '</section>' +
      '<div class="hub-section-heading"><div><h2>' +
      t('שרתי MCP', 'MCP servers') +
      '</h2><p>' +
      t(
        'חיבורים לשירותים נוספים דרך שרת מרוחק או תהליך מקומי.',
        'Connect more services through a remote server or local process.',
      ) +
      '</p></div><button class="secondary" id="hub-add-server">' +
      this.icon('plus') +
      t('הוספת שרת', 'Add server') +
      '</button></div><div class="hub-server-grid">' +
      this.connections.map(record => this.serverCard(record)).join('') +
      '</div>' +
      (!this.connections.length
        ? '<div class="hub-empty">' +
          this.icon('grid') +
          '<strong>' +
          t('החיבור הבא שלך מתחיל כאן', 'Your next connection starts here') +
          '</strong><p>' +
          t(
            'הוסף שרת MCP, התחבר אליו וראה אילו כלים הוא מציע לבוטים.',
            'Add an MCP server, connect, and see the tools it offers your bots.',
          ) +
          '</p></div>'
        : '') +
      '</div>';
    byId('hub-refresh').onclick = () => {
      this.returnResult = '';
      void this.load();
    };
    byId('hub-add-server').onclick = () => this.serverForm();
    byId('hub-google-setup').onclick = () => this.googleSetup();
    byId('hub-google-connect').onclick = () =>
      google?.configured ? this.connectGoogle() : this.googleSetup();
    byId('hub-google-disconnect')?.addEventListener('click', () =>
      this.perform('google', async () => {
        await this.api('/api/google/disconnect', {});
        this.authorization.delete('google');
        this.googleDirty = false;
        await this.load();
      }),
    );
    byId('hub-google-tools')?.addEventListener('click', () =>
      this.inspectTools('google', 'Google'),
    );
    this.container.querySelectorAll('[data-google-service]').forEach(
      field =>
        (field.onchange = () => {
          const selected = field.dataset.googleService;
          this.googleDraft = {
            ...draft,
            services: [...this.container.querySelectorAll('[data-google-service]:checked')].map(
              item => item.dataset.googleService,
            ),
          };
          this.googleDirty = true;
          this.render();
          this.container.querySelector('[data-google-service="' + selected + '"]')?.focus();
        }),
    );
    byId('hub-google-readonly').onchange = event => {
      this.googleDraft = { ...draft, readOnly: event.target.checked };
      this.googleDirty = true;
      this.render();
      byId('hub-google-readonly')?.focus();
    };
    this.container.querySelectorAll('[data-hub-action]').forEach(
      button =>
        (button.onclick = () => {
          const record = this.connections.find(item => item.id === button.dataset.connection);
          if (!record) return;
          const action = button.dataset.hubAction;
          if (action === 'connect') void this.connectServer(record);
          if (action === 'edit') this.serverForm(record);
          if (action === 'tools') void this.inspectTools(record.id, record.name);
          if (action === 'delete') this.deleteServer(record);
          if (action === 'disconnect')
            void this.perform(record.id, async () => {
              await this.api(
                '/api/mcp/connections/' + encodeURIComponent(record.id) + '/disconnect',
                {},
              );
              this.authorization.delete(record.id);
              await this.load();
            });
        }),
    );
  }
  serverCard(record) {
    const t = this.tr,
      id = escape(record.id),
      busy = this.busy.has(record.id),
      connected = record.status === 'connected' && !this.mcpStale,
      button = (action, label, kind = 'secondary') =>
        '<button class="' +
        kind +
        '" data-hub-action="' +
        action +
        '" data-connection="' +
        id +
        '" ' +
        (busy ? 'disabled' : '') +
        '>' +
        label +
        '</button>';
    return (
      '<section class="hub-card hub-server"><div class="hub-card-heading"><span class="hub-server-icon">' +
      this.icon('link') +
      '</span><div><h3>' +
      escape(record.name) +
      '</h3><p>' +
      escape(
        record.transport === 'stdio'
          ? t('תהליך מקומי', 'Local process')
          : record.transport === 'sse'
            ? 'SSE'
            : 'Streamable HTTP',
      ) +
      '</p></div><span class="hub-status ' +
      (connected ? 'connected' : record.status === 'error' ? 'error' : '') +
      '">' +
      escape(this.label(busy ? 'connecting' : this.mcpStale ? 'unknown' : record.status)) +
      '</span></div><code class="hub-destination" dir="ltr">' +
      escape(record.transport === 'stdio' ? record.command : record.url) +
      '</code>' +
      (record.error
        ? '<p class="hub-description error">' + escape(this.plainError(record.error)) + '</p>'
        : '') +
      (connected
        ? '<p class="hub-description">' +
          (Number.isFinite(record.toolCount)
            ? record.toolCount + ' ' + t('כלים התקבלו מהשרת', 'tools reported by the server')
            : t('מחובר; רשימת הכלים זמינה לבדיקה', 'Connected; inspect its available tools')) +
          '</p>'
        : '') +
      '<div class="actions">' +
      button(
        'connect',
        t(connected ? 'חיבור מחדש' : 'התחברות', connected ? 'Reconnect' : 'Connect'),
        connected ? 'secondary' : 'primary',
      ) +
      (connected
        ? button('tools', t('הצגת כלים', 'View tools')) +
          button('disconnect', t('ניתוק', 'Disconnect'))
        : '') +
      button('edit', t('עריכה', 'Edit')) +
      button('delete', t('מחיקה', 'Delete'), 'hub-text-button danger-text') +
      '</div>' +
      this.authLink(record.id) +
      '</section>'
    );
  }
  async perform(id, work) {
    if (this.busy.has(id)) return;
    this.busy.add(id);
    this.error = '';
    this.render();
    try {
      await work();
    } catch (error) {
      this.error = error.message;
      this.toast(error.message);
    } finally {
      this.busy.delete(id);
      this.render();
    }
  }
  popup() {
    try {
      const popup = window.open('about:blank', '_blank', 'popup,width=640,height=760');
      if (popup) popup.opener = null;
      return popup;
    } catch {
      return null;
    }
  }
  authorize(id, result, popup) {
    const url = oauthAuthorizationUrl(result?.authorizationUrl);
    if (result?.authorizationUrl && !url) {
      popup?.close();
      throw new Error(
        this.tr(
          'השרת החזיר כתובת כניסה שאינה נתמכת.',
          'The server returned an unsupported sign-in URL.',
        ),
      );
    }
    if (url) {
      this.authorization.set(id, url);
      if (popup && !popup.closed) popup.location.href = url;
    } else popup?.close();
  }
  async connectServer(record, popup) {
    if (this.busy.has(record.id)) {
      popup?.close();
      return;
    }
    this.returnResult = '';
    if (record.authType === 'oauth' && !popup) popup = this.popup();
    await this.perform(record.id, async () => {
      try {
        const result = await this.api(
          '/api/mcp/connections/' + encodeURIComponent(record.id) + '/connect',
          {},
        );
        this.authorize(record.id, result, popup);
        await this.load();
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  }
  async connectGoogle() {
    if (this.busy.has('google')) return;
    this.returnResult = '';
    const draft = this.googleDraft || { services: [], readOnly: true };
    if (!draft.services.length) {
      this.toast(this.tr('בחר לפחות שירות אחד.', 'Choose at least one service.'));
      return;
    }
    const popup = this.popup();
    await this.perform('google', async () => {
      try {
        if (this.googleDirty) await this.api('/api/google/config', draft, 'PATCH');
        const result = await this.api('/api/google/connect', {});
        this.googleDirty = false;
        this.authorize('google', result, popup);
        await this.load();
      } catch (error) {
        popup?.close();
        throw error;
      }
    });
  }
  googleSetup() {
    const t = this.tr,
      g = this.google || {},
      redirect = g.redirectUri || '';
    this.modal(
      t('הגדרת חיבור Google', 'Google connection setup'),
      '<form id="hub-google-form" autocomplete="off"><p class="hub-description">' +
        t(
          'צור פרויקט ב־Google Cloud, הגדר את מסך ההסכמה, הפעל את ה־APIs של השירותים שבחרת וצור OAuth Client מסוג Web application. במצב Testing הוסף את חשבון Google שלך כמשתמש בדיקה.',
          'Create a Google Cloud project, configure the consent screen, enable the APIs for your selected services, and create a Web application OAuth client. In Testing mode, add your Google account as a test user.',
        ) +
        '</p><a class="secondary" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer">Google Cloud Console ↗</a><label>' +
        t(
          'Authorized redirect URI — יש לרשום בדיוק את הכתובת הזאת',
          'Authorized redirect URI — register this exact address',
        ) +
        '</label><code class="hub-redirect" dir="ltr">' +
        escape(
          redirect ||
            t(
              'הכתובת אינה זמינה. רענן את החיבור לשרת.',
              'Address unavailable. Refresh the server connection.',
            ),
        ) +
        '</code><label for="hub-google-client">OAuth Client ID</label><input id="hub-google-client" name="clientId" required dir="ltr" value="' +
        escape(g.clientId || '') +
        '" autocomplete="off"><label for="hub-google-secret">OAuth Client secret</label><input id="hub-google-secret" name="clientSecret" type="password" data-connection-secret dir="ltr" autocomplete="new-password" placeholder="' +
        t(
          g.hasClientSecret ? 'סוד שמור — ריק משאיר אותו ללא שינוי' : 'הדבק את סוד הלקוח',
          g.hasClientSecret ? 'Secret saved — leave blank to keep it' : 'Paste the client secret',
        ) +
        '" ' +
        (!g.hasClientSecret ? 'required' : '') +
        '><p class="hub-description">' +
        t(
          'הסוד נשמר בשרת StellarCortex בלבד. החלפת Client ID דורשת גם את הסוד המתאים לו.',
          'The secret is stored only on the StellarCortex server. Changing the Client ID requires its matching secret.',
        ) +
        '</p><p class="error" id="hub-google-form-error" role="alert"></p><div class="actions"><button class="primary" ' +
        (!redirect ? 'disabled' : '') +
        '>' +
        t('שמירת ההגדרות', 'Save setup') +
        '</button></div></form>',
    );
    const form = byId('hub-google-form');
    form.onsubmit = async event => {
      event.preventDefault();
      const clientId = form.elements.clientId.value.trim(),
        secret = form.elements.clientSecret.value.trim();
      if (g.hasClientSecret && g.clientId !== clientId && !secret) {
        byId('hub-google-form-error').textContent = t(
          'הזן את הסוד המתאים ל־Client ID החדש.',
          'Enter the matching secret for the new Client ID.',
        );
        return;
      }
      const payload = { clientId, ...this.googleDraft };
      if (secret) payload.clientSecret = secret;
      form.elements.clientSecret.value = '';
      form.querySelector('button').disabled = true;
      try {
        await this.api('/api/google/config', payload, 'PATCH');
        this.googleDirty = false;
        if (form.isConnected) byId('modal').close();
        this.message = t(
          'ההגדרות נשמרו. לחץ על התחברות ל־Google כדי לאשר גישה.',
          'Setup saved. Select Connect Google to authorize access.',
        );
        await this.load();
      } catch (error) {
        if (form.isConnected)
          form.querySelector('#hub-google-form-error').textContent = error.message;
      } finally {
        if (form.isConnected) form.querySelector('button').disabled = false;
      }
    };
  }
  async inspectTools(id, name) {
    this.modal(
      this.tr('כלים של ', 'Tools from ') + name,
      '<p class="hub-description">' +
        this.tr('טוען את הכלים שהחיבור מספק…', 'Loading the tools reported by this connection…') +
        '</p>',
      true,
    );
    const body = byId('modal-body'),
      loadingNode = body.firstElementChild;
    const current = () => byId('modal').open && body.firstElementChild === loadingNode;
    try {
      const result = await this.api(
        id === 'google'
          ? '/api/google/tools'
          : '/api/mcp/connections/' + encodeURIComponent(id) + '/tools',
      );
      if (!current()) return;
      body.innerHTML =
        '<p class="hub-description">' +
        this.tr(
          'אלה שמות ותיאורי הכלים שהתקבלו מהחיבור.',
          'These tool names and descriptions were reported by the connection.',
        ) +
        '</p><div class="hub-tool-list">' +
        (result.tools || [])
          .map(
            tool =>
              '<details><summary><code dir="ltr">' +
              escape(tool.name) +
              '</code></summary><p dir="auto">' +
              escape(tool.description || '') +
              '</p>' +
              (tool.inputSchema
                ? '<pre>' + escape(JSON.stringify(tool.inputSchema, null, 2)) + '</pre>'
                : '') +
              '</details>',
          )
          .join('') +
        '</div>' +
        (!(result.tools || []).length
          ? '<p class="notice">' +
            this.tr(
              'החיבור לא דיווח על כלים זמינים.',
              'The connection did not report any available tools.',
            ) +
            '</p>'
          : '');
    } catch (error) {
      if (current()) body.innerHTML = '<p class="error">' + escape(error.message) + '</p>';
    }
  }
  deleteServer(record) {
    this.modal(
      this.tr('מחיקת חיבור', 'Delete connection'),
      '<p>' +
        this.tr('למחוק את החיבור ', 'Delete the connection ') +
        escape(record.name) +
        '?</p><p class="hub-description">' +
        this.tr(
          'החיבור וההגדרות השמורות שלו יוסרו מ־StellarCortex.',
          'This connection and its saved configuration will be removed from StellarCortex.',
        ) +
        '</p><div class="actions"><button id="hub-delete-confirm" class="danger">' +
        this.tr('מחיקת החיבור', 'Delete connection') +
        '</button><button id="hub-delete-cancel" class="secondary">' +
        this.tr('ביטול', 'Cancel') +
        '</button></div>',
    );
    byId('hub-delete-cancel').onclick = () => byId('modal').close();
    byId('hub-delete-confirm').onclick = () => {
      byId('modal').close();
      void this.perform(record.id, async () => {
        await this.api(
          '/api/mcp/connections/' + encodeURIComponent(record.id),
          undefined,
          'DELETE',
        );
        this.authorization.delete(record.id);
        await this.load();
      });
    };
  }
  serverForm(record = null, draft = mcpConnectionDraft(record || {})) {
    const t = this.tr,
      stdio = draft.transport === 'stdio',
      oauth = draft.authType === 'oauth',
      manual = ['bearer', 'header'].includes(draft.authType);
    const options = (values, selected, labels) =>
      values
        .map(
          value =>
            '<option value="' +
            value +
            '" ' +
            (value === selected ? 'selected' : '') +
            '>' +
            escape(labels[value] || value) +
            '</option>',
        )
        .join('');
    this.modal(
      t(record ? 'עריכת שרת MCP' : 'הוספת שרת MCP', record ? 'Edit MCP server' : 'Add MCP server'),
      '<form id="hub-mcp-form" autocomplete="off"><label for="hub-mcp-name">' +
        t('שם החיבור', 'Connection name') +
        '</label><input id="hub-mcp-name" name="name" required maxlength="100" value="' +
        escape(draft.name) +
        '"><label for="hub-mcp-transport">' +
        t('סוג החיבור', 'Transport') +
        '</label><select id="hub-mcp-transport" name="transport">' +
        options(MCP_TRANSPORTS, draft.transport, {
          'streamable-http': 'Streamable HTTP',
          sse: 'SSE',
          stdio: t('תהליך מקומי · stdio', 'Local process · stdio'),
        }) +
        '</select>' +
        (stdio
          ? '<label for="hub-mcp-command">' +
            t('פקודה או נתיב לקובץ הפעלה', 'Command or executable path') +
            '</label><input id="hub-mcp-command" name="command" dir="ltr" required value="' +
            escape(draft.command) +
            '"><label for="hub-mcp-args">' +
            t('ארגומנטים — אחד בכל שורה או מערך JSON', 'Arguments — one per line or a JSON array') +
            '</label><textarea id="hub-mcp-args" name="args" dir="ltr">' +
            escape(JSON.stringify(draft.args, null, 2)) +
            '</textarea><p class="hub-description">' +
            t(
              'התהליך מופעל על השרת של StellarCortex, עם הרשאות משתמש השרת. הפקודה צריכה להיות מותקנת בסביבה הזאת. העבר סודות דרך משתני סביבה ולא בתוך ארגומנטים.',
              'The process runs on the StellarCortex host with the host user’s permissions. The command must be installed there. Pass secrets through environment variables rather than arguments.',
            ) +
            '</p><details class="settings-advanced"><summary>' +
            t('תיקיית עבודה ומשתני סביבה', 'Working directory and environment') +
            '</summary><label for="hub-mcp-cwd">' +
            t('תיקיית עבודה — אופציונלי', 'Working directory — optional') +
            '</label><input id="hub-mcp-cwd" name="cwd" dir="ltr" value="' +
            escape(draft.cwd) +
            '"><label for="hub-mcp-env">' +
            t(
              'משתני סביבה כ־JSON — ערכים אינם מוצגים',
              'Environment as JSON — values are never displayed',
            ) +
            '</label><input id="hub-mcp-env" name="env" type="password" data-connection-secret autocomplete="new-password" dir="ltr" placeholder="' +
            escape('{"API_KEY":"…"}') +
            '"><p class="hub-description">' +
            t(
              'ריק משאיר משתנים שמורים. {} מוחק אותם.',
              'Leave blank to preserve saved variables. {} clears them.',
            ) +
            (record?.envKeys?.length
              ? ' ' + t('שמות שמורים: ', 'Saved names: ') + escape(record.envKeys.join(', '))
              : '') +
            '</p></details>'
          : '<label for="hub-mcp-url">' +
            t('כתובת שרת MCP', 'MCP server URL') +
            '</label><input id="hub-mcp-url" name="url" type="url" required dir="ltr" value="' +
            escape(draft.url) +
            '"><label for="hub-mcp-auth">' +
            t('התחברות', 'Authentication') +
            '</label><select id="hub-mcp-auth" name="authType">' +
            options(MCP_AUTH_TYPES, draft.authType, {
              none: t('ללא', 'None'),
              bearer: 'Bearer token',
              header: t('מפתח בכותרת מותאמת', 'Custom header key'),
              oauth: 'OAuth',
            }) +
            '</select>' +
            (manual
              ? (draft.authType === 'header'
                  ? '<label for="hub-mcp-header">' +
                    t('שם הכותרת', 'Header name') +
                    '</label><input id="hub-mcp-header" name="headerName" dir="ltr" required value="' +
                    escape(draft.headerName) +
                    '" placeholder="X-API-Key">'
                  : '') +
                '<label for="hub-mcp-token">' +
                t('מפתח / אסימון', 'Key / token') +
                '</label><input id="hub-mcp-token" name="token" type="password" data-connection-secret autocomplete="new-password" dir="ltr" ' +
                (!record?.hasToken ? 'required' : '') +
                ' placeholder="' +
                t(
                  record?.hasToken ? 'אסימון שמור — ריק משאיר אותו ללא שינוי' : 'הדבק אסימון',
                  record?.hasToken ? 'Token saved — leave blank to keep it' : 'Paste token',
                ) +
                '"><p class="hub-description">' +
                t(
                  'שינוי יעד החיבור או שיטת האימות דורש מפתח מתאים חדש.',
                  'Changing the destination or authentication method requires a matching replacement key.',
                ) +
                '</p>'
              : '') +
            (oauth
              ? '<details class="settings-advanced"><summary>' +
                t('פרטי OAuth — אם השרת דורש', 'OAuth details — if required by the server') +
                '</summary>' +
                (this.mcpRedirectUri
                  ? '<label>Redirect URI</label><code class="hub-redirect" dir="ltr">' +
                    escape(this.mcpRedirectUri) +
                    '</code>'
                  : '') +
                '<label for="hub-mcp-client">Client ID</label><input id="hub-mcp-client" name="oauthClientId" dir="ltr" value="' +
                escape(draft.oauthClientId) +
                '"><label for="hub-mcp-client-secret">Client secret</label><input id="hub-mcp-client-secret" name="oauthClientSecret" type="password" data-connection-secret autocomplete="new-password" dir="ltr" placeholder="' +
                t(
                  record?.hasClientSecret ? 'סוד שמור — ריק משאיר אותו' : 'אופציונלי',
                  record?.hasClientSecret ? 'Secret saved — leave blank to keep it' : 'Optional',
                ) +
                '">' +
                (record?.hasClientSecret
                  ? '<label class="hub-readonly"><input name="removeClientSecret" type="checkbox"><span>' +
                    t('מחיקת סוד הלקוח השמור', 'Remove the saved client secret') +
                    '</span></label>'
                  : '') +
                '<label for="hub-mcp-scopes">' +
                t('Scopes — לפי תיעוד השרת', 'Scopes — from the server documentation') +
                '</label><input id="hub-mcp-scopes" name="oauthScope" dir="ltr" value="' +
                escape(draft.oauthScope) +
                '"><p class="hub-description">' +
                t(
                  'שרתים שתומכים ברישום אוטומטי אינם דורשים הזנת Client ID מראש. ההרשאה תתבצע אצל ספק השירות.',
                  'Servers supporting automatic registration do not require a preconfigured Client ID. Authorization takes place with the service provider.',
                ) +
                '</p></details>'
              : '')) +
        '<p class="error" id="hub-mcp-error" role="alert"></p><div class="actions"><button class="primary" type="submit">' +
        t('שמירה וחיבור', 'Save & connect') +
        '</button><button class="secondary" type="button" id="hub-mcp-cancel">' +
        t('ביטול', 'Cancel') +
        '</button></div></form>',
      true,
    );
    const form = byId('hub-mcp-form'),
      read = () =>
        mcpConnectionDraft({
          ...draft,
          name: form.elements.name.value,
          transport: form.elements.transport.value,
          ...(stdio
            ? {
                command: form.elements.command.value,
                args: commandArguments(form.elements.args.value),
                cwd: form.elements.cwd.value,
              }
            : {
                url: form.elements.url.value,
                authType: form.elements.authType.value,
                headerName: form.elements.headerName?.value || '',
                oauthClientId: form.elements.oauthClientId?.value || '',
                oauthScope: form.elements.oauthScope?.value || '',
              }),
        });
    const change = () => {
      try {
        this.serverForm(record, read());
      } catch (error) {
        byId('hub-mcp-error').textContent = this.formError(error);
      }
    };
    form.elements.transport.onchange = change;
    if (form.elements.authType) form.elements.authType.onchange = change;
    byId('hub-mcp-cancel').onclick = () => byId('modal').close();
    form.onsubmit = async event => {
      event.preventDefault();
      let payload;
      try {
        const values = read();
        payload = mcpConnectionPayload(values, {
          token: form.elements.token?.value,
          oauthClientSecret: form.elements.oauthClientSecret?.value,
          env: form.elements.env?.value,
          removeToken:
            !!record?.hasToken &&
            (values.transport === 'stdio' || !['bearer', 'header'].includes(values.authType)),
          removeClientSecret:
            form.elements.removeClientSecret?.checked === true ||
            (!!record?.hasClientSecret &&
              (values.transport === 'stdio' || values.authType !== 'oauth')),
        });
        if (payload.oauthClientSecret && payload.removeClientSecret)
          throw new Error('secret-replace-or-remove');
        if (
          record?.hasClientSecret &&
          payload.authType === 'oauth' &&
          (record.url !== payload.url || record.oauthClientId !== payload.oauthClientId) &&
          !payload.oauthClientSecret &&
          !payload.removeClientSecret
        )
          throw new Error('replacement-client-secret');
        if (
          record?.hasToken &&
          ['bearer', 'header'].includes(payload.authType) &&
          (record.url !== payload.url || record.authType !== payload.authType) &&
          !payload.token
        )
          throw new Error('replacement-token');
      } catch (error) {
        byId('hub-mcp-error').textContent = this.formError(error);
        return;
      }
      form.querySelectorAll('[data-connection-secret]').forEach(input => (input.value = ''));
      const popup = payload.authType === 'oauth' ? this.popup() : null;
      form.querySelector('button[type=submit]').disabled = true;
      try {
        const result = await this.api(
            '/api/mcp/connections' + (record ? '/' + encodeURIComponent(record.id) : ''),
            payload,
            record ? 'PATCH' : 'POST',
          ),
          saved = result.connection || result;
        if (form.isConnected) byId('modal').close();
        await this.load();
        await this.connectServer(saved, popup);
      } catch (error) {
        popup?.close();
        if (form.isConnected) form.querySelector('#hub-mcp-error').textContent = error.message;
        else this.toast(error.message);
      } finally {
        if (form.isConnected) form.querySelector('button[type=submit]').disabled = false;
      }
    };
  }
  formError(error) {
    return (
      {
        'secret-replace-or-remove': this.tr(
          'בחר החלפה או מחיקה של הסוד השמור, לא את שתיהן.',
          'Choose either secret replacement or removal, not both.',
        ),
        'replacement-client-secret': this.tr(
          'הזן את סוד הלקוח המתאים לכתובת או ל־Client ID החדשים, או בחר למחוק אותו.',
          'Enter the matching client secret for the new URL or Client ID, or choose to remove it.',
        ),
        'arguments-json': this.tr(
          'מערך הארגומנטים אינו JSON תקין.',
          'Arguments must be valid JSON.',
        ),
        'arguments-array': this.tr(
          'ארגומנטים חייבים להיות מערך של מחרוזות.',
          'Arguments must be an array of strings.',
        ),
        'environment-json': this.tr(
          'משתני הסביבה חייבים להיות JSON תקין.',
          'Environment must be valid JSON.',
        ),
        'environment-object': this.tr(
          'משתני הסביבה חייבים להיות אובייקט JSON עם ערכי טקסט.',
          'Environment must be a JSON object with string values.',
        ),
        'replacement-token': this.tr(
          'הזן אסימון חדש עבור כתובת היעד או שיטת האימות החדשה.',
          'Enter a replacement token for the new destination or authentication method.',
        ),
      }[error.message] || error.message
    );
  }
}
