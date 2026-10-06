/* =========================================================
   ui.js
   Shared UI plumbing: modal stack (focus, Escape, backdrop,
   Android back button), toasts, confirm dialog, small helpers.
   ========================================================= */
window.UI = (function () {
  const $ = (s) => document.querySelector(s);
  const stack = []; // open modals, last = top
  let toastTimer = null;
  let usingKeyboard = false; // true while the player is navigating with Tab

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  /* ---------- Modals ---------- */

  function syncInert() {
    const app = $("#app");
    if (!app) return;
    if (stack.length) app.setAttribute("inert", "");
    else app.removeAttribute("inert");
    // Only the top modal is interactive.
    stack.forEach((m, i) => {
      if (i === stack.length - 1) m.removeAttribute("inert");
      else m.setAttribute("inert", "");
    });
  }

  function isOpen(m) {
    return !!m && !m.classList.contains("hidden");
  }

  function open(m) {
    if (!m) return;
    if (isOpen(m)) {
      // Re-opening moves it to the top.
      const i = stack.indexOf(m);
      if (i >= 0) stack.splice(i, 1);
    } else {
      m._returnFocus = document.activeElement;
      m.classList.remove("hidden");
    }
    stack.push(m);
    syncInert();
    // Focus the card itself (not an input) so mobile keyboards don't pop up.
    const card = m.querySelector(".modal-card");
    if (card) {
      card.setAttribute("tabindex", "-1");
      card.scrollTop = 0;
      try {
        card.focus({ preventScroll: true });
      } catch (e) {
        /* ignore */
      }
    }
  }

  function close(m) {
    if (!m || !isOpen(m)) return;
    m.classList.add("hidden");
    m.removeAttribute("inert");
    const i = stack.indexOf(m);
    if (i >= 0) stack.splice(i, 1);
    syncInert();
    const back = m._returnFocus;
    m._returnFocus = null;
    // Return focus to the opener for keyboard users only: after a tap or click, a focused
    // button would swallow the Enter key that should submit a guess.
    if (!usingKeyboard) {
      if (!stack.length && document.activeElement && document.activeElement.blur) {
        document.activeElement.blur();
      }
    } else if (back && document.contains(back) && back.focus) {
      try {
        back.focus({ preventScroll: true });
      } catch (e) {
        /* ignore */
      }
    }
  }

  function anyOpen() {
    return stack.length > 0;
  }

  /** User-initiated dismissal (×, backdrop, Escape, Android back). */
  function dismiss(m) {
    if (!m || m.dataset.required === "true") return false;
    close(m);
    m.dispatchEvent(new CustomEvent("modal:dismiss"));
    return true;
  }

  /** Android hardware back / Escape. Returns true if something was handled. */
  function back() {
    const top = stack[stack.length - 1];
    if (!top) return false;
    if (top.dataset.required === "true") {
      top.dispatchEvent(new CustomEvent("modal:back"));
      return true;
    }
    return dismiss(top);
  }

  function initModals() {
    document.querySelectorAll("[data-close]").forEach((b) => {
      b.addEventListener("click", () => dismiss(b.closest(".modal")));
    });
    document.querySelectorAll(".modal").forEach((m) => {
      // Dismiss only when the press both starts and ends on the backdrop.
      let downOnBackdrop = false;
      m.addEventListener("pointerdown", (e) => {
        downOnBackdrop = e.target === m;
      });
      m.addEventListener("click", (e) => {
        if (e.target === m && downOnBackdrop) dismiss(m);
      });
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Tab") usingKeyboard = true;
    });
    document.addEventListener("pointerdown", () => (usingKeyboard = false), true);
    // A clicked button on the game screen must not keep focus (see close()).
    document.addEventListener("click", (e) => {
      const b = e.target.closest && e.target.closest("button");
      if (b && e.detail > 0 && !b.closest(".modal")) b.blur();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && anyOpen()) {
        e.preventDefault();
        back();
      }
    });
  }

  /* ---------- Toast ---------- */

  function toast(text, ms) {
    const el = $("#toast");
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
    }, ms || 1900);
  }

  /* ---------- Confirm dialog (replaces window.confirm) ---------- */

  function confirm(text, opts) {
    opts = opts || {};
    const m = $("#confirmModal");
    $("#confirmTitle").textContent = opts.title || "Are you sure?";
    $("#confirmText").textContent = text;
    const ok = $("#confirmOk");
    const cancel = $("#confirmCancel");
    ok.textContent = opts.ok || "OK";
    cancel.textContent = opts.cancel || "Cancel";
    ok.classList.toggle("danger", !!opts.danger);
    return new Promise((resolve) => {
      function done(v) {
        ok.onclick = cancel.onclick = null;
        m.removeEventListener("modal:dismiss", onDismiss);
        close(m);
        resolve(v);
      }
      function onDismiss() {
        done(false);
      }
      ok.onclick = () => done(true);
      cancel.onclick = () => done(false);
      m.addEventListener("modal:dismiss", onDismiss);
      open(m);
    });
  }

  /* ---------- Clipboard / share ---------- */

  async function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) {
      /* fall through to the legacy path */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /** Native share sheet when available, otherwise copy to the clipboard. */
  /** Copies the text and says so. (No share sheet: on a PC that opened the Mail app.) */
  async function shareText(text, copiedMsg) {
    toast((await copy(text)) ? copiedMsg || "Copied to clipboard" : "Could not copy");
  }

  function haptic(ms) {
    if (document.body.dataset.haptics === "off") return;
    try {
      if (navigator.vibrate) navigator.vibrate(ms || 8);
    } catch (e) {
      /* ignore */
    }
  }

  /** Animations are always on. Kept as a single switch point for effects code. */
  function reducedMotion() {
    return false;
  }

  function formatClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  return {
    $,
    escapeHtml,
    clamp,
    open,
    close,
    isOpen,
    anyOpen,
    dismiss,
    back,
    initModals,
    toast,
    confirm,
    copy,
    shareText,
    haptic,
    reducedMotion,
    formatClock,
  };
})();
