/* =========================================================
   rules.js
   Pure game rules — no DOM, no storage. Shared by the browser
   (window.Rules) and by the Node unit tests (module.exports).
   ========================================================= */
(function (root) {
  const ROWS = 6;
  const COLS = 5;
  const DAILY_EPOCH_UTC = Date.UTC(2024, 0, 1);
  const DAILY_SEED = 0x57a2d1e5;

  /**
   * Wordle scoring with correct duplicate-letter handling.
   * Pass 1 marks exact matches and pools the unmatched answer letters.
   * Pass 2 marks "present" only while that pool still has the letter.
   */
  function evaluate(guess, answer) {
    const result = new Array(COLS).fill("absent");
    const remaining = {};
    for (let i = 0; i < COLS; i++) {
      if (guess[i] === answer[i]) result[i] = "correct";
      else remaining[answer[i]] = (remaining[answer[i]] || 0) + 1;
    }
    for (let i = 0; i < COLS; i++) {
      if (result[i] === "correct") continue;
      const ch = guess[i];
      if (remaining[ch] > 0) {
        result[i] = "present";
        remaining[ch]--;
      }
    }
    return result;
  }

  /** Small seeded PRNG so the daily order is identical on every device. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const orderCache = {};
  /** A fixed shuffle of 0..n-1, so daily answers are not alphabetical. */
  function dailyOrder(n) {
    if (orderCache[n]) return orderCache[n];
    const order = Array.from({ length: n }, (_, i) => i);
    const rnd = mulberry32(DAILY_SEED);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = order[i];
      order[i] = order[j];
      order[j] = tmp;
    }
    orderCache[n] = order;
    return order;
  }

  /** Day number based on the player's LOCAL calendar date. */
  function dayIndex(date) {
    const d = date || new Date();
    const ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - DAILY_EPOCH_UTC;
    return Math.floor(ms / 86400000);
  }

  function dailyAnswer(words, day) {
    const n = words.length;
    const order = dailyOrder(n);
    return words[order[((day % n) + n) % n]];
  }

  /** Milliseconds until the next local midnight. */
  function msUntilNextDay(now) {
    const d = now || new Date();
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    return next.getTime() - d.getTime();
  }

  /**
   * Multiplayer points for one round.
   * Win: 6 points for a 1st-guess solve down to 1 for the 6th.
   * With a timer: +2 if solved in the first half, +1 in the first 75%.
   */
  function roundPoints(won, attempts, durationMs, timerSec) {
    if (!won) return 0;
    const a = Math.min(ROWS, Math.max(1, attempts | 0));
    let pts = ROWS + 1 - a;
    if (timerSec > 0) {
      const total = timerSec * 1000;
      if (durationMs <= total / 2) pts += 2;
      else if (durationMs <= total * 0.75) pts += 1;
    }
    return pts;
  }

  /** Team score = average of its members, so team size gives no advantage. */
  function teamScore(memberScores) {
    if (!memberScores.length) return 0;
    const sum = memberScores.reduce((s, n) => s + n, 0);
    return Math.round((sum / memberScores.length) * 10) / 10;
  }

  /**
   * Most valuable player from a list of
   * { id, score, roundsWon, solveTries, solveMs }.
   * Highest score wins; ties go to more rounds solved, then fewer guesses
   * used on solved rounds, then less time. Nobody qualifies on zero points.
   */
  function comparePlayers(a, b) {
    return (
      b.score - a.score ||
      b.roundsWon - a.roundsWon ||
      (a.solveTries || 0) - (b.solveTries || 0) ||
      (a.solveMs || 0) - (b.solveMs || 0)
    );
  }

  /**
   * Places for an already sorted list, sharing a place on a tie: 1, 1, 3, 4.
   * same(a, b) says whether two neighbours are level.
   */
  function ranks(sorted, same) {
    const out = [];
    sorted.forEach((item, i) => {
      out.push(i > 0 && same(sorted[i - 1], item) ? out[i - 1] : i + 1);
    });
    return out;
  }

  function pickMvp(list) {
    const ranked = (list || []).filter((p) => p.score > 0).sort(comparePlayers);
    return ranked.length ? ranked[0].id : null;
  }

  /** Only allow colour strings we generate ourselves (blocks HTML injection). */
  function safeColor(c) {
    const s = String(c || "");
    if (/^#[0-9a-fA-F]{3,8}$/.test(s)) return s;
    if (/^hsl\(\d{1,3}(\.\d+)? \d{1,3}% \d{1,3}%\)$/.test(s)) return s;
    return "#8892a5";
  }

  /** Trim, strip control characters, cap length. */
  function cleanText(s, max) {
    return String(s == null ? "" : s)
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, max);
  }

  function isWordShape(s) {
    return typeof s === "string" && /^[a-z]{5}$/.test(s);
  }

  const api = {
    ROWS,
    COLS,
    evaluate,
    mulberry32,
    dailyOrder,
    dayIndex,
    dailyAnswer,
    msUntilNextDay,
    roundPoints,
    teamScore,
    comparePlayers,
    ranks,
    pickMvp,
    safeColor,
    cleanText,
    isWordShape,
  };
  root.Rules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
