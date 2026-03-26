import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import ContentDetail from './pages/ContentDetail';
import Search from './pages/Search';
import FilterPage from './pages/FilterPage';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/detail/:folderName" element={<ContentDetail />} />
        <Route path="/search" element={<Search />} />
        <Route path="/filter" element={<FilterPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App;
