import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import { DesktopAccessGate } from './components/DesktopOnlyPage.jsx'
import { isDesktopViewport } from './utils/device.js'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <DesktopAccessGate>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </DesktopAccessGate>
  </StrictMode>,
)

if (isDesktopViewport() && import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline support is optional when the browser blocks service workers.
    })
  })
}
