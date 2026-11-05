// What the computer tab says when there is no screen to show.
export function computerEmptyState({ computer, provider, mode, tr }) {
  if (computer === 'vm' && !provider)
    return {
      title: tr('המחשב הווירטואלי לא זמין', 'The virtual computer is not available'),
      text: tr(
        'הבוט מוגדר למחשב וירטואלי, אבל בהתקנה הזו לא מוגדר מחשב כזה. אפשר להכין אותו לפי deployment/ubuntu-desktop/README.md, או לבחור מצב אחר בהגדרות > מחשב.',
        'This bot is set to a virtual computer, but none is configured on this installation. Prepare one with deployment/ubuntu-desktop/README.md, or choose another mode in Settings > Computer.',
      ),
      modes: false,
    };
  if (computer === 'none' && mode === 'desktop')
    return {
      title: tr('לבוט הזה אין מחשב', 'This bot has no computer'),
      text: tr(
        'אפשר להגדיר לו מחשב בהגדרות > מחשב. גם בלי מחשב הוא יכול להשתמש בדפדפן.',
        'You can set one in Settings > Computer. Without one, it can still use the browser.',
      ),
      modes: true,
    };
  return null;
}
export const COMPUTER_STAGES = [
  ['download', 'מוריד את אובונטו', 'Downloading Ubuntu'],
  ['prepare', 'מכין את ההתקנה', 'Preparing the installation'],
  ['install', 'מתקין את אובונטו', 'Installing Ubuntu'],
  ['first-boot', 'מסיים הפעלה ראשונה', 'Finishing its first start'],
];
export function computerBuildText(build, tr) {
  const stage = COMPUTER_STAGES.find(([id]) => id === build.stage),
    name = stage ? tr(stage[1], stage[2]) : '';
  return (
    tr('המחשב הווירטואלי נבנה ברקע: ', 'The virtual computer is building in the background: ') +
    name +
    (build.percent == null ? '' : ` ${build.percent}%`) +
    tr(
      ` (שלב ${build.step} מתוך ${build.steps}). השיחה עובדת גם בינתיים.`,
      ` (step ${build.step} of ${build.steps}). You can chat in the meantime.`,
    )
  );
}
// What stopped the build, and what to do. The raw detail stays out of this text.
export function computerFailureText(code, tr) {
  return (
    {
      memory: tr(
        'אין מספיק זיכרון פנוי במארח. סגרו תוכנות ונסו שוב.',
        'The host has too little free memory. Close some programs and try again.',
      ),
      disk: tr(
        'אין מספיק מקום פנוי בדיסק: נדרשים 90 GiB. פנו מקום ונסו שוב.',
        'There is too little free disk space: it needs 90 GiB. Free some space and try again.',
      ),
      kvm: tr(
        'וירטואליזציה (KVM) לא זמינה במארח. הפעילו אותה ב־BIOS ונסו שוב.',
        'Virtualization (KVM) is not available on the host. Turn it on in the BIOS and try again.',
      ),
      download: tr(
        'הורדת אובונטו נכשלה. בדקו את החיבור לאינטרנט ונסו שוב. ההורדה תמשיך מאותה נקודה.',
        'Downloading Ubuntu failed. Check the internet connection and try again. The download goes on from where it stopped.',
      ),
      signature: tr(
        'לא ניתן היה לאמת את החתימה של אובונטו, ולכן שום דבר לא הותקן. נסו שוב בעוד כמה דקות.',
        'Ubuntu’s signature could not be verified, so nothing was installed. Try again in a few minutes.',
      ),
      iso: tr(
        'קובץ ההתקנה לא מתאים: נדרש Ubuntu Server 26.04 או חדש יותר.',
        'The installation file does not fit: it must be Ubuntu Server 26.04 or later.',
      ),
      'browser-hash': tr(
        'הדפדפן שהורד לא תואם לגיבוב הקבוע שלו, ולכן לא הותקן. ייתכן שהקובץ שונה בדרך. בדקו את הרשת לפני שתנסו שוב.',
        'The downloaded browser does not match its pinned hash, so it was not installed. The file may have been changed on the way. Check your network before you try again.',
      ),
      'first-boot': tr(
        'ההפעלה הראשונה של המחשב נעצרה, בדרך כלל בגלל בעיה ברשת שלו. נסו שוב.',
        'The computer’s first start stopped, usually because of a network problem. Try again.',
      ),
      timeout: tr(
        'הבנייה לקחה יותר משעתיים. בדקו את החיבור לאינטרנט ונסו שוב.',
        'The build took over two hours. Check the internet connection and try again.',
      ),
      interrupted: tr(
        'הבנייה נקטעה, למשל באתחול של המארח. נסו שוב.',
        'The build was cut off, for example by a host reboot. Try again.',
      ),
    }[code] ||
    tr(
      'הבנייה נעצרה. נסו שוב. הפרטים הטכניים למטה.',
      'The build stopped. Try again. The technical details are below.',
    )
  );
}
// Why an install finished with no computer. The app works without one.
export function computerInstallText(code, tr) {
  return (
    {
      platform: tr(
        'המארח הזה לא מריץ לינוקס 64 ביט של אינטל או AMD.',
        'This host is not 64-bit Intel or AMD Linux.',
      ),
      kvm: tr(
        'אין במארח KVM. הפעילו וירטואליזציה ב־BIOS, והריצו שוב את ההתקנה.',
        'This host has no KVM. Turn on virtualization in the BIOS, then run the install again.',
      ),
      memory: tr(
        'אין במארח מספיק זיכרון: נדרשים 10 GiB.',
        'This host has too little memory: it needs 10 GiB.',
      ),
      disk: tr(
        'אין מספיק מקום: נדרשים 90 GiB פנויים.',
        'There is too little disk space: it needs 90 GiB free.',
      ),
      apt: tr(
        'המחשב הווירטואלי נתמך רק ב־Debian ו־Ubuntu.',
        'The virtual computer is supported only on Debian and Ubuntu.',
      ),
      systemd: tr('במארח הזה אין systemd.', 'This host has no systemd.'),
      root: tr(
        'שלב ההרשאות של ההתקנה לא הושלם. ודאו שלמשתמש יש sudo, והריצו שוב את ההתקנה.',
        'The root step of the install did not finish. Check that your user has sudo, then run the install again.',
      ),
      node: tr(
        'Node.js ו־npm לא מותקנים לכל המערכת. התקינו אותם כך, והריצו שוב את ההתקנה.',
        'Node.js and npm are not installed system-wide. Install them that way, then run the install again.',
      ),
      firewall: tr(
        'לא אישרתם גישה דרך חומת האש, ולכן שום דבר לא השתנה. כדי להוסיף מחשב, הריצו שוב את ההתקנה.',
        'You did not allow access through the firewall, so nothing changed. To add a computer, run the install again.',
      ),
    }[code] ||
    tr(
      'בהתקנה הזו אין מחשב וירטואלי. כל השאר עובד, והבוטים פועלים בלי מחשב.',
      'This installation has no virtual computer. Everything else works, and bots run with no computer.',
    )
  );
}
// What the virtual computer is doing now, for the status list.
export function computerStateLabel(build, tr) {
  if (!build) return tr('בודק…', 'Checking…');
  return (
    {
      ready: tr('פועל', 'Running'),
      'allocation-available': tr('פועל', 'Running'),
      stopped: tr('כבוי', 'Off'),
      starting: tr('מופעל…', 'Starting…'),
      building: tr('נבנה', 'Building'),
      unreachable: tr('לא עונה', 'Not answering'),
    }[build.state] || tr('לא מוכן', 'Not ready')
  );
}
export function computerSetupText(setup, tr) {
  const preparing = tr(
    'מכין את שולחן העבודה של הבוט. זה ייקח כמה שניות.',
    'Preparing this bot’s desktop. This takes a few seconds.',
  );
  if (setup.state === 'building') return computerBuildText(setup, tr);
  if (setup.state === 'failed')
    return (
      computerFailureText(setup.code, tr) +
      ' ' +
      tr('אפשר לנסות שוב בהגדרות > מחשב.', 'You can retry in Settings > Computer.')
    );
  return (
    {
      stopped:
        setup.code === 'start-failed'
          ? tr(
              'המחשב הווירטואלי לא עלה. נסו שוב, או ראו את הוראות השחזור במסמכים.',
              'The virtual computer did not start. Try again, or see the recovery guide in the docs.',
            )
          : tr(
              'המחשב הווירטואלי כבוי. אפשר להפעיל אותו בהגדרות > מחשב.',
              'The virtual computer is off. You can start it in Settings > Computer.',
            ),
      starting: tr('מפעיל את המחשב הווירטואלי…', 'Starting the virtual computer…'),
      'allocation-available': preparing,
      removing: preparing,
      applying: preparing,
      'not-started': tr(
        'בניית המחשב הווירטואלי לא התחילה. אפשר להתחיל אותה בהגדרות > מחשב.',
        'Building the virtual computer has not started. You can start it in Settings > Computer.',
      ),
      unreachable: tr(
        'שירות המחשב לא עונה. השיחה עובדת, ונבדוק שוב בעוד רגע.',
        'The computer service is not answering. Chat still works, and this checks again shortly.',
      ),
      'setup-required': tr(
        'בהתקנה הזו אין מחשב וירטואלי. אפשר לראות למה בהגדרות > מחשב.',
        'This installation has no virtual computer. Settings > Computer says why.',
      ),
      'access-disabled': tr(
        'הגישה למחשב כבויה לבוט הזה. אפשר לשנות זאת בהגדרות > מחשב.',
        'Computer access is off for this bot. You can change it in Settings > Computer.',
      ),
      'needs-attention': tr(
        'הכנת שולחן העבודה של הבוט נעצרה. מחקו את הבוט וצרו אותו שוב.',
        'Preparing this bot’s desktop stopped. Delete the bot and create it again.',
      ),
      blocked: tr(
        'המחשב לא מוכן עדיין. הבוט יקבל את שולחן העבודה שלו לבד, כשהמחשב יהיה מוכן.',
        'The computer is not ready yet. The bot gets its desktop by itself when it is.',
      ),
      'session-limit': tr(
        'לבוט הזה אין שולחן עבודה: אין במחשב הווירטואלי מקום לעוד אחד. השיחה עובדת כרגיל, והבוט יקבל שולחן עבודה כשבוט אחר יימחק. בוט שרק הועבר ממחשב וירטואלי שומר על המקום שלו.',
        'This bot has no desktop: the virtual computer has no room for another one. The chat works as usual, and the bot gets a desktop when another bot is deleted. A bot only moved off the virtual computer keeps its place.',
      ),
    }[setup.state] || preparing
  );
}
export function desktopConnectionText(value, tr) {
  return (
    {
      connecting: tr('מתחבר…', 'Connecting…'),
      observing: tr('צפייה', 'Watching'),
      controlling: tr('בשליטתך', 'You’re in control'),
      'waiting-for-control': tr('מבקש שליטה…', 'Requesting control…'),
      disconnected: tr('החיבור נותק. אפשר לחבר מחדש.', 'Disconnected. You can reconnect.'),
      'configuration-error': tr(
        'הגדרות התצוגה של המחשב שגויות.',
        'The computer’s display settings are wrong.',
      ),
    }[value] || value
  );
}
// The server's text names the commands to run, so it stays after the short explanation.
export function desktopFailureText(machine, message, tr) {
  return machine && machine !== 'running'
    ? tr('המחשב הווירטואלי לא פועל. ', '') + message
    : message;
}
