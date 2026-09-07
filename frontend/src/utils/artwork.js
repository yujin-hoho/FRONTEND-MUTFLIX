export function selectBackdropCandidate(item = {}) {
  const serverFilePath = item.backdrop_file_id
    ? `/api/gdrive-poster/${item.backdrop_file_id}`
    : ''

  if (serverFilePath) return { kind: 'server', path: serverFilePath }
  if (item.primary_backdrop_url) return { kind: 'server', path: item.primary_backdrop_url }

  // A plain backdrop_url can be the server's quick/default series artwork.
  // Prefer resolved landscape metadata once it becomes available.
  if (item.tmdb_backdrop_path) return { kind: 'tmdb', path: item.tmdb_backdrop_path }
  if (item.backdrop_path) return { kind: 'tmdb', path: item.backdrop_path }

  return {
    kind: 'server',
    path: item.backdrop_url
      || item.backdrop
      || item.background_url
      || item.fanart_url
      || '',
  }
}

export function shouldPreferBackdropCandidate(item = {}, candidate = selectBackdropCandidate(item)) {
  return Boolean(
    item.backdrop_file_id
    || item.primary_backdrop_url
    || candidate.kind === 'tmdb',
  )
}
