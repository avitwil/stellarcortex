// Invented sample data for the design harness. Nothing here is real.
const at = minutes => new Date(Date.UTC(2026, 0, 15, 10, minutes)).toISOString();

export function fixtureState(settings) {
  const t = (he, en) => (settings.language === 'he' ? he : en);
  const bot = (id, name, title, color, extra = {}) => ({
    id,
    provider: 'claude',
    name,
    title,
    instructions: '',
    color,
    shape: 'round',
    memory: [],
    pinned: false,
    hidden: false,
    section: '',
    createdAt: at(0),
    ...extra,
  });
  const bots = [
    bot('b-lead', t('נועה', 'Noa'), t('ראש המטה שלך', 'Your chief of staff'), 'violet', {
      pinned: true,
    }),
    bot('b-research', t('אורי', 'Uri'), t('חוקר', 'Researcher'), 'blue', {
      managerBotId: 'b-lead',
    }),
    bot('b-dev', t('מאיה', 'Maya'), t('מפתחת', 'Developer'), 'rose', { managerBotId: 'b-lead' }),
    bot('b-writer', t('טל', 'Tal'), t('כתיבה ותוכן', 'Writing'), 'mint', {
      managerBotId: 'b-lead',
    }),
  ];
  const direct = (id, b, extra = {}) => ({
    id,
    type: 'direct',
    name: b.name,
    botIds: [b.id],
    threadIds: {},
    unread: false,
    createdAt: at(0),
    ...extra,
  });
  const chats = [
    direct('c-lead', bots[0]),
    direct('c-research', bots[1]),
    direct('c-dev', bots[2], { unread: true }),
    direct('c-writer', bots[3]),
    {
      id: 'c-group',
      type: 'group',
      name: t('צוות השקה', 'Launch team'),
      botIds: ['b-lead', 'b-writer', 'b-dev'],
      threadIds: {},
      unread: false,
      createdAt: at(0),
    },
  ];
  const message = (id, chatId, role, text, minute, extra = {}) => ({
    id,
    chatId,
    role,
    text,
    createdAt: at(minute),
    ...extra,
  });
  const messages = [
    message(
      'm1',
      'c-lead',
      'user',
      t(
        'תשווי בין שלושת שירותי האחסון שבדקנו בשבוע שעבר ותמליצי על אחד לאתר החדש. חשוב לי מחיר צפוי וגיבויים.',
        'Compare the three hosting services we looked at last week and recommend one for the new site. I care about predictable pricing and backups.',
      ),
      42,
    ),
    message('m2', 'c-lead', 'tool', t('חיפוש ברשת', 'Web search'), 43, {
      kind: 'webSearch',
      status: 'completed',
      botId: 'b-lead',
      detail: JSON.stringify({ query: 'managed hosting price comparison' }),
    }),
    message(
      'm3',
      'c-lead',
      'system',
      t(
        'לאסוף מחירים עדכניים ומדיניות גיבוי לשלושת הספקים.',
        'Collect current prices and backup policies for the three providers.',
      ),
      43,
      { kind: 'team' },
    ),
    message(
      'm4',
      'c-lead',
      'assistant',
      t(
        'הנה הסיכום. בקצרה: **ספק ב׳** מתאים יותר לאתר החדש.\n\n- **ספק א׳**: הזול ביותר בהתחלה, אבל גיבוי יומי רק בתוספת תשלום.\n- **ספק ב׳**: מחיר חודשי קבוע, גיבוי יומי כלול ושחזור בלחיצה.\n- **ספק ג׳**: חזק בביצועים, אבל החיוב לפי שימוש קשה לחיזוי.\n\nאם תרצה, אכין טיוטת מייל לספק ב׳ עם השאלות שנשארו פתוחות.',
        'Here is the summary. In short, **Provider B** suits the new site best.\n\n- **Provider A**: cheapest to start, but daily backups cost extra.\n- **Provider B**: fixed monthly price, daily backups included, one-click restore.\n- **Provider C**: strong performance, but usage billing is hard to predict.\n\nI can draft an email to Provider B with the open questions if you like.',
      ),
      47,
      { botId: 'b-lead' },
    ),
    message(
      'm5',
      'c-lead',
      'user',
      t(
        'כן, תכיני טיוטה. ותשמרי את ההשוואה כקובץ בספרייה.',
        'Yes, draft it. And save the comparison as a file in the Library.',
      ),
      48,
    ),
    message(
      'm6',
      'c-research',
      'assistant',
      t('שלחתי לנועה את ההשוואה.', 'I sent the comparison to Noa.'),
      45,
      { botId: 'b-research' },
    ),
    message(
      'm7',
      'c-writer',
      'assistant',
      t('הטיוטה מוכנה לסקירה.', 'The draft is ready for review.'),
      12,
      { botId: 'b-writer' },
    ),
    message(
      'm9',
      'c-group',
      'user',
      t(
        'הדף צריך להיות מוכן עד יום חמישי. מי לוקח מה?',
        'The page has to be ready by Thursday. Who takes what?',
      ),
      4,
    ),
    message(
      'm10',
      'c-group',
      'assistant',
      t(
        'אני מרכזת. מאיה בודקת את הטבלה, וטל כותבת את הטקסט.',
        'I will coordinate. Maya checks the table, and Tal writes the copy.',
      ),
      6,
      { botId: 'b-lead' },
    ),
    message(
      'm11',
      'c-group',
      'assistant',
      t(
        'בדקתי את טבלת המחירים. שתי שורות תוקנו.',
        'I checked the pricing table. Two rows are fixed.',
      ),
      8,
      { botId: 'b-dev' },
    ),
    message(
      'm8',
      'c-group',
      'assistant',
      t('העליתי את גרסה 2 של הדף.', 'I uploaded version 2 of the page.'),
      10,
      { botId: 'b-writer' },
    ),
  ];
  const job = (id, chatId, botId, status, title, minute, extra = {}) => ({
    id,
    chatId,
    botId,
    status,
    title,
    prompt: title,
    activity: title,
    createdAt: at(minute),
    updatedAt: at(minute),
    ...extra,
  });
  const jobs = [
    job(
      'j1',
      'c-lead',
      'b-lead',
      'waiting',
      t('טיוטת מייל לספק ב׳', 'Email draft for Provider B'),
      48,
    ),
    job(
      'j2',
      'c-lead',
      'b-lead',
      'completed',
      t('השוואת ספקי אחסון', 'Hosting provider comparison'),
      42,
    ),
    job('j3', 'c-dev', 'b-dev', 'waiting', t('בניית הדף החדש', 'Build the new page'), 31),
    job(
      'j4',
      'c-research',
      'b-research',
      'running',
      t('בדיקת מדיניות גיבוי', 'Check backup policy'),
      44,
    ),
  ];
  const secret =
    settings.secret === '1'
      ? [
          {
            id: 's1',
            chatId: 'c-lead',
            botId: 'b-lead',
            jobId: 'j1',
            status: 'pending',
            kind: 'secret',
            details: {
              target: 'browser-login',
              botName: bots[0].name,
              chatName: bots[0].name,
              host: 'accounts.example.com',
              submitHost: 'login.example.net',
              https: true,
              punycode: true,
              ownerNamed: false,
              needsUsername: true,
              hasPasswordField: true,
            },
            external: true,
          },
        ]
      : [];
  const approvals = [
    ...secret,
    {
      id: 'a1',
      chatId: 'c-lead',
      botId: 'b-lead',
      jobId: 'j1',
      status: 'pending',
      kind: 'item/fileChange/requestApproval',
      details: {
        reason: t(
          'ליצור את הקובץ hosting-comparison.md בספרייה',
          'Create the file hosting-comparison.md in the Library',
        ),
      },
    },
  ];
  return {
    version: 1,
    settings: { ...settings },
    bots,
    chats,
    messages,
    jobs,
    approvals,
    routines: [],
    skills: [],
    artifacts: [],
    providerUsage: {},
    desktopProvider: null,
    guestExecutionEnabled: false,
    guestAdmissionPaused: false,
    guestUncertainRequests: [],
    workspace: '/workspace',
    runtime: { connected: true },
    providers: [{ id: 'claude', available: true }],
  };
}

export const fixtureAccount = () => ({
  connected: true,
  account: { type: 'chatgpt', email: 'demo@example.com', planType: 'plus' },
  models: [{ id: 'demo-default', model: 'demo-default', displayName: 'Default', isDefault: true }],
  usage: null,
});
export const fixtureMcp = () => [
  {
    id: 's1',
    name: 'GitHub',
    transport: 'http',
    url: 'https://mcp.example.dev/github',
    status: 'connected',
    toolCount: 14,
  },
  {
    id: 's2',
    name: 'Project files',
    transport: 'stdio',
    command: 'npx server-filesystem ./projects',
    status: 'connected',
    toolCount: 9,
  },
  {
    id: 's3',
    name: 'Notes',
    transport: 'http',
    url: 'https://mcp.example.dev/notes',
    status: 'disconnected',
  },
];
export const fixtureUpdate = () => ({
  state: 'behind',
  installed: { version: '0.1.0', commit: '3f9c2a1' },
  offered: { version: '0.1.1', commit: '9ab41c7' },
  latestRelease: { version: '0.1.0' },
  checkedAt: at(30),
  supported: false,
});
const card = (id, title, stage) => ({
  id,
  title,
  stage,
  kind: 'task',
  projectId: null,
  botIds: [],
  assignmentMode: 'stage',
  routingMode: 'manual',
  createdAt: at(0),
});
export const fixtureKanban = () => ({
  projects: [],
  cards: [
    card('k1', 'Landing page copy', 'todo'),
    card('k2', 'Pricing table', 'todo'),
    card('k3', 'Backup policy review', 'in-progress'),
    card('k4', 'Hosting comparison', 'approval'),
    card('k5', 'Team notes', 'done'),
  ],
  sessions: [],
  runs: [{ id: 'r1', cardId: 'k3', projectId: null, status: 'running', stage: 'in-progress' }],
  approvals: [],
  actionApprovals: [],
  engineJobs: [],
  general: { individual: false, bulk: false, until: null, control: 'playing' },
  executionEnabled: true,
  executionMode: 'engine',
});
