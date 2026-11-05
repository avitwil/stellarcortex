// Usage errors arrive as provider text. The owner reads what to do, in their own language.
export function usageErrorText(error, tr) {
  return /auth|sign[- ]?in|log[- ]?in|credential|\b401\b/i.test(error)
    ? tr('היכנסו לחשבון של הספק כדי לראות את השימוש.', 'Sign in to this provider to see its usage.')
    : tr(
        'לא הצלחנו לקרוא את נתוני השימוש. נסו לרענן.',
        'Could not read the usage data. Try refreshing.',
      );
}
