/* =========================================================
   stats.js
   Lifetime solo statistics: played, wins, streaks and the
   guess distribution (index 0 = solved on the 1st guess).
   ========================================================= */
window.Stats = (function () {
  const KEY = "stats";

  function blank() {
    return {
      played: 0,
      wins: 0,
      currentStreak: 0,
      bestStreak: 0,
      distribution: [0, 0, 0, 0, 0, 0],
    };
  }

  /** Always returns a well-formed object, even if saved data is damaged. */
  function load() {
    const s = Object.assign(blank(), Store.get(KEY, null) || {});
    const num = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
    s.played = num(s.played);
    s.wins = num(s.wins);
    s.currentStreak = num(s.currentStreak);
    s.bestStreak = num(s.bestStreak);
    const d = Array.isArray(s.distribution) ? s.distribution : [];
    s.distribution = [0, 1, 2, 3, 4, 5].map((i) => num(d[i]));
    return s;
  }

  /** attempts: 1..6 when won. */
  function record(won, attempts) {
    const s = load();
    s.played += 1;
    if (won) {
      s.wins += 1;
      s.currentStreak += 1;
      s.bestStreak = Math.max(s.bestStreak, s.currentStreak);
      if (attempts >= 1 && attempts <= 6) s.distribution[attempts - 1] += 1;
    } else {
      s.currentStreak = 0;
    }
    Store.set(KEY, s);
    return s;
  }

  function reset() {
    Store.set(KEY, blank());
  }

  function winPct(s) {
    return s.played === 0 ? 0 : Math.round((s.wins / s.played) * 100);
  }

  return { load, record, reset, winPct };
})();
