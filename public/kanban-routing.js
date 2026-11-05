export const ROLE_NAMES = {
  research: 'Research / specification',
  development: 'Development',
  testing: 'Validation',
  maintenance: 'Maintenance',
  coordination: 'Coordination',
  email: 'Email',
  calendar: 'Calendar',
  files: 'Files',
  general: 'General-purpose',
};
const patterns = {
  research: /(?:research|analyst|specification|מחקר|אפיון|מנתח מערכות)/iu,
  development:
    /(?:develop(?:er|ment)?|programmer|software engineer|coding|פיתוח|מפתח|מתכנת|תכנות)/iu,
  testing: /(?:test(?:er|ing)?|quality assurance|\bqa\b|בדיקות|בודק|בדיקה|אימות)/iu,
  maintenance:
    /(?:maintenance|sysadmin|system administrator|troubleshoot|repair|אחזק|תחזוק|תקלות)/iu,
  email: /(?:e-?mail|gmail|inbox|מייל|דואר)/iu,
  calendar: /(?:calendar|יומן|לוח שנה)/iu,
  files: /(?:file manager|document manager|ניהול קבצים|ניהול מסמכים)/iu,
  general:
    /(?:general[- ]purpose|general assistant|general agent|chief of staff|עוזר כללי|משימות כלליות|בוט כללי|מנהל כללי)/iu,
  coordination: /(?:chief of staff|coordinator|manager|תיאום|מנהל)/iu,
};
export function botRoles(bot) {
  const explicit = Array.isArray(bot.capabilities)
    ? bot.capabilities.filter(r => Object.hasOwn(ROLE_NAMES, r))
    : [];
  const title = String(bot.title || '');
  return [
    ...new Set([
      ...explicit,
      ...Object.entries(patterns)
        .filter(([, rx]) => rx.test(title))
        .map(([role]) => role),
    ]),
  ];
}
export function roleForCard(card) {
  const stage =
    card.stage === 'idea' ? 'specification' : card.stage === 'todo' ? 'in-progress' : card.stage;
  if (stage === 'specification') return 'research';
  if (['development', 'testing'].includes(stage)) return stage;
  if (stage !== 'in-progress') return null;
  if (Object.hasOwn(ROLE_NAMES, card.taskRole)) return card.taskRole;
  const text = card.title + '\n' + (card.initialText || ''),
    roles = Object.entries(patterns)
      .filter(([, rx]) => rx.test(text))
      .map(([role]) => role);
  return roles.length === 1 ? roles[0] : null;
}
export function routingCandidates(card, projects, bots, eligible = () => ({ allowed: true })) {
  const stage =
      card.stage === 'idea' ? 'specification' : card.stage === 'todo' ? 'in-progress' : card.stage,
    p = projects.find(p => p.id === card.projectId),
    configured = p?.stages[stage]?.botIds,
    role = roleForCard(card),
    pool = bots.filter(
      b => !b.deletedAt && (!(p?.teamExplicit ?? !!p?.team.length) || p.team.includes(b.id)),
    );
  const allowed = b => eligible(b, role, card)?.allowed !== false,
    specialists = configured?.length
      ? pool.filter(b => configured.includes(b.id))
      : role
        ? pool.filter(b => botRoles(b).includes(role))
        : [],
    specialistEligible = specialists.filter(allowed);
  if (specialistEligible.length)
    return {
      role,
      candidates: specialistEligible,
      basis: configured?.length
        ? 'Explicit board stage assignment'
        : 'Specialist declared capability or role title',
      specialist: true,
    };
  const generalists = role ? pool.filter(b => botRoles(b).includes('general') && allowed(b)) : [];
  return {
    role,
    candidates: generalists,
    basis: 'General-purpose fallback; no eligible specialist exists; existing permissions retained',
    specialist: false,
    unavailable: specialists.length
      ? specialists
          .map(b => eligible(b, role, card)?.reason)
          .filter(Boolean)
          .join('; ')
      : '',
  };
}
