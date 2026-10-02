/* =========================================================
   keyboard.js
   On-screen keyboard + physical keyboard input.
   ========================================================= */
window.Keyboard = (function () {
  const LAYOUT = [
    "qwertyuiop".split(""),
    "asdfghjkl".split(""),
    ["ENTER", ..."zxcvbnm".split(""), "BACK"],
  ];
  // Best status per letter: absent < present < correct. Never downgrade.
  const RANK = { absent: 1, present: 2, correct: 3 };
  const LABEL = { absent: "not in the word", present: "in the word", correct: "correct spot" };

  let handler = () => {};
  let root = null;
  const statuses = {};

  function build(container, onKey) {
    root = container;
    handler = onKey;
    root.innerHTML = "";
    LAYOUT.forEach((row) => {
      const rowEl = document.createElement("div");
      rowEl.className = "kb-row";
      row.forEach((k) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "key" + (k.length > 1 ? " wide" : "");
        btn.dataset.key = k;
        if (k === "BACK") {
          btn.innerHTML =
            '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 5H9l-6 7 6 7h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1z"/><path d="m17 9-5 6M12 9l5 6"/></svg>';
          btn.setAttribute("aria-label", "Backspace");
        } else if (k === "ENTER") {
          btn.textContent = "Enter";
        } else {
          btn.textContent = k;
          btn.setAttribute("aria-label", k.toUpperCase());
        }
        btn.addEventListener("click", () => {
          UI.haptic(8);
          handler(k);
        });
        rowEl.appendChild(btn);
      });
      root.appendChild(rowEl);
    });
    document.addEventListener("keydown", onPhysical);
  }

  function onPhysical(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Never type into the board while a dialog is open or a field is focused.
    if (UI.anyOpen()) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const k = e.key;
    if (k === "Enter") {
      // Let Enter activate a focused button instead of submitting a guess.
      if (t && t.tagName === "BUTTON" && !t.classList.contains("key")) return;
      if (e.repeat) return;
      e.preventDefault();
      handler("ENTER");
    } else if (k === "Backspace") {
      e.preventDefault();
      handler("BACK");
    } else if (/^[a-zA-Z]$/.test(k)) {
      handler(k.toLowerCase());
    }
  }

  function setStatus(letter, status) {
    const prev = statuses[letter];
    if (prev && RANK[prev] >= RANK[status]) return;
    statuses[letter] = status;
    const btn = root && root.querySelector(`[data-key="${letter}"]`);
    if (!btn) return;
    btn.classList.remove("correct", "present", "absent");
    btn.classList.add(status);
    btn.setAttribute("aria-label", `${letter.toUpperCase()}, ${LABEL[status]}`);
  }

  function reset() {
    Object.keys(statuses).forEach((k) => delete statuses[k]);
    if (!root) return;
    root.querySelectorAll(".key").forEach((b) => {
      b.classList.remove("correct", "present", "absent");
      const k = b.dataset.key;
      if (k.length === 1) b.setAttribute("aria-label", k.toUpperCase());
    });
  }

  return { build, setStatus, reset };
})();
