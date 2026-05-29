import React, { useState, useEffect } from 'react';

// API Helper to handle dev/prod URL matching with HuggingFace Space
const getApiUrl = (path) => {
  if (window.location.hostname.endsWith('melancholia112-mutflix.hf.space')) {
    return path;
  }
  return `https://melancholia112-mutflix.hf.space${path}`;
};

// Netflix Classic Smiley Face SVG Component
export function NetflixSmiley({ className = "w-full h-full text-white" }) {
  return (
    <svg viewBox="0 0 100 100" className={className} fill="currentColor">
      {/* Sleek Netflix-Style Eyes */}
      <rect x="32" y="32" width="10" height="20" rx="5" />
      <rect x="58" y="32" width="10" height="20" rx="5" />
      {/* Sleek Netflix-Style Smile */}
      <path d="M25 62 C 35 76, 65 76, 75 62" stroke="currentColor" strokeWidth="7" strokeLinecap="round" fill="none" />
    </svg>
  );
}

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

export default function ProfileSelection({ session, onProfileSelect }) {
  const [profiles, setProfiles] = useState([]);
  const [isManageMode, setIsManageMode] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modals / Editors state
  const [activeModal, setActiveModal] = useState(null); // 'add' | 'edit' | null
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [modalData, setModalData] = useState({ name: '', seed: '' });
  const [isActionLoading, setIsActionLoading] = useState(false);
  const [verifyingProfileId, setVerifyingProfileId] = useState(null);

  const handleProfileSelectClick = async (profile) => {
    setVerifyingProfileId(profile.id);
    setError(null);
    try {
      // Fetch watch history to verify backend database connection is 100% active & authenticated
      const response = await fetch(getApiUrl(`/api/history/get/${profile.id}`), {
        headers: {
          'x-access-token': session.token
        }
      });
      
      if (!response.ok) {
        throw new Error(`Profile database connection failed (Status: ${response.status}).`);
      }
      
      // Connection successfully verified! Proceed to dashboard
      onProfileSelect(profile);
    } catch (err) {
      setError(`Failed to connect profile "${profile.name}": ${err.message || 'Please try again.'}`);
    } finally {
      setVerifyingProfileId(null);
    }
  };

  const fetchProfiles = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(getApiUrl('/api/profiles'), {
        headers: {
          'x-access-token': session.token
        }
      });
      if (!response.ok) {
        throw new Error('Failed to load user profiles.');
      }
      const data = await response.json();
      setProfiles(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchProfiles();
  }, [session.token]);

  const handleAddProfileOpen = () => {
    setModalData({ name: '', seed: Math.random().toString(36).substring(7) });
    setActiveModal('add');
  };

  const handleEditProfileOpen = (profile) => {
    setSelectedProfile(profile);
    setModalData({ name: profile.name, seed: profile.avatar_seed || profile.id });
    setActiveModal('edit');
  };

  const handleAddProfileSubmit = async (e) => {
    e.preventDefault();
    if (!modalData.name.trim()) return;
    setIsActionLoading(true);

    const newProfile = {
      id: Math.random().toString(36).substring(2, 11), // unique string id
      name: modalData.name.trim(),
      avatar_seed: modalData.seed || Math.random().toString(36).substring(7)
    };

    try {
      const response = await fetch(getApiUrl('/api/profiles/add'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-access-token': session.token
        },
        body: JSON.stringify(newProfile)
      });

      if (!response.ok) {
        throw new Error('Failed to add new profile.');
      }

      await fetchProfiles();
      setActiveModal(null);
    } catch (err) {
      alert(err.message);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleEditProfileSubmit = async (e) => {
    e.preventDefault();
    if (!modalData.name.trim() || !selectedProfile) return;
    setIsActionLoading(true);

    const payload = {
      id: selectedProfile.id,
      name: modalData.name.trim(),
      avatar_seed: modalData.seed
    };

    try {
      const response = await fetch(getApiUrl('/api/profiles/edit'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-access-token': session.token
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error('Failed to update profile.');
      }

      await fetchProfiles();
      setActiveModal(null);
    } catch (err) {
      alert(err.message);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDeleteProfile = async (profileId) => {
    if (!confirm('Are you sure you want to delete this profile and all of its watch history?')) return;
    setIsActionLoading(true);

    try {
      const response = await fetch(getApiUrl('/api/profiles/delete'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-access-token': session.token
        },
        body: JSON.stringify({ id: profileId })
      });

      if (!response.ok) {
        throw new Error('Failed to delete profile.');
      }

      await fetchProfiles();
      setActiveModal(null);
    } catch (err) {
      alert(err.message);
    } finally {
      setIsActionLoading(false);
    }
  };

  return (
    <div className="w-full max-w-5xl mx-auto flex flex-col items-center justify-center py-12 px-6 relative z-10 select-none">
      
      {/* Title */}
      <div className="text-center space-y-3 mb-12">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-white animate-fadeIn">
          {isManageMode ? 'Manage Profiles' : "Who's Watching?"}
        </h1>
        <p className="text-slate-400 text-sm sm:text-base">
          {isManageMode 
            ? 'Select a profile to modify or delete.' 
            : 'Choose your profile to start exploring the catalog.'}
        </p>
      </div>

      {/* Loading state */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-12 space-y-4">
          <svg className="animate-spin h-10 w-10 text-green-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <span className="text-slate-400 text-sm tracking-wide">Loading profiles...</span>
        </div>
      ) : error ? (
        <div className="text-center py-12 space-y-4 max-w-md">
          <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 p-4 rounded-xl">
            {error}
          </p>
          <button 
            onClick={fetchProfiles} 
            className="px-5 py-2 bg-slate-900 border border-slate-800 hover:bg-slate-800 text-sm font-semibold rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      ) : (
        <div className="w-full">
          {/* Profiles Grid */}
          <div className="flex flex-wrap justify-center gap-8 md:gap-12 py-6">
            
            {profiles.map((profile) => {
              const isVerifying = verifyingProfileId === profile.id;
              return (
                <div 
                  key={profile.id} 
                  className={`group flex flex-col items-center space-y-3 ${isVerifying ? 'pointer-events-none' : 'cursor-pointer'}`}
                  onClick={() => {
                    if (isManageMode) {
                      handleEditProfileOpen(profile);
                    } else if (!isVerifying) {
                      handleProfileSelectClick(profile);
                    }
                  }}
                >
                  {/* Avatar Display */}
                  <div className="relative">
                    <div className={`w-28 h-28 sm:w-32 sm:h-32 rounded-2xl ${getFlatColorFromSeed(profile.avatar_seed)} flex items-center justify-center text-3xl sm:text-4xl font-extrabold text-white shadow-lg transition-all duration-300 group-hover:scale-105 group-hover:ring-4 group-hover:ring-slate-100 group-hover:-translate-y-1 relative`}>
                      {isVerifying ? (
                        <svg className="animate-spin h-8 w-8 text-white" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                      ) : (
                        <NetflixSmiley className="w-16 h-16 text-white/95" />
                      )}
                      
                      {/* Management Overlays */}
                      {isManageMode && (
                        <div className="absolute inset-0 bg-black/60 rounded-2xl flex items-center justify-center opacity-100 transition-opacity">
                          <svg className="w-8 h-8 text-white/90 drop-shadow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {/* Profile Name */}
                  <span className="text-slate-400 text-base sm:text-lg group-hover:text-white transition-colors tracking-wide max-w-[120px] truncate">
                    {isVerifying ? 'Verifying...' : profile.name}
                  </span>
                </div>
              );
            })}

            {/* Add Profile Card */}
            {profiles.length < 5 && (
              <div 
                className="group flex flex-col items-center space-y-3 cursor-pointer"
                onClick={handleAddProfileOpen}
              >
                <div className="w-28 h-28 sm:w-32 sm:h-32 rounded-2xl border-2 border-dashed border-slate-800 hover:border-slate-400 flex items-center justify-center text-slate-600 hover:text-slate-200 transition-all duration-300 group-hover:scale-105 group-hover:-translate-y-1">
                  <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                </div>
                <span className="text-slate-500 text-base sm:text-lg group-hover:text-slate-300 transition-colors tracking-wide">
                  Add Profile
                </span>
              </div>
            )}
          </div>

          {/* Manage Actions */}
          <div className="flex justify-center mt-16">
            <button
              onClick={() => setIsManageMode(!isManageMode)}
              className={`px-8 py-2.5 border text-sm font-semibold rounded-lg tracking-wide uppercase transition-all active:scale-[0.98] ${
                isManageMode 
                  ? 'border-green-700 bg-green-700/10 text-green-500 hover:bg-green-700/20' 
                  : 'border-slate-700 text-slate-400 hover:border-slate-300 hover:text-white'
              }`}
            >
              {isManageMode ? 'Done Managing' : 'Manage Profiles'}
            </button>
          </div>
        </div>
      )}

      {/* Add / Edit Profile Modal */}
      {activeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-slate-950/80 backdrop-blur-md animate-fadeIn">
          <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 sm:p-8 relative shadow-2xl space-y-6">
            
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold text-white tracking-tight">
                {activeModal === 'add' ? 'Add New Profile' : 'Edit Profile'}
              </h3>
              <button 
                onClick={() => setActiveModal(null)} 
                className="text-slate-500 hover:text-slate-300 p-1 rounded-lg hover:bg-slate-800 transition-colors"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={activeModal === 'add' ? handleAddProfileSubmit : handleEditProfileSubmit} className="space-y-6">
              
              {/* Visual Avatar Preview */}
              <div className="flex flex-col items-center justify-center space-y-3">
                <div className={`w-24 h-24 rounded-2xl ${getFlatColorFromSeed(modalData.seed)} flex items-center justify-center text-3xl font-extrabold text-white shadow-xl`}>
                  <NetflixSmiley className="w-14 h-14 text-white/95" />
                </div>
                <button
                  type="button"
                  onClick={() => setModalData(prev => ({ ...prev, seed: Math.random().toString(36).substring(7) }))}
                  className="text-xs text-sky-400 hover:text-sky-300 font-medium transition-colors"
                >
                  Randomize Avatar Colors
                </button>
              </div>

              {/* Name Input */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold uppercase tracking-wider text-slate-400 block">
                  Profile Name
                </label>
                <input
                  type="text"
                  required
                  placeholder="Enter profile name"
                  value={modalData.name}
                  onChange={(e) => setModalData(prev => ({ ...prev, name: e.target.value }))}
                  className="w-full px-4 py-3 bg-slate-950 border border-slate-800 rounded-xl focus:border-green-500 focus:ring-1 focus:ring-green-500 text-slate-100 placeholder:text-slate-600 outline-none transition-all"
                  maxLength={15}
                />
              </div>

              {/* Actions Footer */}
              <div className="flex flex-col sm:flex-row gap-3 pt-2">
                {activeModal === 'edit' && (
                  <button
                    type="button"
                    disabled={isActionLoading}
                    onClick={() => handleDeleteProfile(selectedProfile.id)}
                    className="w-full py-3 px-4 bg-transparent border border-red-500/30 text-red-500 hover:bg-red-500/10 disabled:bg-slate-800/20 disabled:text-slate-600 font-semibold rounded-xl transition-all active:scale-[0.98] outline-none"
                  >
                    Delete
                  </button>
                )}
                <button
                  type="submit"
                  disabled={isActionLoading || !modalData.name.trim()}
                  className="w-full py-3 px-4 bg-green-600 hover:bg-green-500 disabled:bg-slate-800 text-white font-semibold rounded-xl transition-all shadow-lg active:scale-[0.98] flex items-center justify-center gap-2 outline-none"
                >
                  {isActionLoading ? 'Processing...' : (activeModal === 'add' ? 'Save' : 'Update')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
