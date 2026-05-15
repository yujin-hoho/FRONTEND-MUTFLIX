import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { Play, Share2, Clock, ChevronDown, ChevronUp, User } from 'lucide-react';
import Navbar from '../components/Navbar';
import LoginModal from '../components/LoginModal';
import { fetchVideos, getTMDBInfo, getTMDBCredits, getTMDBSeasonDetails, logout, fetchProfiles, fetchHistory, fetchMyList, addToMyList, removeFromMyList, fetchFolders } from '../services/api';
import Footer from '../components/Footer';
import LoadingScreen from '../components/LoadingScreen';
import { cleanTitleOutsideParentheses } from '../utils/cleanTitle';
import { findCatalogItemForDetail, mergeDetailMetadata, tmdbOptsFromCatalogItem } from '../utils/detailMetadata';
import { EPISODE_PLACEHOLDER_IMAGE } from '../utils/placeholders';

const ContentDetail = () => {
  const { folderName } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const decodedName = decodeURIComponent(folderName);
  const urlType = searchParams.get('type'); // 'movie' or 'series'
  const navigationDetailItem = location.state?.detailItem;
  const initialDetailMetadata = useMemo(
    () => mergeDetailMetadata(navigationDetailItem || { folder_name: decodedName }, null, decodedName, urlType),
    [navigationDetailItem, decodedName, urlType]
  );

  const toInt = (value, fallback) => {
    const n =
      value == null || value === '' ? NaN : typeof value === 'string' ? parseInt(value, 10) : Number(value);
    return Number.isFinite(n) && !Number.isNaN(n) ? n : fallback;
  };

  const [videos, setVideos] = useState([]);
  const [tmdbData, setTmdbData] = useState(initialDetailMetadata);
  const [credits, setCredits] = useState(null);
  const [episodeData, setEpisodeData] = useState({});
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('episodes');
  const [expandedDesc, setExpandedDesc] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [authUser, setAuthUser] = useState(() => {
    const username = localStorage.getItem('username');
    const role = localStorage.getItem('role');
    return username ? { username, role } : null;
  });
  const [historyMap, setHistoryMap] = useState({});
  const [lastWatchedMedia, setLastWatchedMedia] = useState(null);
  const [isInMyList, setIsInMyList] = useState(false);
  const [profileId, setProfileId] = useState(localStorage.getItem('mutflix_last_profile_id'));
  const [isUpdatingList, setIsUpdatingList] = useState(false);

  // Cache TMDB season episode info so when user switches seasons we don't refetch.
  const fetchedSeasonStillsRef = useRef(new Set());

  // Important: even if TMDB API key is missing (tmdbData=null) and `type` query param is wrong,
  // we still detect series using `videos.length > 1` so Episodes tab won't disappear.
  const isSeriesContent = urlType === 'series' || (tmdbData?.media_type === 'tv') || videos.length > 1;

  const uniqueSeasons = useMemo(
    () => [...new Set(videos.map(v => toInt(v.season, 1)))].sort((a, b) => a - b),
    [videos]
  );
  const [detailSeason, setDetailSeason] = useState(1);
  const episodesForSeason = useMemo(
    () => videos.filter(v => toInt(v.season, 1) === toInt(detailSeason, 1)),
    [videos, detailSeason]
  );
  const episodesToShow = episodesForSeason.length > 0 ? episodesForSeason : videos;

  useEffect(() => {
    if (videos.length === 0) return;
    setDetailSeason((prev) => (uniqueSeasons.includes(prev) ? prev : uniqueSeasons[0]));
  }, [videos, uniqueSeasons]);

  useEffect(() => {
    if (lastWatchedMedia) {
      setDetailSeason(lastWatchedMedia.season || 1);
    }
  }, [lastWatchedMedia]);

  useEffect(() => {
    let isMounted = true;
    const loadData = async () => {
      setLoading(true);
      setLastWatchedMedia(null);
      setEpisodeData({});
      setTmdbData(initialDetailMetadata);
      setCredits(null);
      fetchedSeasonStillsRef.current = new Set();
      try {
        const fallbackCatalogItem = navigationDetailItem || { folder_name: decodedName };
        const foldersPromise = navigationDetailItem ? Promise.resolve(null) : fetchFolders();

        const loadVisualMetadata = (catalogItem) => {
          const tmdbSearchTitle = catalogItem.tmdb_query || catalogItem.tmdb_title || catalogItem.folder_name || catalogItem.name || decodedName;
          const immediateMetadata = mergeDetailMetadata(catalogItem, null, decodedName, urlType);
          setTmdbData(immediateMetadata);

          getTMDBInfo(tmdbSearchTitle, tmdbOptsFromCatalogItem(catalogItem, urlType))
            .then(async (tmdb) => {
              if (!isMounted) return;
              const detailMetadata = mergeDetailMetadata(catalogItem, tmdb, decodedName, urlType);
              setTmdbData(detailMetadata);
              if (detailMetadata?.tmdb_id) {
                const creditsData = await getTMDBCredits(detailMetadata.tmdb_id, detailMetadata.media_type);
                if (isMounted) setCredits(creditsData);
              }
            })
            .catch(() => { /* ignore */ });
        };

        const videosResp = await fetchVideos(decodedName);
        
        if (!isMounted) return;

        const videosListRaw = videosResp?.videos || [];
        const videosList = videosListRaw.map((v) => ({
          ...v,
          season: toInt(v.season, 1),
          episode: toInt(v.episode, 1),
        }));
        videosList.sort((a, b) => {
          if (a.season !== b.season) return (a.season || 1) - (b.season || 1);
          return (a.episode || 0) - (b.episode || 0);
        });

        setVideos(videosList);
        setTmdbData((prev) => prev || mergeDetailMetadata(fallbackCatalogItem, null, decodedName, urlType));

        // Compute active tab from the fastest available data (don't block UI).
        const isSeries = urlType === 'series' || (fallbackCatalogItem?.media_type === 'tv') || videosList.length > 1;
        setActiveTab(isSeries ? 'episodes' : 'cast');
        setLoading(false);

        // Step 2: Background fetches (non-blocking).
        // 2a. Visual Metadata. Episode stills are lazy-loaded per season after TMDB id is known.
        if (navigationDetailItem) {
          loadVisualMetadata(navigationDetailItem);
        } else {
          foldersPromise.then((foldersResp) => {
            if (!isMounted) return;
            loadVisualMetadata(findCatalogItemForDetail(foldersResp, decodedName) || fallbackCatalogItem);
          }).catch(() => {
            if (isMounted) loadVisualMetadata(fallbackCatalogItem);
          });
        }

        // 2b. User Data (History, My List)
        if (authUser) {
          fetchProfiles().then(async (profiles) => {
            if (!isMounted || profiles.length === 0) return;
            
            const pid = profileId || profiles[0].id;
            if (!profileId) setProfileId(pid);

            const [profileHistory, mylistData] = await Promise.all([
              fetchHistory(pid),
              fetchMyList(pid)
            ]);

            if (!isMounted) return;

            // Mapping History
            const flatHistory = profileHistory;
            const newHistoryMap = {};
            // Newer history should overwrite older items
            flatHistory.sort((a, b) => new Date(a.last_watched) - new Date(b.last_watched));
            flatHistory.forEach(h => {
              const progress = (h.position_ms / h.duration_ms) * 100;
              if (h.position_ms >= 5000) newHistoryMap[h.media_path] = { progress, position_ms: h.position_ms };
            });

            // "Continue Watching" Logic
            const relevant = flatHistory
              .filter(h => h.media_path.includes(decodedName) || h.series_title === decodedName || h.media_title === decodedName)
              .sort((a, b) => new Date(b.last_watched) - new Date(a.last_watched));

            if (relevant.length > 0) {
              const last = relevant[0];
              const match = videosList.find(v => v.path === last.media_path);
              if (match) setLastWatchedMedia({ ...match, position_ms: last.position_ms });
            }

            setHistoryMap(newHistoryMap);
            setIsInMyList((mylistData || []).some(item => item.folder_name === decodedName));
          }).catch(() => { /* ignore */ });
        }
      } catch (err) {
        console.error("Error loading ContentDetail:", err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    loadData();
    return () => { isMounted = false; };
  }, [decodedName, urlType, authUser, profileId, navigationDetailItem, initialDetailMetadata]);

  useEffect(() => {
    const onProfileChange = (event) => {
      if (event.detail?.id) setProfileId(event.detail.id);
    };
    window.addEventListener('mutflix-profile-change', onProfileChange);
    return () => window.removeEventListener('mutflix-profile-change', onProfileChange);
  }, []);

  // Lazy-load episode stills + episode names per selected season.
  useEffect(() => {
    if (!tmdbData?.tmdb_id) return;
    if (!isSeriesContent) return;
    if (!detailSeason) return;

    const seasonNum = toInt(detailSeason, 1);
    if (fetchedSeasonStillsRef.current.has(seasonNum)) return;
    void getTMDBSeasonDetails(tmdbData.tmdb_id, seasonNum)
      .then((seasonData) => {
        if (seasonData?.episodes) {
          const dataMap = {};
          seasonData.episodes.forEach((ep) => {
            dataMap[`${seasonNum}_${ep.episode_number}`] = {
              still_path: ep.still_path
                ? `https://image.tmdb.org/t/p/w500${ep.still_path.startsWith('/') ? ep.still_path : `/${ep.still_path}`}`
                : null,
              name: ep.name
            };
          });
          setEpisodeData((prev) => ({ ...prev, ...dataMap }));
        }
        fetchedSeasonStillsRef.current.add(seasonNum);
      })
      .catch(() => { /* ignore */ });
  }, [tmdbData?.tmdb_id, detailSeason, isSeriesContent]);

  const handleToggleMyList = async () => {
    if (!authUser) {
      setShowLoginModal(true);
      return;
    }
    if (!profileId || isUpdatingList) return;

    setIsUpdatingList(true);
    try {
      if (isInMyList) {
        const success = await removeFromMyList(profileId, decodedName);
        if (success) setIsInMyList(false);
      } else {
        const mediaType = urlType === 'series' || tmdbData?.media_type === 'tv' ? 'tv' : 'movie';
        // Pass meta from tmdbData for the My List page to use
        const meta = {
          tmdb_poster_path: tmdbData?.poster_path,
          tmdb_rating: tmdbData?.rating,
          tmdb_title: tmdbData?.tmdb_title || decodedName
        };
        const success = await addToMyList(profileId, decodedName, mediaType, meta);
        if (success) setIsInMyList(true);
      }
    } catch (err) {
      console.error("Error updating My List:", err);
    } finally {
      setIsUpdatingList(false);
    }
  };

  const handleLoginSuccess = (data) => {
    setAuthUser({ username: data.username, role: data.role });
  };
  const handleLogout = () => {
    logout();
    setAuthUser(null);
  };

  const title =
    cleanTitleOutsideParentheses(tmdbData?.tmdb_title || tmdbData?.title || decodedName) ||
    (tmdbData?.tmdb_title || tmdbData?.title || decodedName);
  const rating = tmdbData?.rating;
  const overview = tmdbData?.overview || "No description available for this title.";
  const year = tmdbData?.date ? tmdbData.date.substring(0, 4) : "";
  const totalEpisodes = tmdbData?.total_episodes || videos.length;
  const directorName = credits?.director || 'Unknown';
  const castList = credits?.cast || [];
  const castNames = castList.map(c => c.name).slice(0, 8).join(', ') || 'Cast information unavailable';

  const normalizeImageUrl = (path, size) => {
    if (!path || typeof path !== 'string') return '';
    if (path.startsWith('http')) return path;
    return `https://image.tmdb.org/t/p/${size}${path.startsWith('/') ? path : `/${path}`}`;
  };

  const backdropPath =
    normalizeImageUrl(tmdbData?.backdrop_path, 'w1280') ||
    normalizeImageUrl(tmdbData?.poster_path, 'w780') ||
    'https://images.unsplash.com/photo-1542204165-65bf26472b9b?q=80&w=1974&auto=format&fit=crop';

  const tabs = isSeriesContent ? ['Episodes', 'Cast'] : ['Cast'];

  if (loading && !tmdbData) {
    return <LoadingScreen />;
  }

  return (
    <div className="min-h-screen bg-[#111319] font-sans text-white flex flex-col overflow-x-hidden animate-page-enter">
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
          <img
            src={backdropPath}
            alt={title}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            className="w-full h-full object-cover object-top opacity-60"
          />
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
            <span className="border border-gray-600 px-1.5 rounded-sm text-[11px]">
              {tmdbData?.media_type === 'movie' ? 'Movie' : (tmdbData?.total_seasons ? `${tmdbData.total_seasons} Seasons` : 'TV Series')}
            </span>
            <span className="text-gray-600">|</span>
            <span>{year}</span>
            {isSeriesContent && (
              <>
                <span className="text-gray-600">|</span>
                <span>Updated to {videos.length}/Total {totalEpisodes} Episodes</span>
              </>
            )}
            {tmdbData?.runtime && (
              <>
                <span className="text-gray-600">|</span>
                <span>{tmdbData.runtime} min</span>
              </>
            )}
          </div>

          {/* Genre Tags */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            {tmdbData?.genres && tmdbData.genres.length > 0 ? tmdbData.genres.map((genre, idx) => (
              <span key={idx} className="bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white text-[12px] font-medium px-3 py-1 rounded-full cursor-pointer transition border border-white/10">
                {genre.name}
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
                const target = lastWatchedMedia || videos[0] || { episode: 1, season: 1 };
                const epParam = target.episode || 1;
                const sParam = target.season || 1;
                let targetUrl = `/watch/${folderName}?ep=${epParam}&s=${sParam}&type=${urlType || (isSeriesContent ? 'series' : 'movie')}`;
                if (target.position_ms) {
                  targetUrl += `&t=${Math.floor(target.position_ms / 1000)}`;
                }
                navigate(targetUrl, {
                  state: {
                    watchMeta: {
                      tmdbData,
                      episodeData,
                    },
                  },
                });
              }}
              className="bg-[#00dc41] hover:bg-[#00f048] text-black font-bold text-sm px-6 py-2.5 rounded flex items-center gap-2 transition-all hover:scale-105 active:scale-95 shadow-[0_0_20px_rgba(0,220,65,0.3)]"
            >
              <Play fill="black" size={16} /> {lastWatchedMedia ? 'Resume' : 'Play'}
            </button>
            <button className="bg-white/10 hover:bg-white/20 backdrop-blur text-white text-sm px-4 py-2.5 rounded flex items-center gap-2 border border-white/15 transition-all hover:scale-105 active:scale-95">
              <Share2 size={14} /> Share
            </button>
            <button 
              onClick={handleToggleMyList}
              disabled={isUpdatingList}
              className={`${isInMyList ? 'bg-brand/20 text-brand border-brand/30' : 'bg-white/10 text-white border-white/15'} hover:bg-white/20 backdrop-blur text-sm px-4 py-2.5 rounded flex items-center gap-2 border transition-all hover:scale-105 active:scale-95`}
            >
              <Clock size={14} className={isInMyList ? 'fill-brand' : ''} /> {isInMyList ? 'In My List' : 'Watch Later'}
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
            {isSeriesContent && uniqueSeasons.length > 1 && (
              <div className="flex items-center gap-2 mb-4 overflow-x-auto no-scrollbar pb-1">
                {uniqueSeasons.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setDetailSeason(s)}
                    className={`px-3 py-1.5 rounded-full text-[12px] font-bold transition whitespace-nowrap ${detailSeason === s
                      ? 'bg-white/10 text-white'
                      : 'bg-transparent text-gray-500 hover:text-white'
                      }`}
                  >
                    Season {s}
                  </button>
                ))}
              </div>
            )}
            <h3 className="text-gray-400 text-sm font-medium mb-4">
              {isSeriesContent && uniqueSeasons.length > 1
                ? `Season ${detailSeason} · ${episodesToShow.length} episode${episodesToShow.length === 1 ? '' : 's'}`
                : `Episodes ${videos.length > 0 ? `1–${videos.length}` : '—'}`}
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
                {episodesToShow.map((video, idx) => {
                  const epData = episodeData[`${video.season || 1}_${video.episode || idx + 1}`];
                  return (
                    <EpisodeCard
                      key={video.path || `${video.season}_${video.episode}_${idx}`}
                      video={video}
                      index={idx}
                      tmdbData={epData}
                      progress={historyMap[video.path]?.progress}
                      onPlay={() => {
                        const epParam = video.episode || idx + 1;
                        const sParam = video.season || 1;
                        let targetUrl = `/watch/${folderName}?ep=${epParam}&s=${sParam}&type=${urlType || (isSeriesContent ? 'series' : 'movie')}`;
                        const pos = historyMap[video.path]?.position_ms;
                        if (pos) {
                          targetUrl += `&t=${Math.floor(pos / 1000)}`;
                        }
                        navigate(targetUrl, {
                          state: {
                            watchMeta: {
                              tmdbData,
                              episodeData,
                            },
                          },
                        });
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
      <Footer />
    </div>
  );
};

/* ====== Episode Card ====== */
const EpisodeCard = ({ video, index, tmdbData, onPlay, progress }) => {
  const [isHovered, setIsHovered] = useState(false);
  const episodeNum = video.episode || index + 1;
  const name = tmdbData?.name || video.name || `Episode ${episodeNum}`;
  const imageToUse = tmdbData?.still_path || EPISODE_PLACEHOLDER_IMAGE;

  return (
    <div
      className="group cursor-pointer transition-all duration-300"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onPlay}
    >
      <div className="relative aspect-video rounded-lg overflow-hidden bg-[#1a1c22] mb-2 border border-transparent group-hover:border-white/20 transition-colors">
        <img
          src={imageToUse}
          alt={name}
          loading="lazy"
          decoding="async"
          className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
        />
        <div className={`absolute inset-0 bg-black/40 flex items-center justify-center transition-opacity duration-300 ${isHovered ? 'opacity-100' : 'opacity-0'}`}>
          <div className="bg-[#00dc41] rounded-full p-3 shadow-[0_0_20px_rgba(0,220,65,0.5)] hover:scale-110 transition-transform">
            <Play fill="black" size={20} className="text-black ml-0.5" />
          </div>
        </div>
        <div className="absolute bottom-2 left-2 bg-black/70 backdrop-blur-sm text-white text-[10px] font-bold px-1.5 py-0.5 rounded">
          EP{episodeNum}
        </div>
        {progress !== undefined && (
          <div className="absolute bottom-0 left-0 w-full bg-white/20 h-[3px] overflow-hidden">
            <div 
              className="bg-[#00dc41] h-full transition-all duration-300" 
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            ></div>
          </div>
        )}
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
                <img
                  src={member.profile_path}
                  alt={member.name}
                  loading="lazy"
                  decoding="async"
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                />
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
