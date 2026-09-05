import { useState, type FormEvent } from 'react';
import type { CredentialsUpdate, PlaylistService } from '../api.js';
import { zhCN } from '../i18n/zh-CN.js';

export interface AccountDialogProps {
  readonly service: PlaylistService;
  readonly onClose: () => void;
  /** 修改成功后的新用户名。 */
  readonly onSuccess: (username: string) => void;
  /** 会话已失效（401“请先登录”）时回登录视图；当前密码错误的 401 在弹层内提示。 */
  readonly onSessionExpired: () => void;
}

export function AccountDialog({ service, onClose, onSuccess, onSessionExpired }: AccountDialogProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(undefined);
    const update: CredentialsUpdate = {
      currentPassword,
      ...(username.trim() === '' ? {} : { username: username.trim() }),
      ...(password === '' ? {} : { password }),
    };
    try {
      const result = await service.updateCredentials(update);
      onSuccess(result.username);
    } catch (caught) {
      const message = caught instanceof Error && caught.message !== ''
        ? caught.message
        : zhCN.libraryActionFailed;
      // 未登录（401“请先登录”）意味着会话已过期，交给外层回到登录视图；
      // “当前密码不正确”的 401 留在弹层内提示。
      if (caught instanceof Error && caught.message.includes('请先登录')) {
        onSessionExpired();
        return;
      }
      setError(message);
      setSubmitting(false);
    }
  };

  return (
    <div className="dialog-backdrop">
      <section
        aria-labelledby="account-dialog-title"
        aria-modal="true"
        className="dialog"
        role="dialog"
      >
        <h2 id="account-dialog-title">{zhCN.accountDialogTitle}</h2>
        <form onSubmit={event => void submit(event)}>
          <label htmlFor="account-current-password">{zhCN.currentPasswordLabel}</label>
          <input
            autoComplete="current-password"
            id="account-current-password"
            onChange={event => setCurrentPassword(event.target.value)}
            required
            type="password"
            value={currentPassword}
          />
          <label htmlFor="account-new-username">{zhCN.newUsernameLabel}</label>
          <input
            autoComplete="username"
            id="account-new-username"
            onChange={event => setUsername(event.target.value)}
            spellCheck={false}
            type="text"
            value={username}
          />
          <label htmlFor="account-new-password">{zhCN.newPasswordLabel}</label>
          <input
            autoComplete="new-password"
            id="account-new-password"
            onChange={event => setPassword(event.target.value)}
            type="password"
            value={password}
          />
          {error !== undefined && <p role="alert" className="login-error">{error}</p>}
          <div className="dialog-actions">
            <button className="button-secondary" onClick={onClose} type="button">
              {zhCN.accountCancelButton}
            </button>
            <button disabled={submitting} type="submit">
              {submitting ? zhCN.accountSaving : zhCN.accountSaveButton}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

export interface UserMenuProps {
  readonly username: string | undefined;
  readonly service: PlaylistService;
  readonly onLogout: () => void;
  readonly onCredentialsChanged: (username: string) => void;
  readonly onSessionExpired: () => void;
}

export function UserMenu({
  username,
  service,
  onLogout,
  onCredentialsChanged,
  onSessionExpired,
}: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="user-menu">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen(value => !value)}
        type="button"
      >
        {username ?? zhCN.userFallback}
      </button>
      {open && (
        <div className="user-menu__dropdown" role="menu">
          <button
            onClick={() => {
              setOpen(false);
              setDialogOpen(true);
            }}
            role="menuitem"
            type="button"
          >
            {zhCN.accountMenuItem}
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
            role="menuitem"
            type="button"
          >
            {zhCN.logoutButton}
          </button>
        </div>
      )}
      {dialogOpen && (
        <AccountDialog
          onClose={() => setDialogOpen(false)}
          onSessionExpired={onSessionExpired}
          onSuccess={next => {
            setDialogOpen(false);
            onCredentialsChanged(next);
          }}
          service={service}
        />
      )}
    </div>
  );
}
