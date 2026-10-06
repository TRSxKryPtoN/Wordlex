/* =========================================================
   game.js
   Board engine: input, reveal animation, timer,
   and saving of solo games (daily + random) so they survive
   a refresh or the app being closed.

   Multiplayer uses the same board, but guesses are scored by an
   async "evaluator" (the host) — the answer never reaches guests.
   ========================================================= */
window.Game = (function () {
  const ROWS = Rules.ROWS;
  const COLS = Rules.COLS;
  const RECENT_MAX = 300;
  const STATUS_LABEL = { correct: "correct", present: "wrong spot", absent: "not in word" };

  let boardEl = null;
  let onFinishCb = () => {};
  let state = null;
  let timerHandle = null;
  let finishHandle = null;

  function init(boardElement, onFinish) {
    boardEl = boardElement;
    onFinishCb = onFinish || (() => {});
  }

  /* ---------- Starting a game ---------- */

  function pickRandomAnswer() {
    const recent = Store.get("recent", []);
    const seen = new Set(Array.isArray(recent) ? recent : []);
    let answer = ANSWER_WORDS[Math.floor(Math.random() * ANSWER_WORDS.length)];
    for (let i = 0; i < 50 && seen.has(answer); i++) {
      answer = ANSWER_WORDS[Math.floor(Math.random() * ANSWER_WORDS.length)];
    }
    const next = (Array.isArray(recent) ? recent : []).concat(answer).slice(-RECENT_MAX);
    Store.set("recent", next);
    return answer;
  }

  function validSave(s) {
    return (
      s &&
      Rules.isWordShape(s.answer) &&
      Array.isArray(s.guesses) &&
      s.guesses.length <= ROWS &&
      s.guesses.every(Rules.isWordShape)
    );
  }

  /**
   * mode: "daily" | "random" | "lan"
   * opts (solo):  { fresh }
   * opts (lan):   { evaluator, timer (sec), remainingMs, history:[{guess,result}], done, won }
   */
  function start(mode, opts) {
    opts = opts || {};
    stopTimer();
    clearTimeout(finishHandle);
    Keyboard.reset();

    const s = {
      mode,
      answer: null,
      day: null,
      saveKey: null,
      guesses: [],
      results: [],
      current: "",
      finished: false,
      won: false,
      locked: false,
      evaluator: null,
      startedAt: Date.now(),
    };

    if (mode === "daily") {
      s.day = Rules.dayIndex();
      s.answer = Rules.dailyAnswer(ANSWER_WORDS, s.day);
      s.saveKey = "game:daily";
      const saved = Store.get(s.saveKey, null);
      if (validSave(saved) && saved.day === s.day && saved.answer === s.answer) restore(s, saved);
    } else if (mode === "random") {
      s.saveKey = "game:random";
      const saved = Store.get(s.saveKey, null);
      if (!opts.fresh && validSave(saved) && !saved.finished) {
        s.answer = saved.answer;
        restore(s, saved);
      } else {
        s.answer = pickRandomAnswer();
      }
    } else {
      s.evaluator = opts.evaluator || null;
      (opts.history || []).forEach((h) => {
        s.guesses.push(h.guess);
        s.results.push(h.result);
      });
      if (opts.done) {
        s.finished = true;
        s.won = !!opts.won;
      }
    }

    state = s;
    persist();
    render();

    // In a match the clock keeps running for players who have finished (or are watching),
    // so they can see how long the round still has to go.
    if (mode === "lan" && opts.timer > 0 && (!s.finished || opts.remainingMs > 0)) {
      startTimer(opts.timer * 1000, opts.remainingMs > 0 ? opts.remainingMs : opts.timer * 1000);
    }
    return { resumed: s.guesses.length > 0, finished: s.finished, won: s.won };
  }

  function restore(s, saved) {
    s.guesses = saved.guesses.slice();
    s.results = s.guesses.map((g) => Rules.evaluate(g, s.answer));
    s.finished = !!saved.finished;
    s.won = !!saved.won;
    s.startedAt = saved.startedAt || Date.now();
  }

  function persist() {
    if (!state || !state.saveKey) return;
    Store.set(state.saveKey, {
      day: state.day,
      answer: state.answer,
      guesses: state.guesses,
      finished: state.finished,
      won: state.won,
      startedAt: state.startedAt,
    });
  }

  /* ---------- Public getters ---------- */

  function getMode() {
    return state ? state.mode : null;
  }
  function isFinished() {
    return !state || state.finished;
  }
  /** True when leaving now would throw away real progress. */
  function hasProgress() {
    return !!state && !state.finished && state.guesses.length > 0;
  }
  function getResult() {
    return {
      mode: state.mode,
      won: state.won,
      answer: state.answer,
      guesses: state.guesses.slice(),
      results: state.results.map((r) => r.slice()),
      day: state.day,
    };
  }

  /** Give up the current random puzzle; counts as a loss if any guess was made. */
  function abandon() {
    if (!state || state.mode !== "random" || state.finished) return;
    if (state.guesses.length > 0) Stats.record(false, 0);
    state.finished = true;
    Store.remove("game:random");
  }

  /* ---------- Input ---------- */

  function input(key) {
    if (!state || state.finished || state.locked) return;
    if (key === "ENTER") return submit();
    if (key === "BACK") return backspace();
    if (/^[a-z]$/.test(key)) return typeLetter(key);
  }

  function typeLetter(ch) {
    if (state.current.length >= COLS) return;
    state.current += ch;
    paintCurrent(true);
  }

  function backspace() {
    if (!state.current) return;
    state.current = state.current.slice(0, -1);
    paintCurrent(false);
  }

  async function submit() {
    const s = state;
    if (s.current.length !== COLS) return shake("Not enough letters");
    const guess = s.current.toLowerCase();
    if (!VALID_WORDS.has(guess)) return shake("Not in word list");

    s.locked = true;
    const rowIndex = s.guesses.length;
    let result;
    if (s.evaluator) {
      const row = boardEl.children[rowIndex];
      if (row) row.classList.add("pending");
      let res = null;
      try {
        res = await s.evaluator(guess);
      } catch (e) {
        res = null;
      }
      if (state !== s) return; // a new game/round started while waiting
      if (row) row.classList.remove("pending");
      if (!res || !Array.isArray(res.result) || res.result.length !== COLS) {
        s.locked = false;
        if (s.finished) return;
        return shake((res && res.error) || "No response — try again");
      }
      result = res.result;
    } else {
      result = Rules.evaluate(guess, s.answer);
    }

    s.guesses.push(guess);
    s.results.push(result);
    s.current = "";
    persist();
    try {
      document.dispatchEvent(new CustomEvent("wordlex:guess", { detail: { word: guess } }));
    } catch (e) {
      /* ignore */
    }

    await paintRow(s, rowIndex, guess, result, true);
    if (state !== s) return;
    s.locked = false;
    if (s.finished) return; // e.g. the timer ran out during the reveal

    if (result.every((r) => r === "correct")) finish(true, "solved");
    else if (s.guesses.length >= ROWS) finish(false, "out");
  }

  /* ---------- Rendering ---------- */

  function render() {
    boardEl.innerHTML = "";
    for (let r = 0; r < ROWS; r++) {
      const row = document.createElement("div");
      row.className = "row";
      row.setAttribute("role", "row");
      for (let c = 0; c < COLS; c++) {
        const tile = document.createElement("div");
        tile.className = "tile";
        tile.setAttribute("role", "gridcell");
        tile.setAttribute("aria-label", "empty");
        row.appendChild(tile);
      }
      boardEl.appendChild(row);
    }
    state.guesses.forEach((g, i) => paintRow(state, i, g, state.results[i], false));
    paintCurrent(false);
  }

  function paintCurrent(pop) {
    const row = boardEl.children[state.guesses.length];
    if (!row) return;
    for (let c = 0; c < COLS; c++) {
      const tile = row.children[c];
      const ch = state.current[c];
      const was = tile.textContent;
      tile.textContent = ch ? ch.toUpperCase() : "";
      tile.classList.toggle("filled", !!ch);
      tile.setAttribute("aria-label", ch ? ch.toUpperCase() : "empty");
      if (pop && ch && !was) {
        tile.classList.remove("pop");
        void tile.offsetWidth;
        tile.classList.add("pop");
      }
    }
  }

  /** Reveal a row; resolves when the animation has finished. */
  function paintRow(s, rowIndex, guess, result, animate) {
    const row = boardEl.children[rowIndex];
    // Driven from JS (Web Animations) so the flip does not depend on the stylesheet or on
    // the computer's "reduce motion" option. It always plays.
    const moving = animate;
    const stagger = moving ? 300 : 0;
    const flip = moving ? 600 : 0;
    return new Promise((resolve) => {
      if (!row) return resolve();
      for (let c = 0; c < COLS; c++) {
        const tile = row.children[c];
        tile.textContent = guess[c].toUpperCase();
        tile.classList.add("filled");
        tile.classList.remove("pop");
        const apply = () => {
          tile.classList.add(result[c]);
          tile.setAttribute("aria-label", `${guess[c].toUpperCase()}, ${STATUS_LABEL[result[c]]}`);
          if (state === s) Keyboard.setStatus(guess[c], result[c]);
        };
        if (!flip) {
          apply();
          continue;
        }
        setTimeout(() => {
          if (tile.animate) {
            tile.animate(
              [
                { transform: "perspective(400px) rotateX(0deg)" },
                { transform: "perspective(400px) rotateX(-90deg)", offset: 0.5 },
                { transform: "perspective(400px) rotateX(0deg)" },
              ],
              { duration: flip, easing: "ease-in-out" },
            );
          } else {
            tile.classList.add("flip");
            setTimeout(() => tile.classList.remove("flip"), flip);
          }
          setTimeout(apply, flip / 2);
        }, c * stagger);
      }
      setTimeout(resolve, flip ? (COLS - 1) * stagger + flip + 40 : 0);
    });
  }

  function shake(text) {
    UI.toast(text);
    UI.haptic(30);
    const row = boardEl.children[state.guesses.length];
    if (!row) return;
    row.classList.remove("shake");
    void row.offsetWidth;
    row.classList.add("shake");
    setTimeout(() => row.classList.remove("shake"), 500);
  }

  /* ---------- Finishing ---------- */

  function finish(won, reason) {
    const s = state;
    if (s.finished) return;
    s.finished = true;
    s.won = won;
    if (s.mode !== "lan") stopTimer(); // in a match the round clock runs on until the round ends
    persist();

    if (won) {
      const row = boardEl.children[s.guesses.length - 1];
      if (row) row.classList.add("bounce");
      UI.haptic(40);
    }
    let stats = null;
    if (s.mode !== "lan") stats = Stats.record(won, s.guesses.length);

    const payload = {
      won,
      reason,
      answer: s.answer,
      attempts: s.guesses.length,
      durationMs: Date.now() - s.startedAt,
      mode: s.mode,
      stats,
    };
    finishHandle = setTimeout(
      () => {
        if (state === s) onFinishCb(payload);
      },
      won ? 1100 : 500,
    );
  }

  /** Multiplayer: the host ended the round for everyone. */
  function forceEnd() {
    if (!state || state.finished) return;
    state.finished = true;
    state.locked = false;
    stopTimer();
  }

  /* ---------- Round timer (multiplayer) ---------- */

  function startTimer(totalMs, remainingMs) {
    stopTimer();
    const s = state;
    const bar = document.getElementById("timerBar");
    const label = document.getElementById("hudTimer");
    const endsAt = Date.now() + remainingMs;
    if (bar) bar.classList.remove("hidden", "warn", "danger");
    if (label) label.classList.remove("hidden");

    const tick = () => {
      const left = Math.max(0, endsAt - Date.now());
      const frac = left / totalMs;
      if (bar) {
        bar.firstElementChild.style.transform = `scaleX(${Math.min(1, frac)})`;
        bar.classList.toggle("warn", frac <= 0.5 && frac > 0.25);
        bar.classList.toggle("danger", frac <= 0.25);
      }
      if (label) {
        label.textContent = UI.formatClock(left);
        label.classList.toggle("danger", frac <= 0.25);
      }
      if (left <= 0) {
        stopTimer(true);
        if (state === s && !s.finished) finish(false, "time");
      }
    };
    tick();
    // Based on timestamps, so it stays correct in background tabs.
    timerHandle = setInterval(tick, 200);
  }

  function stopTimer(keepVisible) {
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    if (keepVisible) return;
    const bar = document.getElementById("timerBar");
    const label = document.getElementById("hudTimer");
    if (bar) bar.classList.add("hidden");
    if (label) label.classList.add("hidden");
  }

  return {
    init,
    start,
    input,
    isFinished,
    getMode,
    hasProgress,
    getResult,
    abandon,
    forceEnd,
    stopTimer,
  };
})();
