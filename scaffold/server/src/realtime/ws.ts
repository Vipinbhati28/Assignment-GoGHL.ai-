import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { loadSession, roleIn } from '../auth/sessions.js';
import { getSubscriber, keys } from '../redis.js';
import { currentSeq, framesAfter, type Frame } from './events.js';

// How long to wait for a missing seq before asking MongoDB for it. Two
// instances can publish 42 before 41; this keeps each socket in order.
const GAP_WAIT_MS = 300;

class Client {
  lastSent = 0;
  buffer: Frame[] | null = []; // live frames held while the replay runs
  pending = new Map<number, Frame>();
  gapTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly socket: WebSocket,
    readonly workspace: string,
  ) {}

  private write(f: Frame) {
    if (f.seq <= this.lastSent) return;
    this.lastSent = f.seq;
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(f));
  }

  deliver(f: Frame) {
    if (this.buffer) return void this.buffer.push(f);
    if (f.seq <= this.lastSent) return;
    if (f.seq === this.lastSent + 1) {
      this.write(f);
      this.flushContiguous();
      return;
    }
    this.pending.set(f.seq, f);
    if (!this.gapTimer) this.gapTimer = setTimeout(() => void this.fillGap(), GAP_WAIT_MS);
  }

  private flushContiguous() {
    let next: Frame | undefined;
    while ((next = this.pending.get(this.lastSent + 1))) {
      this.pending.delete(next.seq);
      this.write(next);
    }
    if (!this.pending.size && this.gapTimer) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  // A seq that never shows up was burnt by a crash: send what exists and move on.
  private async fillGap() {
    this.gapTimer = null;
    if (!this.pending.size) return;
    const upTo = Math.max(...this.pending.keys());
    try {
      for (const f of await framesAfter(this.workspace, this.lastSent, upTo)) this.pending.set(f.seq, f);
    } catch (e) {
      console.error('[ws] gap fill failed', e);
    }
    for (const seq of [...this.pending.keys()].sort((a, b) => a - b)) {
      this.write(this.pending.get(seq)!);
      this.pending.delete(seq);
    }
  }

  /** Replay everything after `after`, then release buffered live frames. */
  async start(after: number | null) {
    const head = await currentSeq(this.workspace);
    // A client ahead of us (e.g. after a data reset) starts from where we are.
    this.lastSent = after === null ? head : Math.min(after, head);
    if (after !== null) for (const f of await framesAfter(this.workspace, this.lastSent)) this.write(f);
    const buffered = this.buffer ?? [];
    this.buffer = null;
    for (const f of buffered.sort((a, b) => a.seq - b.seq)) this.deliver(f);
  }

  close() {
    if (this.gapTimer) clearTimeout(this.gapTimer);
  }
}

const clients = new Map<string, Set<Client>>();

function reject(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export async function attachWebSockets(server: Server): Promise<void> {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  // One pattern subscription per instance; frames from every instance arrive here.
  const sub = getSubscriber();
  await sub.psubscribe(keys.eventsPattern);
  sub.on('pmessage', (_pattern, channel, message) => {
    const ws = channel.slice('events:'.length);
    const set = clients.get(ws);
    if (!set?.size) return;
    let frame: Frame;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    for (const c of set) c.deliver(frame);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') return reject(socket, 404, 'Not Found');
      const workspace = url.searchParams.get('workspace') ?? '';
      const afterRaw = url.searchParams.get('after');
      const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : null;

      const session = await loadSession(req).catch(() => null);
      if (!session) return reject(socket, 401, 'Unauthorized');
      if (!workspace || !roleIn(session, workspace)) return reject(socket, 403, 'Forbidden');

      wss.handleUpgrade(req, socket, head, (sock) => {
        const client = new Client(sock, workspace);
        let set = clients.get(workspace);
        if (!set) clients.set(workspace, (set = new Set()));
        set.add(client); // register before replay so nothing slips between query and live
        let alive = true;
        sock.on('pong', () => (alive = true));
        const ping = setInterval(() => {
          if (!alive) return sock.terminate();
          alive = false;
          sock.ping();
        }, 30_000);
        sock.on('close', () => {
          clearInterval(ping);
          client.close();
          set!.delete(client);
        });
        sock.on('error', () => sock.terminate());
        sock.send(JSON.stringify({ type: 'hello', workspace, user: session.sub }));
        client.start(after).catch((e) => {
          console.error('[ws] replay failed', e);
          sock.close(1011, 'replay failed');
        });
      });
    })().catch((e) => {
      console.error('[ws] upgrade failed', e);
      reject(socket, 500, 'Internal Server Error');
    });
  });
}
