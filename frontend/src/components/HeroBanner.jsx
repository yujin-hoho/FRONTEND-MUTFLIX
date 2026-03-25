import { Play, BookmarkPlus } from 'lucide-react';
import { useState, useEffect } from 'react';
import { getTMDBInfo } from '../services/api';

const HeroBanner = ({ item }) => {
  const [tmdbData, setTmdbData] = useState(null);

  useEffect(() => {
    const title = item?.tmdb_title || item?.folder_name || item?.name;
    // Only fetch from TMDB if backend didn't provide poster
    if (title && !item.tmdb_poster_path && !item.poster) {
      getTMDBInfo(title).then(data => {
        if (data) setTmdbData(data);
      });
    }
  }, [item]);

  if (!item) return <div className="h-[90vh] bg-darkBG animate-pulse w-full"></div>;

  const rawPoster = item.tmdb_poster_path || item.poster || tmdbData?.backdrop_path || tmdbData?.poster_path;
  const bgImage = rawPoster 
    ? (rawPoster.startsWith('http') ? rawPoster : `https://image.tmdb.org/t/p/original${rawPoster}`)
    : 'https://images.unsplash.com/photo-1542204165-65bf26472b9b?q=80&w=1974&auto=format&fit=crop';
    
  const title = item.tmdb_title || item.folder_name || item.name || "CORONER'S DIARY";
  const rating = item.tmdb_rating || tmdbData?.rating || 9.8;
  const overview = item.tmdb_overview || tmdbData?.overview || "Coroner's Diary is adapted from the novel The Powerful and Favored Coroner Imperial Concubine...";
  const year = (tmdbData?.date || "2025").substring(0, 4);

  return (
    <div className="relative w-full h-[85vh] md:h-[95vh] bg-darkBG overflow-hidden animate-fade-in">
      <div className="absolute inset-0 w-full h-full">
        <img 
          src={bgImage} 
          alt={title} 
          className="w-full h-full object-cover object-top opacity-70 transition-opacity duration-1000"
        />
        {/* Gradients to seamlessly blend the image into the dark background */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#111319] via-[#111319]/80 to-transparent w-full md:w-2/3"></div>
        <div className="absolute inset-0 bg-gradient-to-t from-[#111319] via-[#111319]/40 to-transparent h-full"></div>
      </div>
      
      <div className="relative z-10 flex flex-col justify-center h-full px-8 md:px-16 pt-20 pb-12 md:pb-24 max-w-[800px] animate-slide-up">
        <h1 className="text-5xl md:text-6xl font-serif text-white tracking-widest mb-6 uppercase text-shadow drop-shadow-2xl">
          {title}
        </h1>
        
        <div className="flex flex-col gap-4 mb-6">
          <div className="bg-brand text-black text-[11px] font-black px-2 py-0.5 rounded-sm w-max uppercase tracking-wider">
            Original
          </div>
          
          <div className="flex items-center gap-3 text-sm text-gray-300 font-medium tracking-wide">
            <span className="flex items-center text-brand font-bold gap-1 text-base drop-shadow-md">
              ★ {Number(rating).toFixed(1)}
            </span>
            <span className="text-gray-600">|</span>
            <span>{year}</span>
            <span className="text-gray-600">|</span>
            <span>17+</span>
            <span className="text-gray-600">|</span>
            <span>38 Episodes</span>
          </div>
          
          <div className="flex items-center flex-wrap gap-x-4 gap-y-2 text-[13px] text-gray-400 font-medium">
            <span className="hover:text-white cursor-pointer transition">Chinese Mainland</span>
            <span className="hover:text-white cursor-pointer transition">Romance</span>
            <span className="hover:text-white cursor-pointer transition">Costume</span>
            <span className="hover:text-white cursor-pointer transition">Mandarin</span>
            <span className="hover:text-white cursor-pointer transition">Drama</span>
          </div>
        </div>
        
        <p className="text-gray-400 text-[15px] mb-10 line-clamp-3 md:line-clamp-2 leading-relaxed max-w-xl pr-4">
          "{overview}"
        </p>
        
        <div className="flex gap-4">
          <button className="bg-brand hover:brightness-[1.15] text-white rounded-full h-[52px] w-[52px] flex items-center justify-center transition-all hover:scale-110 active:scale-95 shadow-[0_0_20px_rgba(0,220,65,0.4)]">
            <Play fill="black" size={24} className="ml-1 text-black" />
          </button>
          <button className="bg-white/10 hover:bg-white/20 backdrop-blur-md text-white rounded-full h-[52px] w-[52px] border border-white/20 flex items-center justify-center transition-all hover:scale-110 active:scale-95">
            <BookmarkPlus size={24} />
          </button>
        </div>
      </div>
    </div>
  );
};
export default HeroBanner;
