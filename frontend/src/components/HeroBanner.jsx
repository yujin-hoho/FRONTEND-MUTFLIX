import { Play, BookmarkPlus } from 'lucide-react';
import { useState, useEffect } from 'react';

const HeroBanner = ({ items }) => {
  const [currentIndex, setCurrentIndex] = useState(0);

  // Auto rotate
  useEffect(() => {
    if (!items || items.length <= 1) return;
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % items.length);
    }, 8000);
    return () => clearInterval(interval);
  }, [items]);

  if (!items || items.length === 0) return <div className="h-[90vh] bg-darkBG animate-pulse w-full"></div>;

  return (
    <div className="relative w-full h-[85vh] md:h-[95vh] bg-darkBG overflow-hidden">
      {items.map((item, index) => {
        const isActive = index === currentIndex;
        const rawPoster = item.tmdb_backdrop_path || item.tmdb_poster_path || item.poster;
        const bgImage = rawPoster 
          ? (rawPoster.startsWith('http') ? rawPoster : `https://image.tmdb.org/t/p/original${rawPoster}`)
          : 'https://images.unsplash.com/photo-1542204165-65bf26472b9b?q=80&w=1974&auto=format&fit=crop';
          
        const title = item.tmdb_title || item.folder_name || item.name || "CORONER'S DIARY";
        const rating = item.tmdb_rating;
        const overview = item.tmdb_overview || "Coroner's Diary is adapted from the novel The Powerful and Favored Coroner Imperial Concubine...";
        // Try to find year from release_date or first_air_date if added in backend, else fallback
        const year = (item.release_date || item.first_air_date || "2024").substring(0, 4);

        return (
          <div 
            key={item.id || index}
            className={`absolute inset-0 w-full h-full transition-opacity duration-1000 ease-in-out ${isActive ? 'opacity-100 z-10' : 'opacity-0 z-0'}`}
          >
            <div className="absolute inset-0 w-full h-full">
              <img 
                src={bgImage} 
                alt={title} 
                className="w-full h-full object-cover object-[center_top]"
              />
              {/* Only bottom fade for overlap section */}
              <div className="absolute inset-x-0 bottom-0 h-[40%] bg-gradient-to-t from-[#111319] to-transparent"></div>
            </div>
            
            <div className={`relative z-10 flex flex-col justify-center h-full px-8 md:px-16 pt-20 pb-12 md:pb-32 max-w-[800px] transition-transform duration-1000 ${isActive ? 'translate-y-0 opacity-100' : 'translate-y-8 opacity-0'} drop-shadow-[0_4px_8px_rgba(0,0,0,0.8)]`}>
              <h1 className="text-4xl md:text-6xl font-black text-white mb-4 leading-tight tracking-tight drop-shadow-[0_2px_15px_rgba(0,0,0,0.8)]">
                {title}
              </h1>
              
              <div className="flex flex-col gap-4 mb-6">
                <div className="bg-brand text-black text-[11px] font-black px-2 py-0.5 rounded-sm w-max uppercase tracking-wider">
                  Featured
                </div>
                
                <div className="flex items-center gap-3 text-sm text-gray-300 font-medium tracking-wide">
                  <span className="text-[#00dc41] font-bold text-lg">★ {rating > 0 ? Number(rating).toFixed(1) : 'NR'}</span>
                  <span className="text-gray-600">|</span>
                  <span>{year}</span>
                  <span className="text-gray-600">|</span>
                  <span>17+</span>
                  <span className="text-gray-600">|</span>
                  <span>{item.media_type === 'tv' || item.type === 'series' || item.episodes ? 'Episodes' : 'Movie'}</span>
                </div>
                
                <div className="flex items-center flex-wrap gap-x-4 gap-y-2 text-[13px] text-gray-400 font-medium">
                  <span className="hover:text-white cursor-pointer transition">Trending</span>
                  <span className="hover:text-white cursor-pointer transition">Must Watch</span>
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
      })}
      
      {/* Rotation Indicators */}
      {items && items.length > 1 && (
        <div className="absolute bottom-10 left-8 md:left-16 flex gap-2 z-20">
          {items.map((_, idx) => (
            <div 
              key={idx} 
              onClick={() => setCurrentIndex(idx)}
              className={`h-1 cursor-pointer transition-all duration-300 rounded-full ${
                idx === currentIndex ? 'w-8 bg-brand' : 'w-4 bg-white/30 hover:bg-white/50'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
};
export default HeroBanner;
