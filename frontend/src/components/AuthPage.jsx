import React, { useState } from 'react';

// API Helper to handle dev/prod URL matching with HuggingFace Space
const getApiUrl = (path) => {
  const { hostname, port } = window.location;
  if (hostname.endsWith('melancholia112-mutflix.hf.space')) {
    return path;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('192.168.') || hostname.startsWith('10.')) {
    if (port === '8000') {
      return path;
    }
    // Dev mode: point to hosted backend on HuggingFace Space
    return `https://melancholia112-mutflix.hf.space${path}`;
  }
  return `https://melancholia112-mutflix.hf.space${path}`;
};

export default function AuthPage({ onLoginSuccess, currentSession, onLogout }) {
  const [isLogin, setIsLogin] = useState(true);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    token: '',
    rememberMe: false
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [successMessage, setSuccessMessage] = useState(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
    setError(null);
  };

  const handleToggleMode = () => {
    setIsLogin(!isLogin);
    setError(null);
    setSuccessMessage(null);
    setFormData({
      username: '',
      password: '',
      token: '',
      rememberMe: false
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccessMessage(null);
    setIsLoading(true);

    if (!formData.username.trim() || !formData.password) {
      setError('Username and password are required.');
      setIsLoading(false);
      return;
    }

    if (!isLogin) {
      if (!formData.token.trim()) {
        setError('Registration token is required.');
        setIsLoading(false);
        return;
      }
      if (formData.password.length < 8) {
        setError('Password must be at least 8 characters long.');
        setIsLoading(false);
        return;
      }
    }

    const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
    const payload = isLogin 
      ? {
          username: formData.username.trim(),
          password: formData.password,
          remember_me: formData.rememberMe
        }
      : {
          token: formData.token.trim(),
          username: formData.username.trim(),
          password: formData.password
        };

    try {
      const response = await fetch(getApiUrl(endpoint), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || data.detail || 'An unexpected server error occurred.');
      }

      if (isLogin) {
        // Successful login
        onLoginSuccess(data);
      } else {
        // Successful registration
        setSuccessMessage('Registration successful! Please sign in using your new account.');
        setIsLogin(true);
        setFormData({
          username: formData.username,
          password: '',
          token: '',
          rememberMe: false
        });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  // If already logged in, show beautiful success/profile card
  if (currentSession) {
    const formattedExpiry = () => {
      if (!currentSession.expires_at || currentSession.expires_at === 'None') {
        return 'Forever (Lifetime)';
      }
      try {
        const date = new Date(currentSession.expires_at);
        return date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        });
      } catch {
        return currentSession.expires_at;
      }
    };

    return (
      <div className="max-w-md w-full mx-auto bg-slate-900/90 border border-slate-800 rounded-2xl p-8 backdrop-blur-xl shadow-2xl relative z-10 overflow-hidden">
        {/* Glow effect */}
        <div className="absolute top-0 right-0 -mt-12 -mr-12 w-32 h-32 bg-sky-500/10 rounded-full blur-2xl"></div>
        <div className="absolute bottom-0 left-0 -mb-12 -ml-12 w-32 h-32 bg-red-500/10 rounded-full blur-2xl"></div>

        <div className="text-center space-y-6 relative z-10">
          <div className="inline-flex p-4 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>

          <div className="space-y-2">
            <h2 className="text-2xl font-bold text-white tracking-tight">Sign In Successful</h2>
            <p className="text-sm text-slate-400">Welcome back to the Mutflix catalog.</p>
          </div>

          <div className="bg-slate-950/60 border border-slate-800/80 rounded-xl p-5 text-left space-y-4">
            <div>
              <span className="text-xs text-slate-500 block uppercase tracking-wider font-semibold">Username</span>
              <span className="text-base text-slate-200 font-medium">{currentSession.username}</span>
            </div>

            <div>
              <span className="text-xs text-slate-500 block uppercase tracking-wider font-semibold">User Role</span>
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold mt-1 uppercase ${
                currentSession.role === 'admin' 
                  ? 'bg-rose-500/10 border border-rose-500/20 text-rose-400' 
                  : 'bg-sky-500/10 border border-sky-500/20 text-sky-400'
              }`}>
                {currentSession.role}
              </span>
            </div>

            <div>
              <span className="text-xs text-slate-500 block uppercase tracking-wider font-semibold">Expiration Time</span>
              <span className="text-sm text-slate-300 font-medium">{formattedExpiry()}</span>
            </div>

            <div>
              <span className="text-xs text-slate-500 block uppercase tracking-wider font-semibold">Session Token (JWT)</span>
              <div className="flex items-center justify-between gap-2 mt-1 bg-slate-900 border border-slate-800 rounded-lg p-2">
                <span className="text-xs text-slate-400 font-mono truncate max-w-[240px]">
                  {currentSession.token}
                </span>
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(currentSession.token);
                    alert('Session token successfully copied to clipboard.');
                  }}
                  className="p-1 hover:bg-slate-800 text-slate-400 hover:text-slate-200 rounded transition-colors"
                  title="Copy Token"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <button
            onClick={onLogout}
            className="w-full py-3 px-4 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-xl transition-all shadow-lg shadow-green-950/30 active:scale-[0.98] outline-none"
          >
            Sign Out (Logout)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md w-full mx-auto bg-slate-900/90 border border-slate-800 rounded-2xl p-8 backdrop-blur-xl shadow-2xl relative z-10 overflow-hidden">
      {/* Background glow effects */}
      <div className="absolute top-0 right-0 -mt-12 -mr-12 w-32 h-32 bg-green-500/5 rounded-full blur-2xl"></div>
      
      <div className="space-y-6 relative z-10">
        {/* Header */}
        <div className="text-center space-y-2">
          <h2 className="text-3xl font-bold tracking-tight text-white">
            {isLogin ? 'Sign In to Mutflix' : 'Register New Account'}
          </h2>
          <p className="text-slate-400 text-sm">
            {isLogin 
              ? 'Please sign in to enjoy the ultimate catalog.' 
              : 'Use your access token to register a new account.'}
          </p>
        </div>

        {/* Error Notification */}
        {error && (
          <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm flex items-start gap-2.5 animate-fadeIn">
            <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div>
              <span className="font-semibold block mb-0.5">Error</span>
              {error}
            </div>
          </div>
        )}

        {/* Success Notification */}
        {successMessage && (
          <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl text-sm flex items-start gap-2.5 animate-fadeIn">
            <svg className="w-5 h-5 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <span className="font-semibold block mb-0.5">Success</span>
              {successMessage}
            </div>
          </div>
        )}

        {/* Auth Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          
          {/* Token Field (Only for Sign Up) */}
          {!isLogin && (
            <div className="space-y-1.5">
              <label htmlFor="token" className="text-xs font-semibold uppercase tracking-wider text-slate-400 block">
                Registration Token
              </label>
              <div className="relative">
                <input
                  id="token"
                  name="token"
                  type="text"
                  required
                  placeholder="MUTFLIX-XXXXXX"
                  value={formData.token}
                  onChange={handleInputChange}
                  className="w-full px-4 py-3 bg-slate-950 border border-slate-800 rounded-xl focus:border-green-500 focus:ring-1 focus:ring-green-500 text-slate-100 placeholder:text-slate-600 outline-none transition-all"
                />
              </div>
            </div>
          )}

          {/* Username Field */}
          <div className="space-y-1.5">
            <label htmlFor="username" className="text-xs font-semibold uppercase tracking-wider text-slate-400 block">
              Username
            </label>
            <input
              id="username"
              name="username"
              type="text"
              required
              autoComplete="username"
              placeholder="Enter username"
              value={formData.username}
              onChange={handleInputChange}
              className="w-full px-4 py-3 bg-slate-950 border border-slate-800 rounded-xl focus:border-green-500 focus:ring-1 focus:ring-green-500 text-slate-100 placeholder:text-slate-600 outline-none transition-all"
            />
          </div>

          {/* Password Field */}
          <div className="space-y-1.5">
            <label htmlFor="password" className="text-xs font-semibold uppercase tracking-wider text-slate-400 block">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                placeholder={isLogin ? 'Enter password' : 'Min. 8 characters'}
                value={formData.password}
                onChange={handleInputChange}
                className="w-full pl-4 pr-11 py-3 bg-slate-950 border border-slate-800 rounded-xl focus:border-green-500 focus:ring-1 focus:ring-green-500 text-slate-100 placeholder:text-slate-600 outline-none transition-all"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3.5 flex items-center text-slate-500 hover:text-slate-300 transition-colors"
              >
                {showPassword ? (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Remember Me Checkbox (Only for Login) */}
          {isLogin && (
            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 text-sm text-slate-400 select-none cursor-pointer">
                <input
                  name="rememberMe"
                  type="checkbox"
                  checked={formData.rememberMe}
                  onChange={handleInputChange}
                  className="rounded border-slate-800 text-green-500 focus:ring-0 focus:ring-offset-0 bg-slate-950 w-4 h-4 cursor-pointer"
                />
                Remember Me
              </label>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-3 px-4 bg-green-600 hover:bg-green-500 disabled:bg-slate-800 text-white font-semibold rounded-xl transition-all shadow-lg shadow-green-950/30 hover:shadow-green-500/10 active:scale-[0.99] flex items-center justify-center gap-2 outline-none"
          >
            {isLoading ? (
              <>
                <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                Processing...
              </>
            ) : (
              isLogin ? 'Sign In' : 'Register'
            )}
          </button>
        </form>

        {/* Switch Mode Anchor */}
        <div className="text-center pt-2">
          <button
            onClick={handleToggleMode}
            className="text-sm text-slate-400 hover:text-white transition-colors underline decoration-slate-600 hover:decoration-white underline-offset-4"
          >
            {isLogin 
              ? 'New to Mutflix? Register now' 
              : 'Already have an account? Sign in here'}
          </button>
        </div>
      </div>
    </div>
  );
}
