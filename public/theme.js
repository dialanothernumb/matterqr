// Loaded in <head> before the stylesheet paints, so a saved light/dark
// choice applies without a flash. "auto" (the default) follows the OS.
(function () {
  var KEY = 'matterqr-theme';
  function read() {
    try { return localStorage.getItem(KEY) || 'auto'; } catch (e) { return 'auto'; }
  }
  function apply(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode);
    else document.documentElement.removeAttribute('data-theme');
  }
  apply(read());
  window.matterqrTheme = {
    get: read,
    set: function (mode) {
      try { localStorage.setItem(KEY, mode); } catch (e) { /* private mode: still applies for this visit */ }
      apply(mode);
    },
  };
})();
