import { AlertCircle, Check, Loader2, Pencil, Plus, User } from 'lucide-react'
import { getProfileAvatarUrl } from '../utils/media'
import { PROFILE_AVATAR_CATEGORIES } from '../utils/profileAvatars'

function ProfilePage({
  editingProfile,
  isAddingProfile,
  isProfileLoading,
  newProfileName,
  onAddProfile,
  onAvatarSeedChange,
  onCloseProfileForm,
  onEditProfile,
  onNewProfileNameChange,
  onProfileSelect,
  onShowAddProfileChange,
  profileAvatarSeed,
  profileMessage,
  profiles,
  showAddProfile,
}) {
  const selectedCategory = PROFILE_AVATAR_CATEGORIES.find((category) => (
    category.avatars.some((avatar) => avatar.seed === profileAvatarSeed)
  )) || PROFILE_AVATAR_CATEGORIES[0]

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
              <div className="profile-card-wrap" key={profile.id}>
                <button className="profile-card" onClick={() => onProfileSelect(profile)} type="button">
                  <span className="profile-avatar">
                    <img alt="" src={getProfileAvatarUrl(profile)} />
                  </span>
                  <span className="profile-name">{profile.name}</span>
                </button>
                <button
                  aria-label={`Edit ${profile.name}`}
                  className="profile-edit-button"
                  onClick={() => onEditProfile(profile)}
                  type="button"
                >
                  <Pencil size={17} />
                </button>
              </div>
            ))}

            {profiles.length === 0 && (
              <div className="empty-profile-card">
                <span>No profiles yet</span>
              </div>
            )}

            <button className="add-profile-card" onClick={onShowAddProfileChange} type="button">
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
            <h2>{editingProfile ? 'Edit Profile' : 'Add Profile'}</h2>
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

            {PROFILE_AVATAR_CATEGORIES.length > 0 && (
              <div className="profile-avatar-picker">
                <span>Profile photo</span>
                <div className="profile-avatar-tabs" role="tablist" aria-label="Profile photo categories">
                  {PROFILE_AVATAR_CATEGORIES.map((category) => (
                    <button
                      aria-selected={category.id === selectedCategory?.id}
                      className={category.id === selectedCategory?.id ? 'active' : ''}
                      key={category.id}
                      onClick={() => onAvatarSeedChange(category.avatars[0]?.seed || '')}
                      role="tab"
                      type="button"
                    >
                      {category.label}
                    </button>
                  ))}
                </div>
                <div className="profile-avatar-options">
                  {selectedCategory?.avatars.map((avatar) => {
                    const isSelected = avatar.seed === profileAvatarSeed
                    return (
                      <button
                        aria-label={`Use ${selectedCategory.label} ${avatar.label}`}
                        className={`profile-avatar-option ${isSelected ? 'selected' : ''}`}
                        key={avatar.seed}
                        onClick={() => onAvatarSeedChange(avatar.seed)}
                        type="button"
                      >
                        <img alt="" src={avatar.url} />
                        {isSelected && <span><Check size={16} /></span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="modal-actions">
              <button className="secondary-button" onClick={onCloseProfileForm} type="button">
                Cancel
              </button>
              <button className="submit-button modal-submit" disabled={!newProfileName.trim() || isAddingProfile} type="submit">
                {isAddingProfile ? <Loader2 className="spinner" size={20} /> : null}
                <span>{isAddingProfile ? 'Saving...' : editingProfile ? 'Update' : 'Save'}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </main>
  )
}

export default ProfilePage
