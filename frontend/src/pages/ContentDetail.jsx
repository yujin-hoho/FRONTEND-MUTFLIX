import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Play, Share2, Clock, ChevronDown, ChevronUp, User } from 'lucide-react';
import Navbar from '../components/Navbar';
import LoginModal from '../components/LoginModal';
import { fetchVideos, getTMDBInfo, getTMDBCredits, getTMDBSeasonDetails, logout } from '../services/api';

const ContentDetail = () => {
  const { folderName } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const decodedName = decodeURIComponent(folderName);
  const urlType = searchParams.get('type'); // 'movie' or 'series'

  const [videos, setVideos] = useState([]);
  const [tmdbData, setTmdbData] = useState(null);
  const [credits, setCredits] = useState(null);
  const [episodeData, setEpisodeData] = useState({});
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('episodes');
  const [expandedDesc, setExpandedDesc] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [authUser, setAuthUser] = useState(() => {
    const username = localStorage.getItem('username');
    const role = localStorage.getItem('role');
    return username ? { username, role } : null;
  });

  const isSeriesContent = urlType === 'series' ||
    (tmdbData?.media_type === 'tv') ||
    (!urlType && videos.length > 1);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true);

      const [videosResp, tmdb] = await Promise.all([
        fetchVideos(decodedName),
        getTMDBInfo(decodedName)
      ]);

      const videosList = videosResp?.videos || [];
      videosList.sort((a, b) => {
        if (a.season !== b.season) return (a.season || 1) - (b.season || 1);
        return (a.episode || 0) - (b.episode || 0);
      });

      setVideos(videosList);
      setTmdbData(tmdb);

      if (tmdb?.tmdb_id) {
        const creditsData = await getTMDBCredits(tmdb.tmdb_id, tmdb.media_type);
        setCredits(creditsData);

        // Fetch Season details for Episode Stills
        if (urlType === 'series' || tmdb.media_type === 'tv' || videosList.length > 1) {
          const uniqueSeasons = [...new Set(videosList.map(v => v.season || 1))];
          const seasonPromises = uniqueSeasons.map(s => getTMDBSeasonDetails(tmdb.tmdb_id, s));
          const seasonsData = await Promise.all(seasonPromises);

          const dataMap = {};
          seasonsData.forEach((seasonData, index) => {
            if (seasonData && seasonData.episodes) {
              const sNum = uniqueSeasons[index];
              seasonData.episodes.forEach(ep => {
                dataMap[`${sNum}_${ep.episode_number}`] = {
                  still_path: ep.still_path ? `https://image.tmdb.org/t/p/w500${ep.still_path}` : null,
                  name: ep.name
                };
              });
            }
          });
          setEpisodeData(dataMap);
        }
      }

      const seriesCheck = urlType === 'series' || (tmdb?.media_type === 'tv') || (!urlType && videosList.length > 1);
      setActiveTab(seriesCheck ? 'episodes' : 'cast');

      setLoading(false);
    };
    loadData();
  }, [decodedName, urlType]);

  const handleLoginSuccess = (data) => {
    setAuthUser({ username: data.username, role: data.role });
  };
  const handleLogout = () => {
    logout();
    setAuthUser(null);
  };

  const title = decodedName;
  const rating = tmdbData?.rating;
  const overview = tmdbData?.overview || "An exciting story awaits in this premium content. Explore the world of drama, action, and romance in this captivating production.";
  const year = (tmdbData?.date || "2025").substring(0, 4);
  const totalEpisodes = videos.length || 36;
  const directorName = credits?.director || 'Staff';
  const castList = credits?.cast || [];
  const castNames = castList.map(c => c.name).slice(0, 8).join(', ') || 'Cast information unavailable';

  const backdropPath = tmdbData?.backdrop_path
    ? `https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}`
    : tmdbData?.poster_path
      ? `https://image.tmdb.org/t/p/original${tmdbData.poster_path}`
      : 'https://images.unsplash.com/photo-1542204165-65bf26472b9b?q=80&w=1974&auto=format&fit=crop';

  const posterPath = tmdbData?.poster_path
    ? `https://image.tmdb.org/t/p/w500${tmdbData.poster_path}`
    : backdropPath;

  const tabs = isSeriesContent ? ['Episodes', 'Cast'] : ['Cast'];

  if (loading) {
    return (
      <div className="min-h-screen bg-[#111319] flex flex-col items-center justify-center">
        <div className="w-14 h-14 border-4 border-[#00dc41] border-t-transparent rounded-full animate-spin mb-6 mt-[-10vh] shadow-[0_0_15px_rgba(0,220,65,0.3)]"></div>
        <div className="text-[#00dc41] font-black text-2xl tracking-[0.2em] animate-pulse">MUTFLIX</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#111319] font-sans text-white overflow-x-hidden animate-page-enter">
      <Navbar
        onMeClick={() => setShowLoginModal(true)}
        isLoggedIn={!!authUser}
        username={authUser?.username}
        onLogout={handleLogout}
      />

      {/* Hero Section */}
      <div className="relative w-full min-h-[50vh] md:min-h-[75vh] animate-fade-in">
        {/* Backdrop Image */}
        <div className="absolute inset-0 w-full h-full">
          <img src={backdropPath} alt={title} className="w-full h-full object-cover object-top opacity-60" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#111319]/90 via-[#111319]/60 to-[#111319]/10"></div>
          <div className="absolute inset-0 bg-gradient-to-t from-[#111319]/90 via-[#111319]/40 to-transparent"></div>
        </div>

        {/* Content (left side) */}
        <div className="relative z-10 flex flex-col justify-end h-full min-h-[50vh] md:min-h-[75vh] px-6 md:px-16 pt-24 pb-8 md:pb-12 max-w-[700px] animate-slide-up">
          <h1 className="text-3xl md:text-5xl font-bold text-white mb-4 leading-tight">{title}</h1>

          {/* Tag Badges */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="bg-[#00dc41]/20 text-[#00dc41] text-[11px] font-bold px-2 py-0.5 rounded border border-[#00dc41]/30">
              {isSeriesContent ? 'Hot Series' : 'Hot Movie'}
            </span>
            <span className="bg-white/10 text-white text-[11px] font-bold px-2 py-0.5 rounded border border-white/20">
              {isSeriesContent ? 'TV Series' : 'Movie'}
            </span>
            <span className="bg-[#00dc41] text-white text-[11px] font-bold px-2 py-0.5 rounded">
              Original
            </span>
          </div>

          {/* Metadata Row */}
          <div className="flex items-center gap-2 text-sm text-gray-300 font-medium mb-3 flex-wrap">
            <span className="text-[#00dc41] font-bold">★ {rating > 0 ? Number(rating).toFixed(1) : 'NR'}</span>
            <span className="text-gray-600">|</span>
            <span className="border border-gray-600 px-1.5 rounded-sm text-[11px]">13+</span>
            <span className="text-gray-600">|</span>
            <span>{year}</span>
            {isSeriesContent && (
              <>
                <span className="text-gray-600">|</span>
                <span>Updated to {Math.min(videos.length || 20, totalEpisodes)}/Total {totalEpisodes} Episodes</span>
              </>
            )}
          </div>

          {/* Genre Tags */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            {tmdbData?.genre_ids ? tmdbData.genre_ids.map((id, idx) => (
              <span key={idx} className="bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-[12px] font-medium px-3 py-1 rounded-full cursor-pointer transition border border-white/10">
                Genre
              </span>
            )) : ['Drama', 'Romance', 'Comedy', 'Action'].slice(0, 3).map(genre => (
              <span key={genre} className="bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-[12px] font-medium px-3 py-1 rounded-full cursor-pointer transition border border-white/10">
                {genre}
              </span>
            ))}
          </div>

          {/* Director & Cast */}
          <div className="text-[13px] text-gray-400 mb-1">
            <span className="text-gray-500">Director: </span>
            <span className="text-white/80 hover:text-[#00dc41] cursor-pointer transition">{directorName}</span>
          </div>
          <div className="text-[13px] text-gray-400 mb-3 line-clamp-1">
            <span className="text-gray-500">Cast: </span>
            <span className="text-white/80">{castNames}</span>
          </div>

          {/* Description */}
          <div className="mb-5">
            <p className={`text-gray-400 text-[13px] leading-relaxed ${expandedDesc ? '' : 'line-clamp-2'}`}>
              <span className="text-gray-500">Description: </span>
              "{overview}"
            </p>
            <button
              onClick={() => setExpandedDesc(!expandedDesc)}
              className="text-[#00dc41] text-[12px] font-medium mt-1 flex items-center gap-0.5 hover:brightness-125 transition"
            >
              {expandedDesc ? 'Less' : 'More'} {expandedDesc ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => {
                const firstVid = videos[0];
                const epParam = firstVid?.episode || 1;
                const sParam = firstVid?.season || 1;
                navigate(`/watch/${folderName}?ep=${epParam}&s=${sParam}&type=${urlType || (isSeriesContent ? 'series' : 'movie')}`);
              }}
              className="bg-[#00dc41] hover:bg-[#00f048] text-black font-bold text-sm px-6 py-2.5 rounded flex items-center gap-2 transition-all hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(0,220,65,0.3)]"
            >
              <Play fill="black" size={16} /> Play
            </button>
            <button className="bg-white/10 hover:bg-white/20 backdrop-blur text-white text-sm px-4 py-2.5 rounded flex items-center gap-2 border border-white/15 transition-all hover:scale-105 active:scale-95">
              <Share2 size={14} /> Share
            </button>
            <button className="bg-white/10 hover:bg-white/20 backdrop-blur text-white text-sm px-4 py-2.5 rounded flex items-center gap-2 border border-white/15 transition-all hover:scale-105 active:scale-95">
              <Clock size={14} /> Watch Later
            </button>
          </div>
        </div>
      </div>

      <div className="sticky top-[64px] z-30 bg-[#111319]/95 backdrop-blur-md border-b border-white/10">
        <div className="px-6 md:px-16 flex items-center gap-6 md:gap-8">
          {tabs.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab.toLowerCase())}
              className={`py-3.5 text-sm font-medium border-b-2 transition-all ${activeTab === tab.toLowerCase()
                  ? 'text-white border-[#00dc41]'
                  : 'text-gray-500 border-transparent hover:text-gray-300'
                }`}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 md:px-16 py-6 animate-fade-in-up" style={{ animationDelay: '0.3s', opacity: 0, animationFillMode: 'forwards' }}>

        {/* ====== EPISODES TAB ====== */}
        {activeTab === 'episodes' && (
          <div>
            <h3 className="text-gray-400 text-sm font-medium mb-4">
              Episodes {videos.length > 0 ? `1-${videos.length}` : '1'}
            </h3>
            {loading ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {[...Array(10)].map((_, i) => (
                  <div key={i} className="animate-pulse">
                    <div className="aspect-video bg-white/5 rounded-lg mb-2"></div>
                    <div className="h-3 w-3/4 bg-white/5 rounded"></div>
                  </div>
                ))}
              </div>
            ) : videos.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {videos.map((video, idx) => {
                  const epData = episodeData[`${video.season || 1}_${video.episode || idx + 1}`];
                  return (
                    <EpisodeCard
                      key={idx}
                      video={video}
                      index={idx}
                      posterFallback={posterPath}
                      tmdbData={epData}
                      onPlay={() => {
                        const epParam = video.episode || idx + 1;
                        const sParam = video.season || 1;
                        navigate(`/watch/${folderName}?ep=${epParam}&s=${sParam}&type=${urlType || (isSeriesContent ? 'series' : 'movie')}`);
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-16 text-gray-500">
                <p className="text-lg mb-2">No episodes available</p>
                <p className="text-sm">Login to access content, or check back later.</p>
              </div>
            )}
          </div>
        )}

        {/* ====== CAST TAB ====== */}
        {activeTab === 'cast' && (
          <CastGrid castList={castList} loading={loading} />
        )}
      </div>

      <LoginModal
        isOpen={showLoginModal}
        onClose={() => setShowLoginModal(false)}
        onLoginSuccess={handleLoginSuccess}
      />
    </div>
  );
};

/* ====== Episode Card ====== */
const EpisodeCard = ({ video, index, posterFallback, tmdbData, onPlay }) => {
  const [isHovered, setIsHovered] = useState(false);
  const episodeNum = video.episode || index + 1;
  const name = tmdbData?.name || video.name || `Episode ${episodeNum}`;
  const imageToUse = tmdbData?.still_path || posterFallback;

  return (
    <div
      className="group cursor-pointer transition-all duration-300"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onPlay}
    >
      <div className="relative aspect-video rounded-lg overflow-hidden bg-[#1a1c22] mb-2 border border-transparent group-hover:border-white/20 transition-colors">
        <img src={imageToUse} alt={name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" />
        <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity duration-300 ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
          <div className="bg-[#00dc41] rounded-full p-3 shadow-[0_0_20px_rgba(0,220,65,0.5)] hover:scale-110 transition-transform">
            <Play fill="black" size={20} className="text-black ml-0.5" />
          </div>
        </div>
        <div className="absolute bottom-2 left-2 bg-black/70 backdrop-blur-sm text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
          EP{episodeNum}
        </div>
      </div>
      <p className="text-[13px] text-gray-300 group-hover:text-[#00dc41] line-clamp-1 transition-colors font-medium">
        {name}
      </p>
    </div>
  );
};

/* ====== Cast Grid ====== */
const CastGrid = ({ castList, loading }) => {
  if (loading) {
    return (
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-4">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="animate-pulse flex flex-col items-center">
            <div className="w-20 h-20 bg-white/5 rounded-full mb-2"></div>
            <div className="h-3 w-16 bg-white/5 rounded"></div>
          </div>
        ))}
      </div>
    );
  }

  if (!castList || castList.length === 0) {
    return (
      <div className="text-center py-16 text-gray-500">
        <User size={40} className="mx-auto mb-3 text-gray-600" />
        <p className="text-lg mb-1">Cast information unavailable</p>
        <p className="text-sm">TMDB data could not be loaded for this title.</p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-gray-400 text-sm font-medium mb-5">Cast & Crew</h3>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-x-4 gap-y-6">
        {castList.map(member => (
          <div key={member.id} className="flex flex-col items-center group cursor-pointer">
            <div className="w-20 h-20 md:w-24 md:h-24 rounded-full overflow-hidden bg-[#1a1c22] mb-2 border-2 border-transparent group-hover:border-[#00dc41]/50 transition-all duration-300 group-hover:shadow-[0_0_15px_rgba(0,220,65,0.2)]">
              {member.profile_path ? (
                <img src={member.profile_path} alt={member.name} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-[#22252b]">
                  <User size={28} className="text-gray-600" />
                </div>
              )}
            </div>
            <p className="text-[12px] text-gray-200 font-medium text-center line-clamp-1 group-hover:text-[#00dc41] transition-colors">
              {member.name}
            </p>
            {member.character && (
              <p className="text-[10px] text-gray-500 text-center line-clamp-1 mt-0.5">
                {member.character}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default ContentDetail;
