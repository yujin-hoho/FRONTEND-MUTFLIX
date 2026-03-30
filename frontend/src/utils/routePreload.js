let detailPagePromise = null;
let watchPagePromise = null;

export const preloadContentDetailRoute = () => {
  if (!detailPagePromise) {
    detailPagePromise = import('../pages/ContentDetail');
  }
  return detailPagePromise;
};

export const preloadWatchPageRoute = () => {
  if (!watchPagePromise) {
    watchPagePromise = import('../pages/WatchPage');
  }
  return watchPagePromise;
};
