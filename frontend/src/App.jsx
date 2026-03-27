import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import ContentDetail from './pages/ContentDetail';
import WatchPage from './pages/WatchPage';
import Search from './pages/Search';
import FilterPage from './pages/FilterPage';
import MyList from './pages/MyList';
import Login from './pages/Login';
import { ProtectedRoute, PublicRoute } from './components/ProtectedRoute';

function App() {
  return (
    <BrowserRouter>
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
    </BrowserRouter>
  )
}

export default App;

