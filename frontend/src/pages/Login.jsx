import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Loader2, Play, ShieldCheck, ChevronRight } from 'lucide-react';
import { loginUser, registerUser } from '../services/api';

const Login = () => {
    const navigate = useNavigate();
    const [mode, setMode] = useState('login'); // 'login' | 'signup'
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [regToken, setRegToken] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [rememberMe, setRememberMe] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    // Preload background or animations
    useEffect(() => {
        document.title = "Login | MUTFLIX";
    }, []);

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
            setError('Please enter both username and password.');
            return;
        }
        setLoading(true);
        setError('');
        try {
            await loginUser(username, password, rememberMe);
            navigate('/dashboard');
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
            setSuccess('Account created successfully! Redirecting to login...');
            setTimeout(() => switchMode('login'), 2000);
        } catch (err) {
            setError(err.message || 'Registration failed. Please check your token.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="relative min-h-screen w-full flex items-center justify-center bg-[#0a0c10] overflow-hidden font-sans">
            {/* Darker Cinematic Background with Mesh Gradient */}
            <div className="absolute inset-0 z-0">
                <div className="absolute inset-0 bg-gradient-to-br from-brand/10 via-transparent to-purple-500/5 opacity-40"></div>
                <div className="absolute inset-0 bg-[url('https://images.unsplash.com/photo-1574267432553-4b4628081c31?q=80&w=2073&auto=format&fit=crop')] bg-cover bg-center opacity-10 mix-blend-overlay"></div>
                <div className="absolute inset-0 bg-radial-gradient from-transparent via-[#0a0c10]/80 to-[#0a0c10]"></div>
            </div>

            {/* Decorative Elements */}
            <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-brand/10 blur-[120px] rounded-full animate-pulse"></div>
            <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-purple-500/10 blur-[120px] rounded-full animate-pulse" style={{ animationDelay: '2s' }}></div>

            <main className="relative z-10 w-full max-w-[440px] px-6 animate-page-enter">
                {/* Logo & Branding */}
                <div className="flex flex-col items-center mb-10 text-center">
                    <div className="flex items-center gap-2 mb-2 group">
                        <div className="w-12 h-12 bg-brand rounded-xl flex items-center justify-center shadow-[0_0_25px_rgba(0,220,65,0.4)] group-hover:scale-110 transition-transform duration-300">
                           <Play fill="black" size={24} className="ml-1" />
                        </div>
                        <h1 className="text-4xl font-black tracking-tighter text-white">MUT<span className="text-brand">FLIX</span></h1>
                    </div>
                    <p className="text-gray-400 text-sm font-medium tracking-wide uppercase">Premium Entertainment Hub</p>
                </div>

                {/* Login Card */}
                <div className="bg-white/[0.03] backdrop-blur-2xl border border-white/10 rounded-[28px] p-8 md:p-10 shadow-2xl relative overflow-hidden group">
                    {/* Top Accent Line */}
                    <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-brand/50 to-transparent"></div>

                    <div className="mb-8">
                        <h2 className="text-2xl font-bold text-white mb-2">
                            {mode === 'login' ? 'Welcome Back' : 'Get Started'}
                        </h2>
                        <p className="text-gray-400 text-[14px] leading-relaxed">
                            {mode === 'login' 
                                ? 'Unlock your personalized library and continue your journey.' 
                                : 'Join the elite community of movie enthusiasts worldwide.'}
                        </p>
                    </div>

                    {/* Messages */}
                    {error && (
                        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 animate-shake">
                            <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                            <span className="text-red-400 text-xs font-semibold">{error}</span>
                        </div>
                    )}
                    {success && (
                        <div className="mb-6 p-4 bg-brand/10 border border-brand/20 rounded-xl flex items-center gap-3 animate-fade-in">
                            <div className="w-2 h-2 bg-brand rounded-full animate-pulse"></div>
                            <span className="text-brand text-xs font-semibold">{success}</span>
                        </div>
                    )}

                    <form onSubmit={mode === 'login' ? handleLogin : handleSignup} className="space-y-5">
                        <div className="space-y-1.5">
                            <label className="text-[12px] font-bold text-gray-500 uppercase tracking-widest ml-1">Username</label>
                            <input
                                type="text"
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="w-full bg-white/[0.05] border border-white/5 focus:border-brand/40 focus:bg-white/[0.08] text-white rounded-xl px-5 py-3.5 outline-none transition-all duration-300 placeholder:text-gray-600"
                                placeholder="Enter your username"
                                disabled={loading}
                            />
                        </div>

                        <div className="space-y-1.5">
                            <div className="flex justify-between items-center ml-1">
                                <label className="text-[12px] font-bold text-gray-500 uppercase tracking-widest">Password</label>
                                {mode === 'login' && (
                                    <button type="button" className="text-[11px] font-bold text-brand/80 hover:text-brand transition-colors">Forgot Password?</button>
                                )}
                            </div>
                            <div className="relative group/field">
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full bg-white/[0.05] border border-white/5 focus:border-brand/40 focus:bg-white/[0.08] text-white rounded-xl px-5 py-3.5 pr-12 outline-none transition-all duration-300 placeholder:text-gray-600"
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

                        {mode === 'signup' && (
                            <div className="space-y-1.5 animate-slide-up">
                                <label className="text-[12px] font-bold text-gray-500 uppercase tracking-widest ml-1">Registration Token</label>
                                <div className="relative">
                                    <input
                                        type="text"
                                        value={regToken}
                                        onChange={(e) => setRegToken(e.target.value)}
                                        className="w-full bg-white/[0.05] border border-white/5 focus:border-brand/40 focus:bg-white/[0.08] text-white rounded-xl px-5 py-3.5 pl-11 outline-none transition-all duration-300 placeholder:text-gray-600"
                                        placeholder="Secret Invitation Token"
                                        disabled={loading}
                                    />
                                    <ShieldCheck size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-brand/50" />
                                </div>
                            </div>
                        )}

                        {mode === 'login' && (
                            <div className="flex items-center gap-3 ml-1">
                                <button
                                    type="button"
                                    onClick={() => setRememberMe(!rememberMe)}
                                    className={`w-5 h-5 rounded-md flex items-center justify-center transition-all duration-300 border ${rememberMe ? 'bg-brand border-brand shadow-[0_0_10px_rgba(0,220,64,0.3)]' : 'bg-white/5 border-white/10'}`}
                                >
                                    {rememberMe && <ChevronRight size={14} className="text-black stroke-[4px]" />}
                                </button>
                                <span className="text-[13px] text-gray-400 font-medium cursor-pointer select-none" onClick={() => setRememberMe(!rememberMe)}>Remember session on this device</span>
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full h-[54px] bg-brand hover:bg-[#00f04a] text-black font-black uppercase tracking-widest text-[14px] rounded-xl transition-all duration-300 hover:shadow-[0_0_20px_rgba(0,220,64,0.5)] active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100 flex items-center justify-center gap-2 mt-4"
                        >
                            {loading ? (
                                <Loader2 className="animate-spin" size={20} />
                            ) : (
                                <>
                                    {mode === 'login' ? 'Enter MUTFLIX' : 'Create Account'}
                                    <ChevronRight size={18} />
                                </>
                            )}
                        </button>
                    </form>

                    {/* Footer Toggle */}
                    <div className="mt-8 text-center pt-6 border-t border-white/5">
                        <p className="text-gray-500 text-[13px] font-medium">
                            {mode === 'login' ? "Haven't joined yet?" : "Already have an account?"}{' '}
                            <button 
                                onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}
                                className="text-brand font-bold hover:underline underline-offset-4 ml-1 transition-all"
                            >
                                {mode === 'login' ? 'Join Now' : 'Sign In'}
                            </button>
                        </p>
                    </div>
                </div>

                {/* Secure Badge */}
                <div className="mt-10 flex items-center justify-center gap-2 text-gray-600">
                    <ShieldCheck size={14} />
                    <span className="text-[11px] font-bold uppercase tracking-[2px]">Secured by MUTFLIX Guard</span>
                </div>
            </main>

            {/* Background Text Accent */}
            <div className="absolute left-[5%] bottom-[5%] hidden lg:block opacity-[0.03] select-none pointer-events-none">
                <span className="text-[180px] font-black tracking-tighter text-white uppercase italic">PREMIUM</span>
            </div>
            <div className="absolute right-[5%] top-[5%] hidden lg:block opacity-[0.03] select-none pointer-events-none">
                <span className="text-[180px] font-black tracking-tighter text-white uppercase">CINEMA</span>
            </div>
        </div>
    );
};

export default Login;
