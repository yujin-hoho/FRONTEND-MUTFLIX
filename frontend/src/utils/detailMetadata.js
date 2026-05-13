import { TMDB_GENRES } from '../services/api';

export const tmdbOptsFromCatalogItem = (item, urlType) => {
  const mediaTypeFromUrl = urlType === 'movie' ? 'movie' : urlType === 'series' ? 'tv' : undefined;
  const mediaTypeFromItem =
    item?.tmdb_override_media_type === 'movie'
      ? 'movie'
      : item?.tmdb_override_media_type === 'tv'
        ? 'tv'
        : item?.media_type === 'movie' || item?.type === 'movie'
          ? 'movie'
          : item?.media_type === 'tv' || item?.type === 'series' || item?.type === 'tv'
            ? 'tv'
            : undefined;

  const opts = {
    mediaType: mediaTypeFromItem || mediaTypeFromUrl,
  };

  if (item?.tmdb_query) opts.query = item.tmdb_query;
  if (item?.tmdb_id) opts.tmdbId = item.tmdb_id;
  if (item?.override_year != null && item.override_year !== '') opts.year = Number(item.override_year);
  if (item?.override_region) opts.region = item.override_region;
  if (item?.include_adult) opts.includeAdult = true;

  return Object.fromEntries(Object.entries(opts).filter(([, value]) => value !== undefined && value !== null && value !== ''));
};

export const createDetailNavigationState = (item = {}, extraTmdb = null) => {
  const folderName = item.folder_name || item.name || '';
  return {
    detailItem: {
      ...item,
      folder_name: folderName,
      tmdb_id: item.tmdb_id || extraTmdb?.tmdb_id,
      media_type: item.media_type || extraTmdb?.media_type,
      tmdb_title: item.tmdb_title || extraTmdb?.tmdb_title || extraTmdb?.title,
      tmdb_poster_path: item.tmdb_poster_path || item.poster_path || item.poster || extraTmdb?.poster_path,
      tmdb_backdrop_path: item.tmdb_backdrop_path || item.backdrop_path || extraTmdb?.backdrop_path,
      tmdb_overview: item.tmdb_overview || extraTmdb?.overview,
      tmdb_rating: item.tmdb_rating || extraTmdb?.rating,
      tmdb_genre_ids: item.tmdb_genre_ids || extraTmdb?.genre_ids,
    },
  };
};

export const findCatalogItemForDetail = (foldersResp, decodedName) => {
  const items = Array.isArray(foldersResp)
    ? foldersResp
    : [...(foldersResp?.movies || []), ...(foldersResp?.series || [])];
  const target = String(decodedName || '').trim().toLowerCase();
  if (!target) return null;

  return (
    items.find((item) => String(item.folder_name || '').trim().toLowerCase() === target) ||
    items.find((item) => String(item.name || '').trim().toLowerCase() === target) ||
    null
  );
};

export const mergeDetailMetadata = (catalogItem, tmdbData, decodedName, urlType) => {
  const item = catalogItem || {};
  const mediaType =
    item.media_type ||
    tmdbData?.media_type ||
    (urlType === 'series' ? 'tv' : urlType === 'movie' ? 'movie' : undefined);
  const itemGenreIds = Array.isArray(item.tmdb_genre_ids) ? item.tmdb_genre_ids : null;
  const tmdbGenreIds = Array.isArray(tmdbData?.genre_ids)
    ? tmdbData.genre_ids
    : Array.isArray(tmdbData?.genres)
      ? tmdbData.genres.map((g) => g.id).filter(Boolean)
      : null;
  const genreIds = itemGenreIds?.length ? itemGenreIds : tmdbGenreIds || [];
  const tmdbGenres = Array.isArray(tmdbData?.genres) ? tmdbData.genres : [];
  const genres = tmdbGenres.length
    ? tmdbGenres
    : genreIds.map((id) => ({ id, name: TMDB_GENRES[id] })).filter((g) => g.name);

  return {
    ...(tmdbData || {}),
    tmdb_id: item.tmdb_id || tmdbData?.tmdb_id,
    media_type: mediaType,
    tmdb_title: item.tmdb_title || tmdbData?.tmdb_title || tmdbData?.title || item.name || item.folder_name || decodedName,
    title: item.tmdb_title || tmdbData?.title || tmdbData?.tmdb_title || item.name || item.folder_name || decodedName,
    poster_path: item.tmdb_poster_path || item.poster_path || item.poster || tmdbData?.poster_path,
    backdrop_path: item.tmdb_backdrop_path || item.backdrop_path || tmdbData?.backdrop_path || item.tmdb_poster_path || item.poster_path || item.poster,
    rating: item.tmdb_rating ?? tmdbData?.rating,
    overview: item.tmdb_overview || tmdbData?.overview,
    genre_ids: genreIds,
    genres,
  };
};
