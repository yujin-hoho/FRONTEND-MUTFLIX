import { Search, RotateCcw, Globe, User, LogOut } from 'lucide-react';

const Navbar = ({ onMeClick, isLoggedIn, username, onLogout }) => {
  return (
    <nav className="fixed top-0 w-full z-50 px-6 py-4 bg-gradient-to-b from-black/80 to-transparent flex items-center gap-6">
      <div className="text-brand font-black text-3xl md:text-4xl tracking-tight cursor-pointer select-none">
        MUTFLIX
      </div>
      <div className="flex gap-4 lg:gap-8 text-sm md:text-base font-medium text-gray-300 whitespace-nowrap hidden md:flex">
        <a href="#" className="text-white font-bold relative after:content-[''] after:absolute after:w-4 after:h-[3px] after:bg-brand after:-bottom-1 after:left-1/2 after:-translate-x-1/2 after:rounded-full">For You</a>
        <a href="#" className="hover:text-white transition-colors">Pursuit of Jade</a>
        <a href="#" className="hover:text-white transition-colors flex items-center gap-1">More <span className="text-[10px]">▼</span></a>
      </div>
      
      <div className="flex-1 max-w-md xl:max-w-lg relative lg:ml-8 hidden sm:block">
        <input 
          type="text" 
          placeholder="Pursuit of Jade" 
          className="w-full bg-white/10 hover:bg-white/15 text-white text-sm rounded-full py-2.5 px-5 outline-none focus:bg-white/20 transition-all border border-white/10"
        />
        <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5 cursor-pointer hover:text-white"/>
      </div>
      
      <div className="flex flex-1 justify-end gap-5 sm:gap-6 items-center text-xs text-gray-300 font-medium">
        <div className="flex flex-col items-center cursor-pointer hover:text-brand transition group">
          <RotateCcw className="w-5 h-5 mb-0.5 text-gray-400 group-hover:text-brand" />
          <span className="hidden lg:block">History</span>
        </div>
        <div className="flex flex-col items-center cursor-pointer hover:text-brand transition group">
          <Globe className="w-5 h-5 mb-0.5 text-gray-400 group-hover:text-brand" />
          <span className="hidden lg:block">Language</span>
        </div>
        
        {isLoggedIn ? (
          /* Logged in: show username + logout */
          <div className="flex items-center gap-3">
            <div className="flex flex-col items-center cursor-pointer hover:text-brand transition group" onClick={onMeClick}>
              <User className="w-5 h-5 mb-0.5 text-brand" />
              <span className="hidden lg:block text-brand">{username}</span>
            </div>
            <div className="flex flex-col items-center cursor-pointer hover:text-red-400 transition group" onClick={onLogout}>
              <LogOut className="w-5 h-5 mb-0.5 text-gray-400 group-hover:text-red-400" />
              <span className="hidden lg:block">Logout</span>
            </div>
          </div>
        ) : (
          /* Not logged in: show Me button to open login modal */
          <div 
            className="flex flex-col items-center cursor-pointer hover:text-brand transition group relative"
            onClick={onMeClick}
          >
            <div className="absolute top-0 right-0 w-2 h-2 bg-red-500 rounded-full border border-black"></div>
            <User className="w-5 h-5 mb-0.5 text-gray-400 group-hover:text-brand" />
            <span className="hidden lg:block">Me</span>
          </div>
        )}
      </div>
      
      <div className="flex gap-2 sm:gap-3 ml-2 lg:ml-4 flex-shrink-0">
        <button className="hidden xl:flex items-center gap-2 border border-white/20 rounded hover:bg-white/10 transition px-3 py-1.5 h-9">
           <svg xmlns="http://www.000webhost.com" className="w-4 h-4 fill-current text-white hidden" viewBox="0 0 24 24"></svg>
           <span className="text-xs font-semibold">Enjoy on TV</span>
        </button>
        <button className="bg-gradient-to-r from-[#e3c193] to-[#d4a06b] text-black font-extrabold px-3 sm:px-4 py-1.5 rounded h-9 flex items-center gap-1.5 hover:brightness-110 transition shadow-[0_0_15px_rgba(227,193,147,0.3)]">
          <div className="w-4 h-4 rounded-full border-[1.5px] border-black flex items-center justify-center text-[10px]">V</div>
          <span className="text-sm">VIP</span>
        </button>
      </div>
    </nav>
  );
};

export default Navbar;
