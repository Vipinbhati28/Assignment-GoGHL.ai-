// Types and calls mirror scaffold/server/src/http/{auth,api}.ts exactly.

export type Role = 'admin' | 'agent';
export interface Me {
  sub: string;
  name: string | null;
  email: string | null;
  workspaces: Array<{ id: string; role: Role }>;
}

export type Status = 'queued' | 'sent' | 'delivered' | 'failed';

export interface ConversationSummary {
  contact: string;
  assignee: string | null;
  state: 'open' | 'closed';
  last_activity_at: string;
  last_text: string | null;
  last_direction: 'in' | 'out' | null;
}

export interface InboxPage {
  items: ConversationSummary[];
  next_cursor: string | null;
}

export interface Message {
  direction: 'in' | 'out';
  message_id: string | null;
  client_ref: string | null;
  text: string;
  occurred_at: string;
  status?: Status;
  author: string | null;
  local?: 'sending' | 'error'; // only on optimistic, not-yet-acknowledged replies
}

export interface Thread {
  contact: string;
  assignee: string | null;
  state: 'open' | 'closed';
  messages: Message[];
}

// Frames from GET /ws (see server realtime/events.ts emitters).
export type Frame =
  | { seq: number; type: 'message.inbound'; contact: string; message_id: string; text: string; occurred_at: string }
  | { seq: number; type: 'message.outbound'; contact: string; client_ref: string; text: string; status: Status }
  | { seq: number; type: 'message.status'; contact: string; client_ref: string; status: Status; message_id: string | null }
  | { seq: number; type: 'conversation.assigned'; contact: string; assignee: string | null }
  | { seq: number; type: 'conversation.state'; contact: string; state: 'open' | 'closed' };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

const q = (workspace: string, extra: Record<string, string | undefined> = {}) => {
  const p = new URLSearchParams({ workspace });
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  return p.toString();
};
const conv = (contact: string) => `/api/conversations/${encodeURIComponent(contact)}`;

export const api = {
  me: () => call<Me>('/api/me'),
  logout: () => fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }),
  inbox: (workspace: string, cursor?: string) => call<InboxPage>(`/api/conversations?${q(workspace, { cursor, limit: '25' })}`),
  thread: (workspace: string, contact: string) => call<Thread>(`${conv(contact)}?${q(workspace)}`),
  reply: (workspace: string, contact: string, text: string, client_ref: string) =>
    call<{ client_ref: string; status: Status }>(`${conv(contact)}/reply?${q(workspace)}`, { method: 'POST', body: JSON.stringify({ text, client_ref }) }),
  claim: (workspace: string, contact: string) => call<{ result: string }>(`${conv(contact)}/claim?${q(workspace)}`, { method: 'POST' }),
  release: (workspace: string, contact: string) => call<{ ok: boolean }>(`${conv(contact)}/release?${q(workspace)}`, { method: 'POST' }),
  setState: (workspace: string, contact: string, open: boolean) => call<{ ok: boolean }>(`${conv(contact)}/${open ? 'reopen' : 'close'}?${q(workspace)}`, { method: 'POST' }),
};

const RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, failed: 2 };
/** Same rule as the server: status never moves backwards. */
export const laterStatus = (cur: Status | undefined, inc: Status): Status => ((RANK[inc] ?? 0) > (RANK[cur ?? 'queued'] ?? 0) ? inc : (cur ?? inc));

export const byOccurredAt = (a: Message, b: Message) =>
  a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : (a.message_id ?? '') < (b.message_id ?? '') ? -1 : 1;
