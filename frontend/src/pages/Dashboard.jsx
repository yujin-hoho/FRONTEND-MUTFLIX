import { useEffect, useState, useCallback } from 'react';
import Navbar from '../components/Navbar';
import HeroBanner from '../components/HeroBanner';
import MovieCarousel from '../components/MovieCarousel';
import LoginModal from '../components/LoginModal';
import { fetchFolders, fetchContentReleases, isLoggedIn, logout } from '../services/api';

const Dashboard = () => {
  const [folders, setFolders] = useState([]);
  const [featured, setFeatured] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [authUser, setAuthUser] = useState(() => {
    const username = localStorage.getItem('username');
    const role = localStorage.getItem('role');
    return username ? { username, role } : null;
  });

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      // Fetch from the backend concurrently
      const [foldersResp, releasesResp] = await Promise.all([
        fetchFolders(),
        fetchContentReleases()
      ]);
      
      // API /api/folders mengembalikan object { movies: [], series: [] }
      let foldersData = [];
      if (foldersResp && typeof foldersResp === 'object' && !Array.isArray(foldersResp)) {
          // Gabungkan movies dan series menjadi satu array rata
          foldersData = [...(foldersResp.movies || []), ...(foldersResp.series || [])];
      } else if (Array.isArray(foldersResp)) {
          foldersData = foldersResp;
      }

      // Just in case releases is also an object like { data: [] }
      let releasesData = Array.isArray(releasesResp) ? releasesResp : (releasesResp?.data || []);
      
      setFolders(foldersData);
      
      // Determine featured item
      if (releasesData && releasesData.length > 0) {
         setFeatured(releasesData[0]);
      } else if (foldersData && foldersData.length > 0) {
         setFeatured(foldersData[0]);
      }
    } catch (error) {
      console.error("Error loading dashboard data:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleLoginSuccess = (data) => {
    setAuthUser({ username: data.username, role: data.role });
    // Reload dashboard data with new token
    loadData();
  };

  const handleLogout = () => {
    logout();
    setAuthUser(null);
    loadData();
  };

  // For demonstration, we'll partition the single API response into different sections
  const popular = folders.length > 0 ? folders.slice(0, 10) : [];
  const limitedFree = folders.length > 10 ? folders.slice(10, 20) : popular;
  const original = folders.length > 20 ? folders.slice(20, 30) : popular;

  return (
    <div className="min-h-screen bg-darkBG font-sans pb-20 overflow-x-hidden">
      <Navbar 
        onMeClick={() => setShowLoginModal(true)} 
        isLoggedIn={!!authUser}
        username={authUser?.username}
        onLogout={handleLogout}
      />
      
      <main className="animate-slide-up" style={{ animationDelay: '0.2s', opacity: 0, animationFillMode: 'forwards' }}>
        {loading ? (
           <HeroBanner item={null} />
        ) : (
           <HeroBanner item={featured} />
        )}
        
        {/* Reduced negative margin to prevent overlap with HeroBanner text */}
        <div className="relative z-10 -mt-8 md:-mt-16 space-y-8 md:space-y-12">
          {popular.length > 0 && <MovieCarousel title="Popular on MUTFLIX" items={popular} tagType="top" />}
          {limitedFree.length > 0 && <MovieCarousel title="Limited Time Free" items={limitedFree} tagType="free" />}
          {original.length > 0 && <MovieCarousel title="MUTFLIX Originals" items={original} tagType="original" />}
        </div>
      </main>

      <LoginModal 
        isOpen={showLoginModal} 
        onClose={() => setShowLoginModal(false)} 
        onLoginSuccess={handleLoginSuccess}
      />
    </div>
  );
};

export default Dashboard;
