import { Expand, MonitorUp, Smartphone } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import {
  DESKTOP_MIN_WIDTH_PX,
  isDesktopViewport,
  subscribeToDesktopViewport,
} from '../utils/device'

export function DesktopAccessGate({ children }) {
  const hasDesktopViewport = useSyncExternalStore(
    subscribeToDesktopViewport,
    isDesktopViewport,
    () => true,
  )

  return hasDesktopViewport ? children : <DesktopOnlyPage />
}

export function DesktopOnlyPage() {
  return (
    <main className="desktop-only-page">
      <section className="desktop-only-card">
        <div className="desktop-only-header">
          <p className="desktop-only-brand">MUTFLIX</p>
          <span>Desktop experience</span>
        </div>

        <div className="desktop-only-visual" aria-hidden="true">
          <span className="desktop-only-device desktop-only-device-phone">
            <Smartphone size={24} strokeWidth={1.8} />
          </span>
          <span className="desktop-only-expand">
            <Expand size={20} strokeWidth={1.8} />
          </span>
          <span className="desktop-only-device desktop-only-device-monitor">
            <MonitorUp size={42} strokeWidth={1.7} />
          </span>
        </div>

        <p className="desktop-only-eyebrow">Layar terlalu sempit</p>
        <h1>Buka MUTFLIX di layar yang lebih lebar</h1>
        <p className="desktop-only-copy">
          Untuk menjaga tampilan katalog dan kontrol player tetap nyaman, MUTFLIX memerlukan lebar layar minimal {DESKTOP_MIN_WIDTH_PX}px.
        </p>
        <div className="desktop-only-hint">
          <MonitorUp aria-hidden="true" size={19} />
          <span>Gunakan laptop atau desktop, atau lebarkan jendela browser.</span>
        </div>
      </section>
    </main>
  )
}
