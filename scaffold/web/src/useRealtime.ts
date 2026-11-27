import { useCallback, useEffect, useRef, useState } from 'react';
import type { Frame } from './api';

export type Connection = 'connecting' | 'live' | 'reconnecting';
type Listener = (f: Frame) => void;

/**
 * One socket per workspace. Remembers the highest seq it has applied and
 * reconnects with `after=<seq>` (exponential backoff), so a dropped
 * connection misses nothing. `onResync` fires when there is no seq to resume
 * from, so the caller reloads state over REST instead.
 */
export function useRealtime(workspace: string | null, onResync: () => void) {
  const [connection, setConnection] = useState<Connection>('connecting');
  const listeners = useRef(new Set<Listener>());
  const resync = useRef(onResync);
  resync.current = onResync;

  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => void listeners.current.delete(l);
  }, []);

  useEffect(() => {
    if (!workspace) return;
    let lastSeq: number | null = null;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const open = () => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const params = new URLSearchParams({ workspace });
      if (lastSeq !== null) params.set('after', String(lastSeq));
      socket = new WebSocket(`${proto}//${window.location.host}/ws?${params}`);
      socket.onopen = () => {
        attempt = 0;
        setConnection('live');
        if (lastSeq === null) resync.current();
      };
      socket.onmessage = (m) => {
        let f: Frame;
        try {
          f = JSON.parse(String(m.data));
        } catch {
          return;
        }
        if (typeof f.seq !== 'number') return; // e.g. the hello frame
        if (lastSeq !== null && f.seq <= lastSeq) return;
        lastSeq = f.seq;
        for (const l of listeners.current) l(f);
      };
      socket.onclose = () => {
        if (stopped) return;
        setConnection('reconnecting');
        const delay = Math.min(10_000, 500 * 2 ** attempt++) * (0.75 + Math.random() * 0.5);
        retry = setTimeout(open, delay);
      };
    };

    setConnection('connecting');
    open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [workspace]);

  return { connection, subscribe };
}
