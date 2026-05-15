import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute, PublicRoute } from './components/ProtectedRoute';
import { preloadContentDetailRoute, preloadWatchPageRoute } from './utils/routePreload';

const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ContentDetail = lazy(() => import('./pages/ContentDetail'));
const WatchPage = lazy(() => import('./pages/WatchPage'));
const Search = lazy(() => import('./pages/Search'));
const FilterPage = lazy(() => import('./pages/FilterPage'));
const MyList = lazy(() => import('./pages/MyList'));

const RouteFallback = () => (
  <div className="min-h-screen bg-[#0a0b0f] flex items-center justify-center" aria-busy="true" aria-label="Loading">
    <div className="w-10 h-10 border-2 border-[#00dc41]/30 border-t-[#00dc41] rounded-full animate-spin" />
  </div>
);

function App() {
  useEffect(() => {
    const run = () => {
      void preloadContentDetailRoute();
      void preloadWatchPageRoute();
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 1000 });
    } else {
      setTimeout(run, 0);
    }
  }, []);

  return (
    <BrowserRouter>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* Public Route: Only accessible when NOT logged in */}
        <Route path="/" element={
          <PublicRoute>
            <Login />
          </PublicRoute>
        } />

        {/* Protected Routes: Only accessible when logged in */}
        <Route path="/dashboard" element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        } />
        
        <Route path="/detail/:folderName" element={
          <ProtectedRoute>
            <ContentDetail />
          </ProtectedRoute>
        } />
        
        <Route path="/watch/:folderName" element={
          <ProtectedRoute>
            <WatchPage />
          </ProtectedRoute>
        } />
        
        <Route path="/search" element={
          <ProtectedRoute>
            <Search />
          </ProtectedRoute>
        } />
        
        <Route path="/filter" element={
          <ProtectedRoute>
            <FilterPage />
          </ProtectedRoute>
        } />
        
        <Route path="/mylist" element={
          <ProtectedRoute>
            <MyList />
          </ProtectedRoute>
        } />

        {/* Fallback: Redirect any unknown routes to / */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </BrowserRouter>
  )
}

export default App;

