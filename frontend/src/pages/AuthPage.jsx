import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, LockKeyhole, User } from 'lucide-react'

function AuthPage({
  accessToken,
  canSubmit,
  isLoading,
  isRegister,
  message,
  mode,
  onAccessTokenChange,
  onPasswordChange,
  onRememberMeChange,
  onShowPasswordChange,
  onSubmit,
  onSwitchMode,
  onUsernameChange,
  password,
  rememberMe,
  showPassword,
  username,
}) {
  return (
    <main className="login-page">
      <section className="brand-panel" aria-label="Mutflix preview">
        <nav className="topbar" aria-label="Mutflix">
          <a className="brand-mark" href="/" aria-label="Mutflix home">
            MUTFLIX
          </a>
          <span className="status-pill">Private streaming</span>
        </nav>

        <div className="hero-copy">
          <p className="eyebrow">Unlimited nights. Curated watchlist.</p>
          <h1>Movies, series, and watch parties on one green screen.</h1>
          <p className="hero-text">
            Sign in to continue your queue, keep progress synced, and open your private profile.
          </p>
        </div>

        <div className="hero-footer" aria-hidden="true" />
      </section>

      <section className="auth-panel" aria-label="Authentication form">
        <div className="login-card">
          <div className="form-heading">
            <p>{isRegister ? 'Create access' : 'Welcome back'}</p>
            <h2>{isRegister ? 'Join Mutflix' : 'Sign in'}</h2>
          </div>

          <div className="mode-switch" aria-label="Choose authentication mode">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => onSwitchMode('login')} type="button">
              Login
            </button>
            <button className={mode === 'register' ? 'active' : ''} onClick={() => onSwitchMode('register')} type="button">
              Register
            </button>
          </div>

          <form onSubmit={onSubmit} className="login-form">
            <label className="field">
              <span>Username</span>
              <div className="input-wrap">
                <User aria-hidden="true" size={19} />
                <input
                  autoComplete="username"
                  name="username"
                  onChange={(event) => onUsernameChange(event.target.value)}
                  placeholder="username"
                  type="text"
                  value={username}
                />
              </div>
            </label>

            <label className="field">
              <span>Password</span>
              <div className="input-wrap">
                <LockKeyhole aria-hidden="true" size={19} />
                <input
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  name="password"
                  onChange={(event) => onPasswordChange(event.target.value)}
                  placeholder={isRegister ? 'minimum 8 characters' : 'password'}
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                />
                <button
                  aria-label={showPassword ? 'Sembunyikan password' : 'Tampilkan password'}
                  className="icon-button"
                  onClick={() => onShowPasswordChange(!showPassword)}
                  type="button"
                >
                  {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </div>
            </label>

            {isRegister && (
              <label className="field">
                <span>Registration token</span>
                <div className="input-wrap">
                  <KeyRound aria-hidden="true" size={19} />
                  <input
                    autoComplete="one-time-code"
                    name="token"
                    onChange={(event) => onAccessTokenChange(event.target.value)}
                    placeholder="MUTFLIX-..."
                    type="text"
                    value={accessToken}
                  />
                </div>
              </label>
            )}

            {!isRegister && (
              <div className="form-options">
                <label className="remember-option">
                  <input
                    checked={rememberMe}
                    onChange={(event) => onRememberMeChange(event.target.checked)}
                    type="checkbox"
                  />
                  <span>Remember me</span>
                </label>
                <button className="link-button" onClick={() => onSwitchMode('register')} type="button">
                  Need access?
                </button>
              </div>
            )}

            {message && (
              <div className={`notice ${message.type}`} role={message.type === 'error' ? 'alert' : 'status'}>
                {message.type === 'error' ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
                <span>{message.text}</span>
              </div>
            )}

            <button className="submit-button" disabled={!canSubmit} type="submit">
              {isLoading ? <Loader2 className="spinner" size={21} /> : null}
              <span>{isLoading ? 'Please wait...' : isRegister ? 'Create account' : 'Sign in'}</span>
            </button>
          </form>
        </div>
      </section>
    </main>
  )
}

export default AuthPage
