import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { Header } from './components/Header';
import { Inbox } from './components/Inbox';
import { SignIn } from './components/SignIn';
import { ThreadView } from './components/ThreadView';
import { useRealtime } from './useRealtime';

const WS_KEY = 'sb.workspace';
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
};

export function App() {
  const [me, setMe] = useState<Me | null | 'anon'>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        const saved = read(WS_KEY);
        setWorkspace(m.workspaces.find((w) => w.id === saved)?.id ?? m.workspaces[0]?.id ?? null);
      })
      .catch((e) => (e instanceof ApiError && e.status === 401 ? setMe('anon') : setError((e as Error).message)));
  }, []);

  // No seq to resume from (first connect): reload everything over REST.
  const resync = useCallback(() => setReloadToken((n) => n + 1), []);
  const { connection, subscribe } = useRealtime(me && me !== 'anon' ? workspace : null, resync);

  const switchWorkspace = (id: string) => {
    write(WS_KEY, id);
    setWorkspace(id);
    setSelected(null);
  };

  const logout = async () => {
    await api.logout();
    setMe('anon');
  };

  if (error) return <div className="alert page">Could not reach the server: {error}</div>;
  if (me === null) return <div className="empty page">Loading…</div>;
  if (me === 'anon') return <SignIn />;
  if (!workspace) return <div className="empty page">Your account is not a member of any workspace.</div>;

  const role = me.workspaces.find((w) => w.id === workspace)!.role;
  return (
    <div className="app">
      <Header me={me} workspace={workspace} onWorkspace={switchWorkspace} connection={connection} onLogout={logout} />
      <div className="panes">
        <Inbox key={workspace} workspace={workspace} selected={selected} onSelect={setSelected} subscribe={subscribe} reloadToken={reloadToken} me={me.sub} />
        {selected ? (
          <ThreadView key={`${workspace}|${selected}`} workspace={workspace} contact={selected} me={me.sub} role={role} subscribe={subscribe} reloadToken={reloadToken} />
        ) : (
          <section className="thread">
            <div className="empty">Pick a conversation.</div>
          </section>
        )}
      </div>
    </div>
  );
}
