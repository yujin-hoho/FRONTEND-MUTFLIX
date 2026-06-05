const avatarModules = import.meta.glob('../../assets/profile/**/*.{jpg,jpeg,png,webp}', {
  eager: true,
  import: 'default',
  query: '?url',
})

export const PROFILE_AVATAR_CATEGORIES = Object.entries(avatarModules)
  .reduce((categories, [modulePath, url]) => {
    const match = modulePath.match(/\/profile\/([^/]+)\/([^/]+)$/)
    if (!match) return categories

    const [, category, fileName] = match
    const seed = `profile/${category}/${fileName}`
    let categoryEntry = categories.find((entry) => entry.id === category)
    if (!categoryEntry) {
      categoryEntry = {
        id: category,
        label: formatAvatarCategoryLabel(category),
        avatars: [],
      }
      categories.push(categoryEntry)
    }
    categoryEntry.avatars.push({
      id: seed,
      label: fileName.replace(/\.[^.]+$/, ''),
      seed,
      url,
    })
    return categories
  }, [])
  .map((category) => ({
    ...category,
    avatars: category.avatars.sort(compareAvatarLabels),
  }))
  .sort((left, right) => left.label.localeCompare(right.label))

export const DEFAULT_PROFILE_AVATAR_SEED = PROFILE_AVATAR_CATEGORIES[0]?.avatars[0]?.seed || ''

export function getProfileAvatarUrlFromSeed(seed) {
  if (!seed) return ''
  for (const category of PROFILE_AVATAR_CATEGORIES) {
    const avatar = category.avatars.find((entry) => entry.seed === seed)
    if (avatar) return avatar.url
  }
  return ''
}

function formatAvatarCategoryLabel(category) {
  return String(category || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
}

function compareAvatarLabels(left, right) {
  return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
}
