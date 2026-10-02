/* =========================================================
   store.js
   Thin wrapper around localStorage (JSON + quota safety).
   Keys are namespaced with "wordlex:". Named "Store" so it does
   not shadow the browser's built-in Storage interface.
   ========================================================= */
window.Store = (function () {
  const PREFIX = "wordlex:";

  function get(key, fallback) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch (e) {
      /* private mode / quota — the game still works without saving */
    }
  }

  function remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch (e) {
      /* ignore */
    }
  }

  return { get, set, remove };
})();
