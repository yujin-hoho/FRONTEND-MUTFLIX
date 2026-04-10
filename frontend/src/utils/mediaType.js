export const isSeriesLike = (item = {}) => {
  const t = String(item?.media_type || item?.type || '').toLowerCase();
  if (t === 'tv' || t === 'series') return true;
  if (t === 'movie') return false;
  if (item?.series_title) return true;
  if (item?.episodes || item?.total_episodes) return true;
  if (item?.first_air_date) return true;
  return false;
};

export const detailTypeOfItem = (item = {}) => (isSeriesLike(item) ? 'series' : 'movie');
