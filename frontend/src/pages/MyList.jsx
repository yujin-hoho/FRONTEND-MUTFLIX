import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Trash2, CheckCircle2, Clock, PlayCircle, Film, Tv, Play, Info, MoreVertical } from 'lucide-react';
import Navbar from '../components/Navbar';
import LoginModal from '../components/LoginModal';
import { fetchMyList, removeFromMyList, updateMyListStatus, fetchProfiles, logout, getTMDBInfo, fetchHistory, tmdbImageUrl } from '../services/api';
import Footer from '../components/Footer';
import LoadingScreen from '../components/LoadingScreen';

const mapWithConcurrency = async (items, concurrency, mapper) => {
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const index = next++;
            await mapper(items[index], index);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
    );
};

const MyList = () => {
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState('plan_to_watch'); // 'plan_to_watch' | 'completed'
    const [mylist, setMylist] = useState([]);
    const [loading, setLoading] = useState(true);
    const [showLoginModal, setShowLoginModal] = useState(false);
    const [profileId, setProfileId] = useState(localStorage.getItem('mutflix_last_profile_id'));
    const [historyMap, setHistoryMap] = useState({});
    const [authUser, setAuthUser] = useState(() => {
        const username = localStorage.getItem('username');
        const role = localStorage.getItem('role');
        return username ? { username, role } : null;
    });
    const fetchIdRef = useRef(0);

    const loadData = useCallback(async () => {
        if (!profileId) {
            setLoading(false);
            return;
        }

        const currentFetchId = ++fetchIdRef.current;
        setLoading(true);
        try {
            const [data, history] = await Promise.all([
                fetchMyList(profileId),
                fetchHistory(profileId)
            ]);

            if (currentFetchId !== fetchIdRef.current) return;

            // Map history for progress bars
            const hMap = {};
            history.forEach(h => {
                const progress = (h.position_ms / h.duration_ms) * 100;
                if (h.position_ms >= 5000) {
                    hMap[h.media_path] = progress;
                }
            });
            setHistoryMap(hMap);

            // Set initial data
            setMylist(data);
            setLoading(false);

            // Enrichment phase - fetch missing posters
            const enrichedData = [...data];
            await mapWithConcurrency(data, 6, async (item, idx) => {
                if (item.meta_json?.tmdb_poster_path) return;

                const tmdb = await getTMDBInfo(item.folder_name, { light: true });
                if (tmdb && currentFetchId === fetchIdRef.current) {
                    enrichedData[idx] = {
                        ...item,
                        meta_json: {
                            ...(item.meta_json || {}),
                            tmdb_poster_path: tmdb.poster_path,
                            tmdb_rating: tmdb.rating,
                            tmdb_backdrop_path: tmdb.backdrop_path,
                            tmdb_overview: tmdb.overview
                        }
                    };
                }
            });

            if (currentFetchId === fetchIdRef.current) {
                setMylist(enrichedData);
            }
        } catch (error) {
            console.error("Error loading My List:", error);
        } finally {
            if (currentFetchId === fetchIdRef.current) {
                setLoading(false);
            }
        }
    }, [profileId]);

    // Setup profile if missing
    useEffect(() => {
        if (!authUser || profileId) return;
        
        const setupProfile = async () => {
            try {
                const profiles = await fetchProfiles();
                if (profiles.length > 0) {
                    const pid = profiles[0].id;
                    setProfileId(pid);
                    localStorage.setItem('mutflix_last_profile_id', pid);
                }
            } catch (err) {
                console.error("Profile setup error:", err);
            }
        };
        setupProfile();
    }, [authUser, profileId]);

    useEffect(() => {
        loadData();
    }, [loadData]);

    useEffect(() => {
        const onProfileChange = (event) => {
            if (event.detail?.id) setProfileId(event.detail.id);
        };
        window.addEventListener('mutflix-profile-change', onProfileChange);
        return () => window.removeEventListener('mutflix-profile-change', onProfileChange);
    }, []);

    const handleRemove = async (folderName) => {
        if (!profileId) return;
        const success = await removeFromMyList(profileId, folderName);
        if (success) {
            setMylist(prev => prev.filter(item => item.folder_name !== folderName));
        }
    };

    const handleStatusUpdate = async (folderName, newStatus) => {
        if (!profileId) return;
        const success = await updateMyListStatus(profileId, folderName, newStatus);
        if (success) {
            setMylist(prev => prev.map(item => 
                item.folder_name === folderName ? { ...item, status: newStatus } : item
            ));
        }
    };

    const handleLoginSuccess = (data) => {
        setAuthUser({ username: data.username, role: data.role });
    };

    const handleLogout = () => {
        logout();
        setAuthUser(null);
        setProfileId(null);
        setMylist([]);
    };

    const filteredList = mylist.filter(item => item.status === activeTab);

    if (!authUser) {
        return (
        <div className="min-h-screen bg-[#0a0b0f] text-white flex flex-col items-center justify-center p-6 text-center">
                <div className="w-20 h-20 bg-white/5 rounded-full flex items-center justify-center mb-6">
                    <Clock size={40} className="text-gray-500" />
                </div>
                <h1 className="text-2xl font-bold mb-3 font-brand tracking-tight">Login to your Mutflix account</h1>
                <p className="text-gray-400 max-w-sm mb-8 leading-relaxed">Save movies to watch later and access them from any device, anywhere.</p>
                <button 
                    onClick={() => setShowLoginModal(true)}
                    className="bg-[#00dc41] text-black font-extrabold px-10 py-3.5 rounded-full hover:scale-105 transition active:scale-95 shadow-[0_0_20px_rgba(0,220,65,0.3)]"
                >
                    Log In Now
                </button>
                <LoginModal isOpen={showLoginModal} onClose={() => setShowLoginModal(false)} onLoginSuccess={handleLoginSuccess} />
                <Footer />
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#0a0b0f] text-[#f5f5f5] font-sans flex flex-col">
            <Navbar 
                onMeClick={() => setShowLoginModal(true)} 
                isLoggedIn={!!authUser} 
                username={authUser?.username} 
                onLogout={handleLogout} 
            />

            <main className="max-w-[1500px] mx-auto pt-28 px-6 md:px-12 animate-page-enter">
                {/* Header Section */}
                <div className="flex flex-col md:flex-row md:items-end justify-between items-start mb-12 gap-8">
                    <div className="flex flex-col gap-3">
                        <button 
                            onClick={() => navigate('/')}
                            className="flex items-center gap-2 text-gray-500 hover:text-[#00dc41] transition-all text-[13px] font-bold uppercase tracking-wider mb-2 group"
                        >
                            <ChevronLeft size={18} className="group-hover:-translate-x-1 transition-transform" /> 
                            Back to Discover
                        </button>
                        <h1 className="text-4xl md:text-5xl font-black tracking-tighter text-white">MY LIST</h1>
                        <div className="flex items-center gap-2 text-gray-500 text-[14px] font-medium">
                            <span className="w-1.5 h-1.5 rounded-full bg-[#00dc41]"></span>
                            {mylist.length} collections saved
                        </div>
                    </div>

                    {/* Tab Switcher - iQIYI Style */}
                    <div className="flex bg-[#16181d] p-1.5 rounded-2xl border border-white/5 shadow-2xl overflow-hidden self-start">
                        <button 
                            onClick={() => setActiveTab('plan_to_watch')}
                            className={`flex items-center gap-2.5 px-8 py-3 rounded-xl text-sm font-black transition-all duration-300 ${
                                activeTab === 'plan_to_watch' 
                                ? 'bg-[#00dc41] text-black shadow-lg shadow-[#00dc41]/20 scale-[1.02]' 
                                : 'text-gray-400 hover:text-white hover:bg-white/5'
                            }`}
                        >
                            <Clock size={18} strokeWidth={2.5} /> 
                            PLAN TO WATCH
                        </button>
                        <button 
                            onClick={() => setActiveTab('completed')}
                            className={`flex items-center gap-2.5 px-8 py-3 rounded-xl text-sm font-black transition-all duration-300 ${
                                activeTab === 'completed' 
                                ? 'bg-[#00dc41] text-black shadow-lg shadow-[#00dc41]/20 scale-[1.02]' 
                                : 'text-gray-400 hover:text-white hover:bg-white/5'
                            }`}
                        >
                            <CheckCircle2 size={18} strokeWidth={2.5} /> 
                            COMPLETED
                        </button>
                    </div>
                </div>

                {loading ? (
                    <LoadingScreen />
                ) : filteredList.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-5 xl:grid-cols-6 gap-6 md:gap-8">
                        {filteredList.map((item, idx) => (
                            <ListCard 
                                key={idx} 
                                item={item} 
                                historyProgress={item.media_type === 'tv' ? null : historyMap[item.folder_name]}
                                onRemove={() => handleRemove(item.folder_name)}
                                onStatusUpdate={(s) => handleStatusUpdate(item.folder_name, s)}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-32 text-center animate-fade-in">
                        <div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center mb-10 text-gray-700">
                            {activeTab === 'plan_to_watch' ? <Clock size={48} strokeWidth={1.5} /> : <CheckCircle2 size={48} strokeWidth={1.5} />}
                        </div>
                        <h3 className="text-2xl font-black mb-3">Your list is empty.</h3>
                        <p className="text-[#888] text-[15px] max-w-[320px] leading-relaxed mb-10">Start saving your favorite Asian dramas and movies to build your collection.</p>
                        <button 
                            onClick={() => navigate('/')}
                            className="text-[#00dc41] hover:text-white font-black text-sm uppercase tracking-widest flex items-center gap-2 group border-b border-[#00dc41] pb-1 transition-all"
                        >
                            Discover Content <Play size={12} className="fill-current group-hover:translate-x-1 transition-transform" />
                        </button>
                    </div>
                )}
            </main>

            <LoginModal isOpen={showLoginModal} onClose={() => setShowLoginModal(false)} onLoginSuccess={handleLoginSuccess} />
            <Footer />
        </div>
    );
};

const ListCard = ({ item, onRemove, onStatusUpdate, historyProgress }) => {
    const navigate = useNavigate();
    const meta = item.meta_json || {};
    const posterPath = meta.tmdb_poster_path ? tmdbImageUrl(meta.tmdb_poster_path, 'w342') : null;

    return (
        <div className="flex flex-col gap-3 group">
            {/* Poster Section */}
            <div 
                className="relative aspect-[2/3] rounded-2xl overflow-hidden bg-[#16181d] border border-white/5 shadow-xl transition-all duration-500 group-hover:border-[#00dc41]/30 group-hover:-translate-y-2 group-hover:shadow-[0_20px_40px_rgba(0,0,0,0.4)] cursor-pointer"
                onClick={() => navigate(`/detail/${encodeURIComponent(item.folder_name)}?type=${item.media_type === 'tv' ? 'series' : 'movie'}`)}
            >
                {posterPath ? (
                    <img
                        src={posterPath}
                        alt={item.folder_name}
                        loading="lazy"
                        decoding="async"
                        className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
                    />
                ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center gap-4 bg-gradient-to-br from-[#1a1c22] to-[#0a0b0f] p-6 text-center">
                        <PlayCircle size={48} className="text-gray-800" />
                        <span className="text-[11px] text-gray-600 font-bold uppercase tracking-wider">{item.folder_name}</span>
                    </div>
                ) }

                {/* Glass Hover Overlay */}
                <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-all duration-500 backdrop-blur-[4px] flex flex-col items-center justify-center gap-4 pointer-events-none group-hover:pointer-events-auto">
                    <button 
                        onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/watch/${item.folder_name}?type=${item.media_type === 'tv' ? 'series' : 'movie'}`);
                        }}
                        className="bg-[#00dc41] text-black w-14 h-14 rounded-full flex items-center justify-center shadow-2xl hover:scale-110 active:scale-95 transition-transform"
                    >
                        <Play fill="black" size={24} className="ml-1" />
                    </button>
                    
                    <div className="flex gap-2.5 mt-2">
                        {item.status === 'plan_to_watch' ? (
                            <button 
                                onClick={(e) => { e.stopPropagation(); onStatusUpdate('completed'); }}
                                className="bg-white/10 hover:bg-[#00dc41]/20 text-white hover:text-[#00dc41] p-2.5 rounded-xl border border-white/10 transition-all"
                                title="Mark as Completed"
                            >
                                <CheckCircle2 size={18} />
                            </button>
                        ) : (
                            <button 
                                onClick={(e) => { e.stopPropagation(); onStatusUpdate('plan_to_watch'); }}
                                className="bg-white/10 hover:bg-[#00dc41]/20 text-white hover:text-[#00dc41] p-2.5 rounded-xl border border-white/10 transition-all"
                                title="Plan to Watch Again"
                            >
                                <Clock size={18} />
                            </button>
                        )}
                        <button 
                            onClick={(e) => { e.stopPropagation(); onRemove(); }}
                            className="bg-white/10 hover:bg-red-400/20 text-white hover:text-red-400 p-2.5 rounded-xl border border-white/10 transition-all"
                            title="Remove from List"
                        >
                            <Trash2 size={18} />
                        </button>
                    </div>

                    <button 
                         onClick={(e) => {
                             e.stopPropagation();
                             navigate(`/detail/${encodeURIComponent(item.folder_name)}?type=${item.media_type === 'tv' ? 'series' : 'movie'}`);
                         }}
                        className="absolute bottom-4 text-white/60 hover:text-white text-[11px] font-bold uppercase tracking-widest flex items-center gap-1.5 transition-colors"
                    >
                        Learn More <Info size={12} />
                    </button>
                </div>

                {/* Progress Bar (Series) */}
                {historyProgress > 0 && (
                    <div className="absolute bottom-0 left-0 w-full h-1 bg-white/10 z-20">
                        <div 
                            className="h-full bg-[#00dc41] shadow-[0_0_10px_#00dc41]" 
                            style={{ width: `${historyProgress}%` }}
                        ></div>
                    </div>
                )}

                {/* Badges */}
                <div className="absolute top-3 left-3 flex flex-col gap-1.5 z-10">
                    <div className="bg-black/60 backdrop-blur-md text-[#00dc41] text-[10px] font-black px-2 py-0.5 rounded shadow-lg flex items-center gap-1 uppercase tracking-wider border border-white/10">
                        {item.media_type === 'tv' ? <Tv size={10} /> : <Film size={10} />}
                        {item.media_type === 'tv' ? 'Series' : 'Movie'}
                    </div>
                </div>

                {meta.tmdb_rating > 0 && (
                    <div className="absolute top-3 right-3 bg-[#f5c518] text-black text-[10px] font-black px-1.5 py-0.5 rounded shadow-lg">
                        ⭐ {Number(meta.tmdb_rating).toFixed(1)}
                    </div>
                )}
            </div>

            {/* Info Section */}
            <div className="px-1">
                <h3 className="text-[15px] font-bold text-gray-200 line-clamp-1 group-hover:text-[#00dc41] transition-colors mb-1">
                    {item.folder_name}
                </h3>
                <div className="flex items-center justify-between text-[11px] text-gray-500 font-bold uppercase tracking-wider">
                    <span>{item.media_type === 'tv' ? 'Mutflix Series' : 'Exclusive Movie'}</span>
                    <button className="opacity-0 group-hover:opacity-100 transition-opacity">
                        <MoreVertical size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
};

export default MyList;
