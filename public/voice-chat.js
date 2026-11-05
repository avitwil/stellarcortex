const pendingStatuses = new Set(['queued', 'running', 'waiting']);

// A call owns only the task trees it created, never the rest of a chat.
export class VoiceTaskScope {
  constructor({ chatId, botId }) {
    this.chatId = chatId;
    this.botId = botId;
    this.generation = 0;
    this.closed = false;
    this.roots = new Set();
    this.allRoots = new Set();
    this.spoken = new Set();
  }
  beginUtterance() {
    const roots = [...this.roots];
    this.roots.clear();
    return { generation: ++this.generation, roots };
  }
  current(generation) {
    return !this.closed && generation === this.generation;
  }
  accept(jobs, generation) {
    const roots = [...new Set((jobs || []).map(job => job.rootJobId || job.id).filter(Boolean))];
    for (const root of roots) this.allRoots.add(root);
    if (!this.current(generation)) return { accepted: false, roots };
    for (const root of roots) this.roots.add(root);
    return { accepted: true, roots };
  }
  owns(job) {
    return this.roots.has(job.rootJobId || job.id);
  }
  pending(jobs) {
    return (jobs || []).filter(job => this.owns(job) && pendingStatuses.has(job.status));
  }
  takeReplies(jobs, messages) {
    if (this.closed) return [];
    const replies = [];
    const ordered = [...(jobs || [])].sort((a, b) =>
      String(a.completedAt || a.createdAt || '').localeCompare(
        String(b.completedAt || b.createdAt || ''),
      ),
    );
    for (const job of ordered) {
      if (
        !this.owns(job) ||
        job.status !== 'completed' ||
        job.chatId !== this.chatId ||
        job.botId !== this.botId ||
        this.spoken.has(job.id)
      )
        continue;
      const message = (messages || [])
        .filter(
          item =>
            item.jobId === job.id &&
            item.role === 'assistant' &&
            item.chatId === this.chatId &&
            item.botId === this.botId &&
            item.text?.trim(),
        )
        .at(-1);
      if (!message) continue;
      this.spoken.add(job.id);
      replies.push({ jobId: job.id, text: message.text, generation: this.generation });
    }
    return replies;
  }
  close() {
    this.closed = true;
    this.generation++;
    return [...this.allRoots];
  }
}
