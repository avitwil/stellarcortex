import { withoutProgramOutput } from './chat-errors.js';
// Update errors arrive in English from the server and the supervisor. The owner reads them in their own language.
const CAUSES = [
  [
    /signature|does not trust|not readable|signed hash|signed size|signed for|pins no key|manifest|no valid version/,
    'הגרסה לא עברה את בדיקת האבטחה, ולכן לא הותקנה.',
    'The release failed its security check, so it was not installed.',
  ],
  [/No release is published/, 'עדיין לא פורסמה גרסה.', 'No release is published yet.'],
  [
    /no pinned release key/,
    'בהתקנה הזאת אין מפתח חתימה, ולכן היא לא יכולה להתעדכן.',
    'This installation has no signing key, so it cannot update.',
  ],
  [
    /Wait for active|work-active/,
    'יש עבודה פעילה. חכו שתסתיים ונסו שוב.',
    'Work is running. Wait for it to finish, then try again.',
  ],
  [
    /computer is being prepared/,
    'המחשב הווירטואלי בהכנה. נסו שוב כשזה יסתיים.',
    'The virtual computer is being prepared. Try again when it finishes.',
  ],
  [
    /local changes|Local source changes/,
    'יש שינויים מקומיים בהתקנה. שמרו אותם לפני העדכון.',
    'This installation has local changes. Preserve them before updating.',
  ],
  [
    /not compatible|newer updater/,
    'הגרסה הזאת דורשת התקנה מחדש. ראו את הוראות השחזור.',
    'This release needs a reinstall. See the recovery guide.',
  ],
  [
    /health|readiness|Release identity|did not stop|before activation/,
    'הגרסה החדשה לא עברה את בדיקת התקינות.',
    'The new version failed its health check.',
  ],
  [
    /Could not reach|HTTP \d|fetch failed|timed out|timeout|ENOTFOUND|ECONN|aborted/i,
    'לא הצלחנו להגיע לשרת העדכונים. בדקו את החיבור ונסו שוב.',
    'Could not reach the update server. Check the connection and try again.',
  ],
  [
    /preparation failed|npm/,
    'הכנת הגרסה נכשלה. ההתקנה הנוכחית לא השתנתה.',
    'Preparing the release failed. The current installation is unchanged.',
  ],
];
export function updateCause(message, tr) {
  const limit = /rate limit.*?(\d+) minute/.exec(message || '');
  if (limit)
    return (
      tr(
        'היו יותר מדי בדיקות עדכון. נסו שוב בעוד ',
        'Too many update checks for now. Try again in ',
      ) +
      limit[1] +
      tr(' דקות.', ' minutes.')
    );
  const hit = CAUSES.find(([pattern]) => pattern.test(message || ''));
  return hit
    ? tr(hit[1], hit[2])
    : tr('העדכון נכשל: ', 'The update failed: ') +
        (withoutProgramOutput(message, tr) || tr('סיבה לא ידועה', 'unknown cause'));
}
export const updateStage = (stage, tr) =>
  ({
    checking: tr('בודק את החתימה…', 'Checking the signature…'),
    downloading: tr('מוריד את הגרסה…', 'Downloading the release…'),
    installing: tr('מכין את הגרסה…', 'Preparing the release…'),
    system: tr('מעדכן את המחשב הווירטואלי…', 'Updating the virtual computer…'),
    restarting: tr('מגבה, מפעיל מחדש ובודק…', 'Backing up, restarting and checking…'),
  })[stage] || tr('מעדכן…', 'Updating…');
