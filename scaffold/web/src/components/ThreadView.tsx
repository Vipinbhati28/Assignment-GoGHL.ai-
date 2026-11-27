import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, byOccurredAt, laterStatus, type Frame, type Message, type Role, type Thread } from '../api';
import { Composer } from './Composer';
import { StatusBadge } from './StatusBadge';

interface Props {
  workspace: string;
  contact: string;
  me: string;
  role: Role;
  subscribe: (l: (f: Frame) => void) => () => void;
  reloadToken: number;
}

const sameMessage = (a: Message, b: Message) => (a.direction === 'in' ? a.message_id === b.message_id : a.client_ref === b.client_ref);

/** Adds or merges one message, keeping order and never moving status backwards. */
function upsert(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.direction === m.direction && sameMessage(x, m));
  if (i < 0) return [...list, m].sort(byOccurredAt);
  const cur = list[i]!;
  const copy = [...list];
  copy[i] = { ...cur, ...m, occurred_at: cur.occurred_at, status: m.status ? laterStatus(cur.status, m.status) : cur.status, local: m.local };
  return copy;
}

export function ThreadView({ workspace, contact, me, role, subscribe, reloadToken }: Props) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const t = await api.thread(workspace, contact);
      // keep optimistic replies the server hasn't returned yet
      setThread((prev) => {
        let msgs = t.messages;
        for (const m of prev?.contact === contact ? prev.messages : []) if (m.local) msgs = upsert(msgs, m);
        return { ...t, messages: msgs };
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspace, contact]);

  useEffect(() => {
    setThread(null);
    setNotice(null);
  }, [workspace, contact]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  useEffect(
    () =>
      subscribe((f) => {
        if (f.contact !== contact) return;
        setThread((t) => {
          if (!t) return t;
          switch (f.type) {
            case 'message.inbound':
              return { ...t, state: 'open', messages: upsert(t.messages, { direction: 'in', message_id: f.message_id, client_ref: null, text: f.text, occurred_at: f.occurred_at, author: null }) };
            case 'message.outbound':
              return { ...t, messages: upsert(t.messages, { direction: 'out', message_id: null, client_ref: f.client_ref, text: f.text, occurred_at: new Date().toISOString(), status: f.status, author: null }) };
            case 'message.status':
              return {
                ...t,
                messages: t.messages.map((m) =>
                  m.direction === 'out' && m.client_ref === f.client_ref ? { ...m, status: laterStatus(m.status, f.status), message_id: f.message_id ?? m.message_id } : m,
                ),
              };
            case 'conversation.assigned':
              return { ...t, assignee: f.assignee };
            case 'conversation.state':
              return { ...t, state: f.state };
          }
        });
      }),
    [subscribe, contact],
  );

  const count = thread?.messages.length ?? 0;
  // Block body on purpose: scrollIntoView() returns a Promise in current
  // browsers, and an effect may only return a cleanup function.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  const send = async (text: string, ref: string = crypto.randomUUID()) => {
    const optimistic: Message = { direction: 'out', message_id: null, client_ref: ref, text, occurred_at: new Date().toISOString(), status: 'queued', author: me, local: 'sending' };
    setThread((t) => (t ? { ...t, messages: upsert(t.messages, optimistic) } : t));
    try {
      await api.reply(workspace, contact, text, ref);
      setThread((t) => (t ? { ...t, messages: t.messages.map((m) => (m.client_ref === ref ? { ...m, local: undefined } : m)) } : t));
    } catch {
      setThread((t) => (t ? { ...t, messages: t.messages.map((m) => (m.client_ref === ref ? { ...m, local: 'error' } : m)) } : t));
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice(e instanceof ApiError && e.status === 409 ? 'Another agent already holds this conversation.' : `That did not work: ${(e as Error).message}`);
      void load();
    } finally {
      setBusy(false);
    }
  };

  if (error) return <section className="thread"><div className="alert">Could not load the conversation: {error}</div></section>;
  if (!thread) return <section className="thread"><div className="empty">Loading…</div></section>;

  const mine = thread.assignee === me;
  const canRelease = mine || (thread.assignee && role === 'admin');
  const open = thread.state === 'open';

  return (
    <section className="thread">
      <div className="thread-head">
        <div>
          <div className="contact big">{thread.contact}</div>
          <div className="muted small">
            {thread.assignee ? (mine ? 'Assigned to you' : `Assigned to ${thread.assignee}`) : 'Unassigned'} · <span className={`badge state-${thread.state}`}>{thread.state}</span>
          </div>
        </div>
        <div className="actions">
          {canRelease ? (
            <button className="btn" disabled={busy} onClick={() => act(() => api.release(workspace, contact))}>
              Release
            </button>
          ) : (
            <button className="btn primary" disabled={busy || !!thread.assignee} onClick={() => act(() => api.claim(workspace, contact))}>
              Claim
            </button>
          )}
          <button className="btn" disabled={busy} onClick={() => act(() => api.setState(workspace, contact, !open))}>
            {open ? 'Close' : 'Reopen'}
          </button>
        </div>
      </div>
      {notice && (
        <div className="alert" role="alert">
          {notice} <button className="link" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}
      <div className="messages">
        {thread.messages.length === 0 && <div className="empty">No messages yet. Write the first one below.</div>}
        {thread.messages.map((m) => (
          <div key={(m.direction === 'in' ? m.message_id : m.client_ref) ?? Math.random()} className={`msg ${m.direction}`}>
            <div className="bubble">{m.text}</div>
            <div className="meta">
              {m.direction === 'out' && m.author && <span>{m.author === me ? 'You' : m.author} · </span>}
              <time>{new Date(m.occurred_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
              {m.direction === 'out' && (
                <>
                  {' '}
                  <StatusBadge message={m} />
                  {m.local === 'error' && (
                    <button className="link" onClick={() => void send(m.text, m.client_ref!)}>
                      Retry
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      <Composer onSend={(text) => void send(text)} />
    </section>
  );
}
