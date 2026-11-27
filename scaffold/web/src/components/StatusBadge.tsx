import type { Message } from '../api';

export function StatusBadge({ message }: { message: Message }) {
  if (message.local === 'sending') return <span className="badge st-queued">sending…</span>;
  if (message.local === 'error') return <span className="badge st-failed">not saved</span>;
  const s = message.status ?? 'queued';
  return <span className={`badge st-${s}`}>{s}</span>;
}
