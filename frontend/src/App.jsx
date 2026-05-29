import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import AuthPage from './components/AuthPage';
import ProfileSelection from './components/ProfileSelection';
import Dashboard from './components/Dashboard';
import MovieDetail from './components/MovieDetail';
import SeriesDetail from './components/SeriesDetail';

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
  const [currentSession, setCurrentSession] = useState(() => {
    const savedSession = localStorage.getItem('mutflix_session');
    if (savedSession) {
      try {
        return JSON.parse(savedSession);
      } catch (e) {
        localStorage.removeItem('mutflix_session');
      }
    }
    return null;
  });

  const [activeProfile, setActiveProfile] = useState(() => {
    const savedSession = localStorage.getItem('mutflix_session');
    if (savedSession) {
      try {
        const session = JSON.parse(savedSession);
        const savedProfile = localStorage.getItem(`mutflix_profile_${session.username}`);
        if (savedProfile) {
          return JSON.parse(savedProfile);
        }
      } catch (e) {
        // Safe to ignore
      }
    }
    return null;
  });

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
    <Router>
      <div className="min-h-screen bg-[#18181b] flex flex-col justify-between text-slate-100 font-sans select-none relative overflow-x-hidden">
        
        {/* Top Navigation (Only shown for non-authenticated/non-profile views to avoid overlapping Dashboard header) */}
        {(!currentSession || !activeProfile) && (
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
                  Sign Out
                </button>
              </div>
            )}
          </header>
        )}

        {/* Main Content Area */}
        <main className={`flex-1 flex z-10 ${
          (currentSession && activeProfile) 
            ? 'items-start justify-start p-0 w-full' 
            : 'items-center justify-center p-6'
        }`}>
          <Routes>
            <Route path="/" element={
              !currentSession ? (
                <AuthPage 
                  onLoginSuccess={handleLoginSuccess}
                  currentSession={null}
                  onLogout={handleLogout}
                />
              ) : !activeProfile ? (
                <ProfileSelection 
                  session={currentSession}
                  onProfileSelect={handleProfileSelect}
                />
              ) : (
                <Navigate to="/dashboard" replace />
              )
            } />

            <Route path="/dashboard" element={
              (currentSession && activeProfile) ? (
                <Dashboard 
                  session={currentSession}
                  activeProfile={activeProfile}
                  onSwitchProfile={handleSwitchProfile}
                  onLogout={handleLogout}
                />
              ) : (
                <Navigate to="/" replace />
              )
            } />

            <Route path="/movie/:id" element={
              (currentSession && activeProfile) ? (
                <MovieDetail 
                  session={currentSession}
                  activeProfile={activeProfile}
                />
              ) : (
                <Navigate to="/" replace />
              )
            } />

            <Route path="/series/:id" element={
              (currentSession && activeProfile) ? (
                <SeriesDetail 
                  session={currentSession}
                  activeProfile={activeProfile}
                />
              ) : (
                <Navigate to="/" replace />
              )
            } />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
