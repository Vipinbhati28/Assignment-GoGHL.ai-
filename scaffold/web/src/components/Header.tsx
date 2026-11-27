import type { Me } from '../api';
import type { Connection } from '../useRealtime';

interface Props {
  me: Me;
  workspace: string;
  onWorkspace: (id: string) => void;
  connection: Connection;
  onLogout: () => void;
}

const LABEL: Record<Connection, string> = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' };

export function Header({ me, workspace, onWorkspace, connection, onLogout }: Props) {
  const role = me.workspaces.find((w) => w.id === workspace)?.role;
  return (
    <header className="topbar">
      <strong className="brand">Switchboard</strong>
      <label className="ws-switch">
        <span className="sr-only">Workspace</span>
        <select value={workspace} onChange={(e) => onWorkspace(e.target.value)} disabled={me.workspaces.length < 2}>
          {me.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.id}
            </option>
          ))}
        </select>
      </label>
      <span className={`conn conn-${connection}`} title="Real-time connection">
        <span className="dot" /> {LABEL[connection]}
      </span>
      <span className="spacer" />
      <span className="who">
        {me.name ?? me.sub} {role && <span className={`badge role-${role}`}>{role}</span>}
      </span>
      <button className="btn ghost" onClick={onLogout}>
        Sign out
      </button>
    </header>
  );
}
