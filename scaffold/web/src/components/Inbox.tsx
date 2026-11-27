import { useCallback, useEffect, useState } from 'react';
import { api, type ConversationSummary, type Frame } from '../api';

interface Props {
  workspace: string;
  selected: string | null;
  onSelect: (contact: string) => void;
  subscribe: (l: (f: Frame) => void) => () => void;
  reloadToken: number;
  me: string;
}

const time = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString();
};

export function Inbox({ workspace, selected, onSelect, subscribe, reloadToken, me }: Props) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await api.inbox(workspace, after);
        setItems((prev) => {
          if (!after) return page.items;
          const seen = new Set(prev.map((i) => i.contact));
          return [...prev, ...page.items.filter((i) => !seen.has(i.contact))];
        });
        setCursor(page.next_cursor);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [workspace],
  );

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  useEffect(
    () =>
      subscribe((f) => {
        setItems((prev) => {
          const i = prev.findIndex((c) => c.contact === f.contact);
          const cur: ConversationSummary = i >= 0 ? prev[i]! : { contact: f.contact, assignee: null, state: 'open', last_activity_at: new Date().toISOString(), last_text: null, last_direction: null };
          let next = cur;
          let bump = false;
          switch (f.type) {
            case 'message.inbound':
              if (f.occurred_at >= cur.last_activity_at || i < 0) {
                next = { ...cur, state: 'open', last_activity_at: f.occurred_at, last_text: f.text, last_direction: 'in' };
                bump = true;
              }
              break;
            case 'message.outbound':
              next = { ...cur, last_activity_at: new Date().toISOString(), last_text: f.text, last_direction: 'out' };
              bump = true;
              break;
            case 'conversation.assigned':
              next = { ...cur, assignee: f.assignee };
              break;
            case 'conversation.state':
              next = { ...cur, state: f.state };
              break;
            default:
              return prev;
          }
          const rest = i >= 0 ? prev.filter((_, k) => k !== i) : prev;
          if (bump) return [next, ...rest];
          if (i < 0) return prev; // an assignment for a conversation not loaded yet
          const copy = [...prev];
          copy[i] = next;
          return copy;
        });
      }),
    [subscribe],
  );

  return (
    <aside className="inbox">
      <div className="pane-title">Inbox</div>
      {error && <div className="alert">Could not load the inbox: {error}</div>}
      {!loading && !error && items.length === 0 && <div className="empty">No conversations yet.</div>}
      <ul>
        {items.map((c) => (
          <li key={c.contact}>
            <button className={`conv ${c.contact === selected ? 'active' : ''}`} onClick={() => onSelect(c.contact)}>
              <div className="conv-top">
                <span className="contact">{c.contact}</span>
                <time>{time(c.last_activity_at)}</time>
              </div>
              <div className="snippet">
                {c.last_direction === 'out' && <span className="muted">You: </span>}
                {c.last_text ?? <span className="muted">No messages</span>}
              </div>
              <div className="conv-badges">
                <span className={`badge state-${c.state}`}>{c.state}</span>
                {c.assignee ? <span className={`badge ${c.assignee === me ? 'mine' : 'held'}`}>{c.assignee === me ? 'you' : c.assignee}</span> : <span className="badge unassigned">unassigned</span>}
              </div>
            </button>
          </li>
        ))}
      </ul>
      {cursor && (
        <button className="btn ghost more" disabled={loading} onClick={() => void load(cursor)}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </aside>
  );
}
