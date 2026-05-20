import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Play, ChevronRight, Globe, Loader2 } from 'lucide-react';
import Footer from '../components/Footer';
import AuthOverlay from '../components/AuthOverlay';
import { fetchFolders, tmdbImageUrl } from '../services/api';

const Login = () => {
    const navigate = useNavigate();
    const [showAuth, setShowAuth] = useState(false);
    const [authMode, setAuthMode] = useState('login');
    const [email, setEmail] = useState('');
    const [trending, setTrending] = useState([]);

    const loadTrending = async () => {
        try {
            const data = await fetchFolders();
            if (data && !data.__error) {
                const allItems = [...(data.movies || []), ...(data.series || [])];
                const shuffled = allItems
                    .filter((item) => item.tmdb_poster_path || item.poster_path || item.poster)
                    .sort(() => 0.5 - Math.random())
                    .slice(0, 10)
                    .map((item) => ({
                        ...item,
                        poster_path: item.tmdb_poster_path || item.poster_path || item.poster,
                    }));
                setTrending(shuffled);
            }
        } catch (e) { console.error(e); }
    };

    useEffect(() => {
        document.title = "Unlimited Movies & TV shows | MUTFLIX";
        const id = setTimeout(() => loadTrending(), 0);
        return () => clearTimeout(id);
    }, []);

    const handleGetStarted = (e) => {
        e.preventDefault();
        setAuthMode('signup');
        setShowAuth(true);
    };

    const openLogin = () => {
        setAuthMode('login');
        setShowAuth(true);
    };

    return (
        <div className="relative min-h-screen w-full bg-[#0a0c10] text-white font-sans overflow-x-hidden selection:bg-brand selection:text-black">
            {/* HERO SECTION */}
            <div className="relative min-h-[90vh] flex flex-col">
                {/* HER0 BACKGROUND LAYER */}
                <div className="absolute inset-0 z-0">
                    <div 
                        className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-40 scale-105 animate-slow-pan"
                        style={{ backgroundImage: "url('/movie_grid_bg.png')" }}
                    ></div>
                    <div className="absolute inset-0 bg-gradient-to-t from-[#0a0c10] via-transparent to-[#0a0c10]/80"></div>
                    <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-transparent to-[#0a0c10]"></div>
                    <div className="absolute inset-0 bg-black/40"></div>
                </div>

                {/* HEADER / NAVIGATION */}
                <header className="relative z-20 flex items-center justify-between px-6 md:px-12 py-6 max-w-[1400px] mx-auto w-full">
                    <div className="flex items-center gap-2 group cursor-pointer" onClick={() => window.location.reload()}>
                        <div className="w-10 h-10 bg-brand rounded-lg flex items-center justify-center shadow-[0_0_20px_rgba(0,220,65,0.4)] group-hover:scale-110 transition-transform">
                            <Play fill="black" size={20} className="ml-1" />
                        </div>
                        <h1 className="text-3xl font-black tracking-tighter text-white">MUT<span className="text-brand">FLIX</span></h1>
                    </div>

                    <div className="flex items-center gap-4">
                        <div className="hidden sm:flex items-center gap-2 bg-black/40 border border-white/20 rounded-md px-3 py-1 text-sm font-bold backdrop-blur-md">
                            <Globe size={16} className="text-gray-400" />
                            <select className="bg-transparent outline-none cursor-pointer">
                                <option className="bg-darkBG">English</option>
                                <option className="bg-darkBG">Indonesian</option>
                            </select>
                        </div>
                        <button 
                            onClick={openLogin}
                            className="bg-brand hover:bg-[#00f04a] text-black px-5 py-1.5 rounded-md font-black text-sm transition-all shadow-lg shadow-brand/10 active:scale-95"
                        >
                            Sign In
                        </button>
                    </div>
                </header>

                {/* MAIN HERO CONTENT */}
                <main className="relative z-10 flex-1 flex flex-col items-center justify-center text-center px-4 max-w-[950px] mx-auto animate-page-enter">
                    <h2 className="text-4xl md:text-6xl lg:text-7xl font-black tracking-tighter mb-6 leading-[0.95] md:leading-[1.1]">
                        Unlimited movies, TV <br className="hidden md:block"/> shows, and more
                    </h2>
                    <p className="text-lg md:text-2xl font-bold mb-8 text-gray-200">
                        Starts at <span className="text-brand">IDR 54,000</span>. Cancel anytime.
                    </p>
                    <div className="w-full max-w-[700px]">
                        <p className="text-sm md:text-xl font-medium mb-5 text-gray-300">
                            Ready to watch? Enter your email to create or restart your membership.
                        </p>
                        <form onSubmit={handleGetStarted} className="flex flex-col md:flex-row items-center gap-3 group">
                            <div className="relative w-full">
                                <input 
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    placeholder="Email address"
                                    className="w-full bg-black/40 border border-white/30 rounded-lg md:rounded-l-lg md:rounded-r-none py-4 px-6 text-lg outline-none focus:border-brand focus:bg-black/60 transition-all font-bold backdrop-blur-sm"
                                    required
                                />
                            </div>
                            <button 
                                type="submit"
                                className="w-full md:w-auto bg-brand hover:bg-[#00f04a] text-black py-4 px-8 rounded-lg md:rounded-r-lg md:rounded-l-none text-xl font-black flex items-center justify-center gap-2 transition-all whitespace-nowrap active:scale-[0.98] shadow-[0_0_30px_rgba(0,220,65,0.25)]"
                            >
                                Get Started
                                <ChevronRight size={24} />
                            </button>
                        </form>
                    </div>
                </main>

                {/* NEON BOTTOM GLOW WAVE */}
                <div className="relative h-24 w-full overflow-hidden mt-auto">
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[200%] h-full bg-gradient-to-t from-brand/20 to-transparent opacity-40 blur-3xl"></div>
                    <div 
                        className="absolute bottom-[-15px] left-1/2 -translate-x-1/2 w-[180%] h-[150%] border-t-[4px] border-brand/50"
                        style={{ borderRadius: '50% 50% 0 0', boxShadow: '0 -20px 80px rgba(0,220,65,0.3)' }}
                    ></div>
                </div>
            </div>

            {/* TRENDING NOW SECTION */}
            {trending.length > 0 && (
                <section className="relative z-10 px-6 md:px-12 py-16 max-w-[1400px] mx-auto animate-fade-in">
                    <h3 className="text-2xl font-black mb-8 tracking-tight">Trending Now</h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-4">
                        {trending.map((item, idx) => (
                            <div key={idx} className="relative aspect-[2/3] rounded-lg overflow-hidden group cursor-pointer shadow-xl transition-all hover:scale-105 hover:z-20">
                                <img
                                    src={
                                        tmdbImageUrl(item.poster_path, 'w342')
                                    }
                                    alt={item.folder_name}
                                    loading="lazy"
                                    decoding="async"
                                    className="w-full h-full object-cover transition-transform group-hover:scale-110"
                                />
                                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-3">
                                    <p className="text-[10px] font-black uppercase truncate w-full">{item.folder_name}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* AUTH OVERLAY MODAL */}
            {showAuth && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div 
                        className="absolute inset-0 bg-black/80 backdrop-blur-sm animate-fade-in"
                        onClick={() => setShowAuth(false)}
                    ></div>
                    <div className="relative z-10 w-full flex justify-center animate-page-enter">
                        <AuthOverlay 
                            initialMode={authMode} 
                            onLoginSuccess={() => navigate('/dashboard')} 
                            onCancel={() => setShowAuth(false)}
                        />
                    </div>
                </div>
            )}

            <Footer />
        </div>
    );
};

export default Login;
