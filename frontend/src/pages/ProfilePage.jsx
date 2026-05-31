import { AlertCircle, Loader2, Plus, User } from 'lucide-react'

function ProfilePage({
  isAddingProfile,
  isProfileLoading,
  newProfileName,
  onAddProfile,
  onNewProfileNameChange,
  onProfileSelect,
  onShowAddProfileChange,
  profileMessage,
  profiles,
  showAddProfile,
}) {
  return (
    <main className="profile-page">
      <a className="brand-mark profile-brand" href="/" aria-label="Mutflix home">
        MUTFLIX
      </a>

      <section className="profile-selector" aria-label="Choose profile">
        <h1>Who's watching?</h1>

        {isProfileLoading && (
          <div className="profile-status">
            <Loader2 className="spinner" size={26} />
            <span>Loading profiles...</span>
          </div>
        )}

        {profileMessage && (
          <div className="notice error profile-notice" role="alert">
            <AlertCircle size={18} />
            <span>{profileMessage}</span>
          </div>
        )}

        {!isProfileLoading && !profileMessage && (
          <div className="profile-grid">
            {profiles.map((profile) => (
              <button className="profile-card" key={profile.id} onClick={() => onProfileSelect(profile)} type="button">
                <span className="profile-avatar">
                  {profile.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="profile-name">{profile.name}</span>
              </button>
            ))}

            {profiles.length === 0 && (
              <div className="empty-profile-card">
                <span>No profiles yet</span>
              </div>
            )}

            <button className="add-profile-card" onClick={() => onShowAddProfileChange(true)} type="button">
              <span className="add-profile-icon">
                <Plus size={42} />
              </span>
              <span className="profile-name">Add Profile</span>
            </button>
          </div>
        )}
      </section>

      {showAddProfile && (
        <div className="profile-modal-backdrop" role="presentation">
          <form className="profile-modal" onSubmit={onAddProfile}>
            <h2>Add Profile</h2>
            <label className="field">
              <span>Profile name</span>
              <div className="input-wrap">
                <User aria-hidden="true" size={19} />
                <input
                  autoFocus
                  maxLength={24}
                  onChange={(event) => onNewProfileNameChange(event.target.value)}
                  placeholder="Profile name"
                  type="text"
                  value={newProfileName}
                />
              </div>
            </label>

            <div className="modal-actions">
              <button className="secondary-button" onClick={() => onShowAddProfileChange(false)} type="button">
                Cancel
              </button>
              <button className="submit-button modal-submit" disabled={!newProfileName.trim() || isAddingProfile} type="submit">
                {isAddingProfile ? <Loader2 className="spinner" size={20} /> : null}
                <span>{isAddingProfile ? 'Saving...' : 'Save'}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  )
}

export default ProfilePage
