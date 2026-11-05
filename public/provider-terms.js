// Beside every provider sign-in. It states no provider's terms, which can change: it sends the owner to read them.
const MORE = {
  he: 'https://github.com/avitwil/stellarcortex/blob/main/README.he.md#provider-terms',
  en: 'https://github.com/avitwil/stellarcortex#provider-terms',
};
export const providerTermsNote = tr =>
  `<p class="settings-description provider-terms">${tr('לפני החיבור בדקו את תנאי השימוש העדכניים של הספק. האחריות לעמוד בהם היא שלכם. תנאים יכולים להשתנות, וחיבור עלול להפסיק לעבוד. StellarCortex הוא פרויקט עצמאי ואינו קשור לאף ספק.', 'Before you connect, check the provider’s current terms of use. You are responsible for complying with them. Terms can change, and a connection may stop working. StellarCortex is independent and is not affiliated with any provider.')} <a href="${tr(MORE.he, MORE.en)}" target="_blank" rel="noopener noreferrer">${tr('מידע נוסף', 'Read more')}</a></p>`;
