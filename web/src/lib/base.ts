/**
 * Where the app is mounted: "" at the site root, or a host's path such as
 * "/timeclock". The server says so with <base href>.
 */
export const basePath = (() => {
  const href = document.querySelector('base')?.getAttribute('href');
  return href ? new URL(href, window.location.origin).pathname.replace(/\/$/, '') : '';
})();
