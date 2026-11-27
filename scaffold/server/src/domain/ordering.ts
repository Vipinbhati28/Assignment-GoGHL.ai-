// Pure rules shared by storage, snapshot and UI. No I/O, so they are unit-tested directly.

export const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, failed: 2 };

/**
 * Status only moves forward: queued < sent < delivered|failed. Returns the
 * status to keep. Out-of-order (delivered before sent), duplicate and
 * unknown statuses never move it backwards, and the first final status wins.
 */
export function nextStatus(current: string, incoming: string): string {
  const cur = STATUS_RANK[current] ?? 0;
  const inc = STATUS_RANK[incoming];
  if (inc === undefined) return current;
  return inc > cur ? incoming : current;
}

export interface Orderable {
  occurred_at: Date | string;
  pigeon_id: string | null;
}

/** Thread order: when it happened at the provider, then message id. Never arrival order. */
export function compareMessages(a: Orderable, b: Orderable): number {
  const ta = new Date(a.occurred_at).getTime();
  const tb = new Date(b.occurred_at).getTime();
  if (ta !== tb) return ta - tb;
  const ia = a.pigeon_id ?? '';
  const ib = b.pigeon_id ?? '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}
