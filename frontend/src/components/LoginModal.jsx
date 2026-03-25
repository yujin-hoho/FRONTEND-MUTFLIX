import { useState } from 'react';
import { X, Eye, EyeOff, Loader2 } from 'lucide-react';
import { loginUser, registerUser } from '../services/api';

const LoginModal = ({ isOpen, onClose, onLoginSuccess }) => {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [regToken, setRegToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  if (!isOpen) return null;

  const resetForm = () => {
    setUsername('');
    setPassword('');
    setRegToken('');
    setError('');
    setSuccess('');
    setShowPassword(false);
  };

  const switchMode = (newMode) => {
    resetForm();
    setMode(newMode);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Please fill in all fields');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await loginUser(username, password, rememberMe);
      onLoginSuccess?.(data);
      onClose();
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim() || !regToken.trim()) {
      setError('Please fill in all fields');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      await registerUser(username, password, regToken);
      setSuccess('Account created! You can now log in.');
      setTimeout(() => switchMode('login'), 1500);
    } catch (err) {
      setError(err.message || 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-overlay" onClick={onClose}>
      <div className="login-modal" onClick={(e) => e.stopPropagation()}>
        {/* Close Button */}
        <button className="login-close" onClick={onClose}>
          <X size={22} />
        </button>

        {/* Header */}
        <h2 className="login-title">{mode === 'login' ? 'Login' : 'Sign Up'}</h2>
        <p className="login-subtitle">
          {mode === 'login'
            ? 'Log in to manage your account, and synchronize watching history and favorites on multi-devices.'
            : 'Create a new account to start watching.'}
        </p>

        {/* Error / Success */}
        {error && <div className="login-error">{error}</div>}
        {success && <div className="login-success">{success}</div>}

        {/* Form */}
        <form onSubmit={mode === 'login' ? handleLogin : handleSignup} className="login-form">
          {/* Username */}
          <div className="login-field">
            <input
              id="login-username"
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              disabled={loading}
            />
          </div>

          {/* Password */}
          <div className="login-field login-field-password">
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              disabled={loading}
            />
            <button
              type="button"
              className="login-eye"
              onClick={() => setShowPassword(!showPassword)}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>

          {/* Registration Token (signup only) */}
          {mode === 'signup' && (
            <div className="login-field">
              <input
                id="login-regtoken"
                type="text"
                placeholder="Registration Token"
                value={regToken}
                onChange={(e) => setRegToken(e.target.value)}
                disabled={loading}
              />
            </div>
          )}

          {/* Remember Me (login only) */}
          {mode === 'login' && (
            <label className="login-remember">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              <span>Remember me</span>
            </label>
          )}

          {/* Submit */}
          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? (
              <Loader2 size={20} className="login-spinner" />
            ) : (
              mode === 'login' ? 'Log In' : 'Create Account'
            )}
          </button>
        </form>

        {/* Toggle */}
        <div className="login-toggle">
          {mode === 'login' ? (
            <>Don't have an account? <button onClick={() => switchMode('signup')}>Sign Up</button></>
          ) : (
            <>Already have an account? <button onClick={() => switchMode('login')}>Log In</button></>
          )}
        </div>
      </div>
    </div>
  );
};

export default LoginModal;
