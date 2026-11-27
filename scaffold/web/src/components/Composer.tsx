import { useState, type FormEvent, type KeyboardEvent } from 'react';

const MAX = 4000;

export function Composer({ onSend, disabled }: { onSend: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = useState('');
  const trimmed = text.trim();
  const tooLong = trimmed.length > MAX;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!trimmed || tooLong || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) submit(e);
  };

  return (
    <form className="composer" onSubmit={submit}>
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKey} placeholder="Write a reply… (Enter to send, Shift+Enter for a new line)" rows={3} disabled={disabled} />
      <div className="composer-row">
        <span className={`count ${tooLong ? 'over' : ''}`}>
          {trimmed.length}/{MAX}
        </span>
        <button className="btn primary" type="submit" disabled={!trimmed || tooLong || disabled}>
          Send
        </button>
      </div>
    </form>
  );
}
