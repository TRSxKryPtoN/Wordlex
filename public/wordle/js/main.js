/* =========================================================
   main.js
   App shell: home screen, solo mode (Daily / Random), settings,
   statistics, solo results and sharing, plus app-level wiring
   (service worker, Android back button, invite links).
   ========================================================= */
(function () {
  const $ = UI.$;
  const homeModal = $("#homeModal");
  const resultModal = $("#resultModal");
  const statsModal = $("#statsModal");
  const settingsModal = $("#settingsModal");
  const helpModal = $("#helpModal");

  /* ---------- Settings (saved) ---------- */
  const settings = Object.assign(
    {
      theme: "dark", // "dark" | "light" | "system"
      contrast: false,
      haptics: true,
      soloMode: "daily",
      lastHostName: "",
      lastGuestName: "",
    },
    Store.get("settings", null) || {},
  );
  const saveSettings = () => Store.set("settings", settings);
  const systemDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

  function applySettings() {
    const theme =
      settings.theme === "system"
        ? systemDark && !systemDark.matches
          ? "light"
          : "dark"
        : settings.theme;
    document.body.setAttribute("data-theme", theme === "light" ? "light" : "dark");
    document.body.setAttribute("data-contrast", settings.contrast ? "true" : "false");
    document.body.dataset.haptics = settings.haptics ? "on" : "off";
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f7f8fb" : "#0f1115");
  }
  if (systemDark && systemDark.addEventListener)
    systemDark.addEventListener("change", applySettings);
  applySettings();

  /* ---------- Boot ---------- */
  UI.initModals();
  Keyboard.build($("#keyboard"), (k) => Game.input(k));
  Game.init($("#board"), onGameFinish);
  FX.initEggs();
  LanUI.init({
    onExit: goHome,
    getNames: () => ({ host: settings.lastHostName, guest: settings.lastGuestName }),
    saveName: (role, name) => {
      if (role === "host") settings.lastHostName = name;
      else settings.lastGuestName = name;
      saveSettings();
    },
  });

  // A Random puzzle lasts until the app is closed; the Daily word is kept for the day.
  Store.remove("game:random");

  // Show a board behind the home screen straight away.
  Game.start(settings.soloMode === "random" ? "random" : "daily");
  goHome();

  // Invite links: …/index.html?room=ABC123&pass=1234
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("room")) {
      UI.close(homeModal);
      LanUI.openJoinForm({ roomId: LAN.cleanRoomId(q.get("room")), password: q.get("pass") || "" });
      history.replaceState(null, "", location.pathname);
    }
  } catch (e) {
    /* ignore */
  }

  /* ---------- Home ---------- */
  function goHome() {
    document.body.dataset.view = "home";
    document.body.classList.remove("in-match");
    setStatus("");
    UI.open(homeModal);
  }

  $("#choiceSolo").onclick = () => {
    UI.close(homeModal);
    enterSolo(settings.soloMode);
  };
  $("#choiceMulti").onclick = () => {
    UI.close(homeModal);
    LanUI.openStart();
  };
  $("#homeHelp").onclick = () => UI.open(helpModal);
  $("#btnHelp").onclick = () => UI.open(helpModal);

  // Backing out of the multiplayer forms returns to the home screen.
  ["#mpStartModal", "#hostModal", "#joinModal"].forEach((sel) => {
    $(sel).addEventListener("modal:dismiss", () => {
      if (!LanUI.isActive() && document.body.dataset.view === "home") UI.open(homeModal);
    });
  });

  $("#btnHome").onclick = async () => {
    if (LanUI.isActive()) {
      await LanUI.confirmLeave(); // leaving calls goHome via onExit
      return;
    }
    goHome(); // solo games are saved, nothing is lost
  };

  /* ---------- Solo ---------- */
  function setStatus(text) {
    $("#statusLine").textContent = text;
  }

  function nextDailyText() {
    const ms = Rules.msUntilNextDay();
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `Next word in ${h}h ${String(m).padStart(2, "0")}m`;
  }

  function enterSolo(mode, fresh) {
    mode = mode === "random" ? "random" : "daily";
    settings.soloMode = mode;
    saveSettings();
    document.body.dataset.view = "solo";
    document.body.classList.remove("in-match");
    document.querySelectorAll("[data-solo]").forEach((b) => {
      const on = b.dataset.solo === mode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    const info = Game.start(mode, { fresh: !!fresh });
    if (mode === "daily" && info.finished) {
      const r = Game.getResult();
      setStatus(
        (info.won ? `Solved in ${r.guesses.length}/6` : `The word was ${r.answer.toUpperCase()}`) +
          ` · ${nextDailyText()}`,
      );
    } else {
      setStatus("");
    }
  }

  document.querySelectorAll("[data-solo]").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.dataset.solo !== Game.getMode()) enterSolo(b.dataset.solo);
    });
  });

  $("#btnNewPuzzle").onclick = async () => {
    // From Daily, this simply moves to Random (picking up a saved puzzle if there is one).
    if (Game.getMode() !== "random") return enterSolo("random");
    if (Game.hasProgress()) {
      const ok = await UI.confirm("This puzzle will count as a loss.", {
        title: "Start a new puzzle?",
        ok: "New puzzle",
      });
      if (!ok) return;
    }
    Game.abandon();
    enterSolo("random", true);
  };

  /* ---------- Finish ---------- */
  function onGameFinish(p) {
    if (p.mode === "lan") return LanUI.onLocalFinish(p);

    const card = resultModal.querySelector(".modal-card");
    card.classList.remove("wide");
    const statsEl = $("#resultStats");
    statsEl.className = "stats-grid";
    statsEl.innerHTML = statCardsHTML(p.stats || Stats.load());

    $("#resultTitle").textContent = p.won
      ? ["Genius!", "Magnificent!", "Impressive!", "Splendid!", "Great!", "Phew!"][p.attempts - 1]
      : "So close";
    $("#resultWord").innerHTML = `The word was <b>${UI.escapeHtml(p.answer.toUpperCase())}</b>`;

    const again = $("#btnPlayAgain");
    again.classList.remove("hidden");
    again.textContent = p.mode === "daily" ? "Play a random puzzle" : "Play again";
    again.onclick = () => {
      UI.close(resultModal);
      enterSolo("random", true);
    };
    $("#btnBackLobby").classList.add("hidden");
    $("#btnResultChat").classList.add("hidden");
    $("#resultHint").textContent = p.mode === "daily" ? nextDailyText() : "";
    if (p.mode === "daily") {
      setStatus(
        (p.won ? `Solved in ${p.attempts}/6` : "Better luck tomorrow") + ` · ${nextDailyText()}`,
      );
    }
    if (p.won) FX.confetti(p.attempts <= 3 ? 90 : 45);
    UI.open(resultModal);
  }

  /* ---------- Stats ---------- */
  function statCardsHTML(s) {
    return `
      <div class="stat"><div class="v">${s.played}</div><div class="l">Played</div></div>
      <div class="stat"><div class="v">${Stats.winPct(s)}</div><div class="l">Win %</div></div>
      <div class="stat"><div class="v">${s.currentStreak}</div><div class="l">Streak</div></div>
      <div class="stat"><div class="v">${s.bestStreak}</div><div class="l">Best</div></div>`;
  }
  function renderStats() {
    const s = Stats.load();
    $("#statsGrid").innerHTML = statCardsHTML(s);
    const max = Math.max(1, ...s.distribution);
    $("#distribution").innerHTML = s.distribution
      .map((n, i) => {
        const pct = Math.max(8, Math.round((n / max) * 100));
        return `<div class="dist-row"><span>${i + 1}</span>
          <div class="dist-bar ${n > 0 ? "active" : ""}" style="width:${pct}%">${n}</div></div>`;
      })
      .join("");
  }
  $("#btnStats").onclick = () => {
    renderStats();
    UI.open(statsModal);
  };
  $("#btnResetStats").onclick = async () => {
    const ok = await UI.confirm("Your played count, streaks and distribution go back to zero.", {
      title: "Reset statistics?",
      ok: "Reset",
      danger: true,
    });
    if (ok) {
      Stats.reset();
      renderStats();
    }
  };

  /* ---------- Settings UI ---------- */
  function syncSettingsUI() {
    document.querySelectorAll("[data-theme-opt]").forEach((b) => {
      const on = b.dataset.themeOpt === settings.theme;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    $("#toggleContrast").checked = !!settings.contrast;
    $("#toggleHaptics").checked = !!settings.haptics;
  }
  $("#btnSettings").onclick = () => {
    syncSettingsUI();
    UI.open(settingsModal);
  };
  document.querySelectorAll("[data-theme-opt]").forEach((b) => {
    b.addEventListener("click", () => {
      settings.theme = b.dataset.themeOpt;
      saveSettings();
      applySettings();
      syncSettingsUI();
    });
  });
  $("#toggleContrast").addEventListener("change", (e) => {
    settings.contrast = e.target.checked;
    saveSettings();
    applySettings();
  });
  $("#toggleHaptics").addEventListener("change", (e) => {
    settings.haptics = e.target.checked;
    saveSettings();
    applySettings();
    UI.haptic(15);
  });

  /* ---------- App wiring ---------- */

  // Only warn on close/refresh during a multiplayer room (solo games are saved).
  window.addEventListener("beforeunload", (e) => {
    if (LanUI.isActive()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // Android hardware back button (Capacitor "App" plugin, if installed).
  const cap = window.Capacitor;
  const AppPlugin = cap && cap.Plugins && cap.Plugins.App;
  if (AppPlugin && AppPlugin.addListener) {
    homeModal.addEventListener("modal:back", () => AppPlugin.exitApp && AppPlugin.exitApp());
    AppPlugin.addListener("backButton", () => {
      if (UI.back()) return;
      $("#btnHome").click();
    });
  }

  // Offline cache for the website version (native apps already ship the files).
  // Never on localhost: a cached copy there only gets in the way while developing.
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  // Website only: "Get the Android app" on the home screen. Never shown inside the app.
  // Paste the download link (MediaFire, Google Drive, ...) between the quotes below.
  // Left empty, the button shows only if the APK is on the site itself
  // (public/downloads/Wordlex.apk).
  const APK_URL = "https://www.mediafire.com/file/l76cm7hhhdcveh8/Wordlex.apk/file";

  // Website only: visitor counts with Vercel Web Analytics. It works once "Analytics" is
  // enabled for the project in the Vercel dashboard; anywhere else the script is simply absent.
  if (!cap && /^https:$/.test(location.protocol) && !isLocal) {
    window.va =
      window.va ||
      function () {
        (window.vaq = window.vaq || []).push(arguments);
      };
    const s = document.createElement("script");
    s.defer = true;
    s.src = "/_vercel/insights/script.js";
    s.onerror = () => {};
    document.head.appendChild(s);
  }

  if (!cap && /^https?:$/.test(location.protocol)) {
    const link = $("#apkLink");
    if (/^https?:\/\//i.test(APK_URL)) {
      link.href = APK_URL;
      link.removeAttribute("download"); // an outside page: open it instead of saving it
      link.target = "_blank";
      link.rel = "noopener";
      link.classList.remove("hidden");
    } else {
      fetch(link.href, { method: "HEAD", cache: "no-store" })
        .then((res) => {
          const type = res.headers.get("content-type") || "";
          if (res.ok && !/text\/html/i.test(type)) link.classList.remove("hidden");
        })
        .catch(() => {});
    }
  }

  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol) && !cap) {
    if (isLocal) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) =>
          regs.forEach((r) => {
            if (r.scope.indexOf("/wordle/") !== -1) r.unregister();
          }),
        )
        .catch(() => {});
    } else {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
      });
    }
  }

  window.__wordlexBooted = true;
})();
