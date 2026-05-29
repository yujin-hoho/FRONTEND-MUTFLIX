import React, { useState, useEffect } from 'react';
import AuthPage from './components/AuthPage';
import ProfileSelection from './components/ProfileSelection';
import Dashboard from './components/Dashboard';

// Flat color helper to match profile selections
const getFlatColorFromSeed = (seed) => {
  const colors = [
    'bg-red-600 shadow-red-950/20',
    'bg-blue-600 shadow-blue-950/20',
    'bg-emerald-600 shadow-emerald-950/20',
    'bg-amber-600 shadow-amber-950/20',
    'bg-purple-600 shadow-purple-950/20',
    'bg-pink-600 shadow-pink-950/20',
    'bg-cyan-600 shadow-cyan-950/20'
  ];
  
  if (!seed) return colors[0];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % colors.length;
  return colors[index];
};

function App() {
  const [currentSession, setCurrentSession] = useState(null);
  const [activeProfile, setActiveProfile] = useState(null);

  // Load session & active profile from localStorage on mount
  useEffect(() => {
    const savedSession = localStorage.getItem('mutflix_session');
    if (savedSession) {
      try {
        const session = JSON.parse(savedSession);
        setCurrentSession(session);
        
        const savedProfile = localStorage.getItem(`mutflix_profile_${session.username}`);
        if (savedProfile) {
          setActiveProfile(JSON.parse(savedProfile));
        }
      } catch (e) {
        localStorage.removeItem('mutflix_session');
      }
    }
  }, []);

  const handleLoginSuccess = (sessionData) => {
    setCurrentSession(sessionData);
    localStorage.setItem('mutflix_session', JSON.stringify(sessionData));
  };

  const handleProfileSelect = (profile) => {
    setActiveProfile(profile);
    if (currentSession) {
      localStorage.setItem(`mutflix_profile_${currentSession.username}`, JSON.stringify(profile));
    }
  };

  const handleSwitchProfile = () => {
    setActiveProfile(null);
    if (currentSession) {
      localStorage.removeItem(`mutflix_profile_${currentSession.username}`);
    }
  };

  const handleLogout = () => {
    if (currentSession) {
      localStorage.removeItem(`mutflix_profile_${currentSession.username}`);
    }
    setCurrentSession(null);
    setActiveProfile(null);
    localStorage.removeItem('mutflix_session');
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col justify-between text-slate-100 font-sans select-none relative overflow-hidden">
      {/* Background radial glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-green-500/5 rounded-full blur-[140px] pointer-events-none"></div>
      
      {/* Top Navigation */}
      <header className="w-full max-w-7xl mx-auto px-6 py-6 flex items-center justify-between z-10">
        <div className="flex items-center gap-2">
          <span className="text-3xl font-extrabold tracking-tighter text-green-500">
            MUTFLIX
          </span>
        </div>
        
        {currentSession && (
          <div className="flex items-center gap-4">
            {activeProfile && (
              <button 
                onClick={handleSwitchProfile}
                className="hidden sm:flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400 hover:text-white transition-colors"
              >
                Ganti Profil
              </button>
            )}
            <button 
              onClick={handleLogout}
              className="px-3.5 py-1.5 bg-slate-900 border border-slate-800 hover:bg-green-950/30 hover:border-green-800/40 text-slate-400 hover:text-green-400 text-xs font-semibold rounded-lg uppercase tracking-wider transition-all"
            >
              Keluar
            </button>
          </div>
        )}
      </header>

      {/* Main Content Area */}
      <main className="flex-1 flex items-center justify-center p-6 z-10">
        {!currentSession ? (
          // 1. Auth Stage (Login/Signup)
          <AuthPage 
            onLoginSuccess={handleLoginSuccess}
            currentSession={null}
            onLogout={handleLogout}
          />
        ) : !activeProfile ? (
          // 2. Profile Selection Stage
          <ProfileSelection 
            session={currentSession}
            onProfileSelect={handleProfileSelect}
          />
        ) : (
          // 3. Main Dashboard Stage (Authorized & Profile Selected)
          <Dashboard 
            session={currentSession}
            activeProfile={activeProfile}
            onSwitchProfile={handleSwitchProfile}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="w-full max-w-7xl mx-auto px-6 py-8 border-t border-slate-900/60 z-10 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-slate-500">
        <div>
          &copy; {new Date().getFullYear()} MUTFLIX. Semua Hak Dilindungi.
        </div>
        <div className="flex gap-4">
          <a href="#" className="hover:text-slate-300 transition-colors">Syarat Penggunaan</a>
          <a href="#" className="hover:text-slate-300 transition-colors">Kebijakan Privasi</a>
          <a href="#" className="hover:text-slate-300 transition-colors">Bantuan</a>
        </div>
      </footer>
    </div>
  );
}

export default App;
