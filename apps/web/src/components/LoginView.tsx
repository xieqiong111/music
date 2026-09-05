import { useState, type FormEvent } from 'react';
import type { SessionDuration } from '../api.js';
import { zhCN } from '../i18n/zh-CN.js';

const DURATIONS: ReadonlyArray<{ readonly value: SessionDuration; readonly label: string }> = [
  { value: '12h', label: zhCN.duration12h },
  { value: '7d', label: zhCN.duration7d },
  { value: '30d', label: zhCN.duration30d },
  { value: 'forever', label: zhCN.durationForever },
];

export interface LoginViewProps {
  /** 会话过期等原因导致的提示，显示在表单上方。 */
  readonly notice?: string;
  readonly onLogin: (
    username: string,
    password: string,
    duration: SessionDuration,
  ) => Promise<void>;
}

export function LoginView({ notice, onLogin }: LoginViewProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [duration, setDuration] = useState<SessionDuration>('7d');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      await onLogin(username.trim(), password, duration);
    } catch (caught) {
      setError(caught instanceof Error && caught.message !== '' ? caught.message : zhCN.loginFailed);
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="login-title" className="login-panel">
      <h1 id="login-title">{zhCN.loginTitle}</h1>
      <p className="login-hint">{zhCN.loginDefaultHint}</p>
      {notice !== undefined && <p role="status" className="login-notice">{notice}</p>}
      <form onSubmit={event => void submit(event)}>
        <label htmlFor="login-username">{zhCN.loginUsername}</label>
        <input
          autoComplete="username"
          id="login-username"
          name="username"
          onChange={event => setUsername(event.target.value)}
          required
          spellCheck={false}
          type="text"
          value={username}
        />
        <label htmlFor="login-password">{zhCN.loginPassword}</label>
        <input
          autoComplete="current-password"
          id="login-password"
          name="password"
          onChange={event => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />
        <label htmlFor="login-duration">{zhCN.loginDuration}</label>
        <select
          id="login-duration"
          onChange={event => setDuration(event.target.value as SessionDuration)}
          value={duration}
        >
          {DURATIONS.map(item => (
            <option key={item.value} value={item.value}>{item.label}</option>
          ))}
        </select>
        <button disabled={submitting} type="submit">
          {submitting ? zhCN.loggingIn : zhCN.loginButton}
        </button>
      </form>
      {error !== undefined && <p role="alert" className="login-error">{error}</p>}
    </section>
  );
}
