// For tests about host behaviour: every bot in this store, and every later one, has host control.
export function hostBots(store) {
  for (const bot of store.data.bots) bot.computer = 'host';
  const create = store.createBot.bind(store);
  store.createBot = input => {
    const made = create(input);
    made.bot.computer = 'host';
    return made;
  };
  return store;
}
