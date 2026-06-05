import { ChevronDown, LogOut, UsersRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { getProfileAvatarUrl } from '../utils/media'

function ProfileMenu({ onChangeProfile, onLogout, selectedProfile }) {
  const [isOpen, setIsOpen] = useState(false)
  const menuRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return undefined

    function closeOnOutsideInteraction(event) {
      if (menuRef.current?.contains(event.target)) return
      setIsOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsideInteraction)
    document.addEventListener('focusin', closeOnOutsideInteraction)

    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideInteraction)
      document.removeEventListener('focusin', closeOnOutsideInteraction)
    }
  }, [isOpen])

  function handleChangeProfile() {
    setIsOpen(false)
    onChangeProfile()
  }

  function handleLogout() {
    setIsOpen(false)
    onLogout()
  }

  return (
    <div className="profile-menu" ref={menuRef}>
      <button
        aria-expanded={isOpen}
        className="profile-menu-trigger"
        onClick={() => setIsOpen((currentIsOpen) => !currentIsOpen)}
        type="button"
      >
        <span className="profile-menu-avatar" aria-hidden="true">
          <img alt="" src={getProfileAvatarUrl(selectedProfile)} />
        </span>
        <ChevronDown size={16} />
      </button>
      {isOpen && (
        <div className="profile-menu-dropdown">
          <button onClick={handleChangeProfile} type="button">
            <UsersRound size={17} />
            <span>Ganti profil</span>
          </button>
          <button onClick={handleLogout} type="button">
            <LogOut size={17} />
            <span>Logout</span>
          </button>
        </div>
      )}
    </div>
  )
}

export default ProfileMenu
