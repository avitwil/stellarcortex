// Model and effort descriptions come from the provider, in English. A Hebrew screen leaves them out.
export const providerText = (text, tr) =>
  tr('he', 'en') === 'he' && !/[֐-׿]/.test(text || '') ? '' : text || '';
