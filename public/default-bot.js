// The server stores the first bot's title once, but the owner can change language at any time.
const TITLE = ['ראש המטה שלך', 'Your chief of staff'];
export function localizeDefaultBots(bots, tr) {
  for (const bot of bots) if (TITLE.includes(bot.title)) bot.title = tr(...TITLE);
  return bots;
}
