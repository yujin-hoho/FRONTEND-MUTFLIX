import React, { useState } from 'react';
import { Eye, EyeOff, Loader2, ShieldCheck, Mail, Lock, User, ChevronRight } from 'lucide-react';
import { loginUser, registerUser } from '../services/api';

const AuthOverlay = ({ initialMode = 'login', onLoginSuccess, onCancel }) => {
  const [mode, setMode] = useState(initialMode); // 'login' | 'signup'
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [regToken, setRegToken] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const resetForm = () => {
    setUsername('');
    setPassword('');
    setRegToken('');
    setError('');
    setSuccess('');
  };

  const switchMode = (newMode) => {
    resetForm();
    setMode(newMode);
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError('Please fill in all fields.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await loginUser(username, password, rememberMe);
      onLoginSuccess?.(data);
    } catch (err) {
      setError(err.message || 'Authentication failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const handleSignup = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password.trim() || !regToken.trim()) {
      setError('Please fill in all required fields.');
      return;
    }
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      await registerUser(username, password, regToken);
      setSuccess('Account created! Sign in to continue.');
      setTimeout(() => switchMode('login'), 2000);
    } catch (err) {
      setError(err.message || 'Registration failed. Check your token.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full max-w-[440px] bg-black/75 backdrop-blur-xl border border-white/10 rounded-2xl p-8 md:p-12 shadow-2xl animate-fade-in relative overflow-hidden group">
      {/* Top Accent Glow (Mutflix Green) */}
      <div className="absolute top-0 left-0 right-0 h-[3px] bg-gradient-to-r from-transparent via-brand to-transparent opacity-50"></div>

      <div className="mb-8">
        <h2 className="text-3xl font-black text-white mb-2">
          {mode === 'login' ? 'Sign In' : 'Join Mutflix'}
        </h2>
        <p className="text-gray-400 text-sm font-medium">
          {mode === 'login' 
            ? 'Access your premium cinema experience.' 
            : 'Be part of the elite community of movie enthusiasts.'}
        </p>
      </div>

      {/* Message Notifications */}
      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-3 animate-shake">
          <div className="w-2 h-2 bg-red-500 rounded-full"></div>
          <span className="text-red-400 text-xs font-bold leading-tight">{error}</span>
        </div>
      )}
      {success && (
        <div className="mb-6 p-4 bg-brand/10 border border-brand/20 rounded-lg flex items-center gap-3 animate-fade-in">
          <div className="w-2 h-2 bg-brand rounded-full"></div>
          <span className="text-brand text-xs font-bold leading-tight">{success}</span>
        </div>
      )}

      <form onSubmit={mode === 'login' ? handleLogin : handleSignup} className="space-y-6">
        {/* Username */}
        <div className="space-y-1.5 focus-within:translate-x-1 transition-transform">
          <label className="text-[11px] font-black text-gray-500 uppercase tracking-widest pl-1">Username</label>
          <div className="relative group/field">
            <User size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within/field:text-brand transition-colors" />
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-white/5 border border-white/10 focus:border-brand/50 focus:bg-white/10 text-white rounded-xl py-4 pl-12 pr-5 outline-none transition-all duration-300 placeholder:text-gray-600 font-bold text-sm"
              placeholder="Your username"
              disabled={loading}
              autoFocus
            />
          </div>
        </div>

        {/* Password */}
        <div className="space-y-1.5 focus-within:translate-x-1 transition-transform">
          <div className="flex justify-between items-center px-1">
            <label className="text-[11px] font-black text-gray-500 uppercase tracking-widest">Password</label>
            {mode === 'login' && (
              <button type="button" className="text-[10px] font-black text-brand/70 hover:text-brand transition-colors uppercase tracking-wider">Trouble?</button>
            )}
          </div>
          <div className="relative group/field">
            <Lock size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-500 group-focus-within/field:text-brand transition-colors" />
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-white/5 border border-white/10 focus:border-brand/50 focus:bg-white/10 text-white rounded-xl py-4 pl-12 pr-12 outline-none transition-all duration-300 placeholder:text-gray-600 font-bold text-sm"
              placeholder="••••••••"
              disabled={loading}
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white transition-colors p-1"
            >
              {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>

        {/* Signup Only: Reg Token */}
        {mode === 'signup' && (
          <div className="space-y-1.5 focus-within:translate-x-1 transition-transform animate-slide-up">
            <label className="text-[11px] font-black text-gray-500 uppercase tracking-widest pl-1">Invitation Token</label>
            <div className="relative group/field">
              <ShieldCheck size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand/40 group-focus-within/field:text-brand transition-colors" />
              <input
                type="text"
                value={regToken}
                onChange={(e) => setRegToken(e.target.value)}
                className="w-full bg-white/5 border border-white/10 focus:border-brand/50 focus:bg-white/10 text-white rounded-xl py-4 pl-12 pr-5 outline-none transition-all duration-300 placeholder:text-gray-600 font-bold text-sm"
                placeholder="Secret access code"
                disabled={loading}
              />
            </div>
          </div>
        )}

        {/* Action Button */}
        <button
          type="submit"
          disabled={loading}
          className="w-full h-14 bg-brand hover:bg-[#00f04a] text-black font-black uppercase tracking-widest text-sm rounded-xl transition-all duration-300 hover:shadow-[0_0_30px_rgba(0,220,64,0.4)] hover:scale-[1.01] active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 mt-2 group/btn shadow-xl shadow-brand/10"
        >
          {loading ? (
            <Loader2 className="animate-spin" size={20} />
          ) : (
            <>
              {mode === 'login' ? 'Sign In' : 'Create My Account'}
              <ChevronRight size={20} className="group-hover/btn:translate-x-0.5 transition-transform" />
            </>
          )}
        </button>
      </form>

      {/* Bottom Switch Link */}
      <div className="mt-10 text-center border-t border-white/5 pt-6">
        <p className="text-gray-500 text-[13px] font-bold">
          {mode === 'login' ? "New to Mutflix elite?" : "Already part of the community?"}{' '}
          <button 
            onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
            className="text-brand hover:text-[#00f04a] font-black hover:underline underline-offset-4 ml-1 transition-all"
          >
            {mode === 'login' ? 'Join Now' : 'Sign In'}
          </button>
        </p>
      </div>

      {onCancel && (
        <button 
          onClick={onCancel}
          className="absolute top-6 right-6 text-gray-400 hover:text-white transition-colors"
        >
          <Mail size={18} className="rotate-45" /> {/* Close icon substitution or similar */}
        </button>
      )}
    </div>
  );
};

export default AuthOverlay;
