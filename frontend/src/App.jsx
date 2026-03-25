import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import ContentDetail from './pages/ContentDetail';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/detail/:folderName" element={<ContentDetail />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App;
