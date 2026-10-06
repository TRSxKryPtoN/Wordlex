/* =========================================================
   lanui.js
   Multiplayer screens: host / join forms, the lobby (teams up
   front, game blurred behind), in-match HUD and scores, round
   results, final podium, reconnect handling.
   ========================================================= */
window.LanUI = (function () {
  const $ = UI.$;
  const esc = UI.escapeHtml;
  const color = Rules.safeColor;

  const TIMER_OPTIONS = [
    [0, "No timer"],
    [30, "30 seconds"],
    [60, "1 minute"],
    [90, "1 min 30 seconds"],
    [120, "2 minutes"],
    [180, "3 minutes"],
    [300, "5 minutes"],
  ];
  // Keep trying for about two minutes: a host whose app is in the background often returns.
  const RETRY_DELAYS = [
    300, 1200, 2500, 4000, 5000, 6000, 8000, 8000, 10000, 10000, 15000, 15000, 15000, 15000,
  ];

  let hooks = {};
  let active = false; // currently in a room
  let phase = "none"; // "lobby" | "match" | "results"
  let state = null; // last snapshot from the host
  let countdownHandle = null;
  let retryHandle = null;
  let renameTimers = {};
  let nameTimer = null;
  let busy = false;

  const el = {};

  function init(h) {
    hooks = h || {};
    [
      "mpStartModal",
      "hostModal",
      "joinModal",
      "lobbyModal",
      "roundModal",
      "scoresModal",
      "resultModal",
      "reconnectModal",
      "chatModal",
      "hintModal",
    ].forEach((id) => (el[id] = $("#" + id)));

    // Settings dropdowns
    $("#cfgRounds").innerHTML = Array.from(
      { length: 10 },
      (_, i) => `<option value="${i + 1}">${i + 1}</option>`,
    ).join("");
    $("#cfgTimer").innerHTML = TIMER_OPTIONS.map(
      ([v, label]) => `<option value="${v}">${label}</option>`,
    ).join("");

    $("#btnHost").onclick = () => {
      UI.close(el.mpStartModal);
      openHostForm();
    };
    $("#btnJoin").onclick = () => {
      UI.close(el.mpStartModal);
      openJoinForm();
    };
    $("#btnRegenRoom").onclick = fillRoomFields;
    document.querySelectorAll("[data-net]").forEach((b) => {
      b.addEventListener("click", () => setNetMode(b.dataset.net));
    });
    $("#chatForm").addEventListener("submit", onChatSubmit);
    $("#nearbyList").addEventListener("click", onNearbyClick);
    $("#btnRescan").onclick = findRooms;
    $("#btnLobbyChat").onclick = openChat;
    $("#btnResultChat").onclick = openChat;
    $("#hostForm").addEventListener("submit", onHostSubmit);
    $("#joinForm").addEventListener("submit", onJoinSubmit);
    $("#roomIdField").addEventListener("input", (e) => {
      e.target.value = LAN.cleanRoomId(e.target.value);
    });

    // Lobby
    $("#btnLobbyLeave").onclick = confirmLeave;
    $("#btnShareInvite").onclick = shareInvite;
    el.lobbyModal.addEventListener("modal:back", confirmLeave);
    $("#btnLobbyStart").onclick = () => {
      LAN.startMatch();
    };
    $("#lobbyMyName").addEventListener("input", (e) => {
      const name = e.target.value.slice(0, 16);
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => {
        LAN.setName(name);
        if (hooks.saveName) hooks.saveName(LAN.getRole(), name.trim());
      }, 250);
    });
    $("#cfgRounds").addEventListener("change", pushConfig);
    $("#cfgTimer").addEventListener("change", pushConfig);
    $("#lobbyTeams").addEventListener("click", onTeamsClick);
    $("#lobbyTeams").addEventListener("input", onTeamsInput);
    $("#lobbyTeams").addEventListener("focusout", onTeamsBlur);

    // In-match
    $("#btnHint").onclick = openHint;
    $("#btnMatchChat").onclick = openChat;
    el.hintModal.addEventListener("click", (e) => {
      const b = e.target.closest("[data-hint]");
      if (b) takeHint(b.dataset.hint);
    });
    $("#btnScores").onclick = () => {
      renderScores();
      UI.open(el.scoresModal);
    };
    $("#btnEndRound").onclick = async () => {
      if (
        !(await UI.confirm("Players who have not finished get 0 for this round.", {
          title: "End this round now?",
          ok: "End round",
        }))
      )
        return;
      UI.close(el.scoresModal);
      LAN.endRoundNow();
    };
    $("#btnRestartMatch").onclick = async () => {
      if (
        !(await UI.confirm("Scores go back to zero. Teams stay the same.", {
          title: "Restart the match?",
          ok: "Restart",
        }))
      )
        return;
      UI.close(el.scoresModal);
      LAN.startMatch();
    };
    $("#btnLeaveMatch").onclick = confirmLeave;

    // Final results
    $("#btnBackLobby").onclick = () => {
      UI.close(el.resultModal);
      openLobby();
    };
    el.resultModal.addEventListener("modal:dismiss", () => {
      if (active && phase === "results") openLobby();
    });

    // Reconnect
    $("#btnReconnect").onclick = () => tryRejoin(0, true);
    $("#btnReconnectHome").onclick = () => leaveRoom();

    LAN.on({
      onState,
      onRound,
      onRoundEnd,
      onTeammateSolved: (m) => {
        if (phase !== "match") return;
        UI.haptic(20);
        UI.toast(`${m.name} solved it in ${m.tries}/6 for your team!`, 3000);
      },
      onEnd,
      onConnection,
      onChat: addChat,
      onChatLog: renderChatLog,
      onKicked: () => {
        leaveRoom();
        UI.toast("You were removed from the room", 2600);
      },
    });
  }

  /* ---------- Entry points ---------- */

  function isActive() {
    return active;
  }

  /* ---------- Connection mode: online, or same Wi-Fi with no internet (app only) ---------- */

  let netMode = "online";

  function setNetMode(m) {
    netMode = m === "local" && LAN.localAvailable() ? "local" : "online";
    Store.set("netMode", netMode);
    document.querySelectorAll("[data-net]").forEach((b) => {
      const on = b.dataset.net === netMode;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    $("#mpHint").textContent =
      netMode === "local"
        ? "Everyone joins the same Wi-Fi or phone hotspot. No internet needed."
        : "";
  }

  function openStart() {
    const canLocal = LAN.localAvailable();
    $("#netModeSeg").classList.toggle("hidden", !canLocal);
    // Offline play is the default in the app; fall back to online in a browser.
    setNetMode(canLocal ? Store.get("netMode", "local") : "online");
    UI.open(el.mpStartModal);
  }

  function fillRoomFields() {
    $("#roomIdField").value = LAN.generateRoomId();
    $("#roomPassField").value = LAN.generatePassword();
  }

  function openHostForm() {
    const names = hooks.getNames ? hooks.getNames() : {};
    $("#hostName").value = names.host || "";
    // Start empty; the "New" button suggests a random Room ID and password.
    $("#roomIdField").value = "";
    $("#roomPassField").value = "";
    $("#hostHint").textContent =
      netMode === "local"
        ? "Type your own, or tap New. Friends on the same Wi-Fi will see this room in their list."
        : "Type your own, or tap New for a random Room ID and password.";
    setFormBusy("#btnCreateRoom", false, "Create room");
    $("#hostStatus").textContent = "";
    UI.open(el.hostModal);
  }

  function openJoinForm(prefill) {
    const names = hooks.getNames ? hooks.getNames() : {};
    $("#guestName").value = names.guest || "";
    $("#joinRoomId").value = (prefill && prefill.roomId) || "";
    $("#joinRoomPass").value = (prefill && prefill.password) || "";
    setFormBusy("#btnGuestJoin", false, "Join room");
    $("#joinStatus").textContent = "";
    UI.open(el.joinModal);
    // Same Wi-Fi mode: list the rooms found on this network.
    const local = netMode === "local";
    $("#nearby").classList.toggle("hidden", !local);
    picked = null;
    if (local) findRooms();
    else scanToken++; // stop any search still running
  }

  /* ---------- Rooms nearby (Same Wi-Fi mode) ---------- */

  let picked = null; // { roomId, ip } chosen from the list
  let nearby = [];
  let scanToken = 0;

  let searchingNow = false;

  function renderNearby(searching, problem) {
    searchingNow = !!searching;
    const list = $("#nearbyList");
    const rows = nearby
      .map(
        (
          r,
          i,
        ) => `<button class="room-row${picked && picked.ip === r.ip ? " selected" : ""}" type="button" data-room="${i}">
          <span class="room-row-main"><b>${esc(r.roomId)}</b><span class="muted">Host: ${esc(r.hostName)}</span></span>
          <span class="room-row-side">${r.inMatch ? '<span class="tag">In match</span>' : ""}<span class="tag">${r.players}${r.max ? "/" + r.max : ""} players</span></span>
        </button>`,
      )
      .join("");
    let note = "";
    if (problem) note = `<p class="nearby-note">${esc(problem)}</p>`;
    else if (searching) note = '<p class="nearby-note">Searching this Wi-Fi…</p>';
    else if (!nearby.length)
      note =
        '<p class="nearby-note">No rooms found. Check that you are on the host\'s Wi-Fi or hotspot, then tap Refresh.</p>';
    list.innerHTML = rows + note;
    $("#btnRescan").disabled = !!searching;
  }

  function findRooms() {
    const token = ++scanToken;
    nearby = [];
    renderNearby(true);
    LAN.findRooms({
      cancelled: () => token !== scanToken || !UI.isOpen(el.joinModal),
      onRoom: (room) => {
        if (token !== scanToken) return;
        nearby.push(room);
        renderNearby(true);
      },
    })
      .then(() => token === scanToken && renderNearby(false))
      .catch(
        () =>
          token === scanToken &&
          renderNearby(false, "Connect to the host's Wi-Fi or hotspot first, then tap Refresh."),
      );
  }

  function onNearbyClick(e) {
    const row = e.target.closest("[data-room]");
    if (!row) return;
    const room = nearby[+row.dataset.room];
    if (!room) return;
    picked = { roomId: room.roomId, ip: room.ip };
    $("#joinRoomId").value = room.roomId;
    renderNearby(searchingNow);
    $("#joinStatus").textContent = "";
    $("#joinRoomPass").focus({ preventScroll: true });
  }

  function setFormBusy(sel, on, label) {
    const b = $(sel);
    b.disabled = on;
    b.textContent = label;
    busy = on;
  }

  async function onHostSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const name = $("#hostName").value.trim() || "Host";
    const saved = Store.get("matchCfg", null) || {};
    setFormBusy("#btnCreateRoom", true, "Creating…");
    $("#hostStatus").textContent = "";
    try {
      await LAN.hostOpen({
        mode: netMode,
        roomId: $("#roomIdField").value,
        password: $("#roomPassField").value,
        name,
        teams: saved.teams,
        cfg: saved,
      });
      if (hooks.saveName) hooks.saveName("host", name);
      UI.close(el.hostModal);
      enterRoom();
    } catch (err) {
      $("#hostStatus").textContent = (err && err.message) || "Could not open the room";
    }
    setFormBusy("#btnCreateRoom", false, "Create room");
  }

  async function onJoinSubmit(e) {
    e.preventDefault();
    if (busy) return;
    const name = $("#guestName").value.trim() || "Player";
    setFormBusy("#btnGuestJoin", true, "Joining…");
    $("#joinStatus").textContent = "";
    try {
      const typedId = LAN.cleanRoomId($("#joinRoomId").value);
      await LAN.guestConnect({
        mode: netMode,
        // The address is known when the room was picked from the list; a typed Room ID
        // is looked up on the network instead.
        address: picked && picked.roomId === typedId ? picked.ip : null,
        roomId: $("#joinRoomId").value,
        password: $("#joinRoomPass").value.trim(),
        name,
      });
      if (hooks.saveName) hooks.saveName("guest", name);
      UI.close(el.joinModal);
      enterRoom();
    } catch (err) {
      $("#joinStatus").textContent = (err && err.message) || "Could not join";
    }
    setFormBusy("#btnGuestJoin", false, "Join room");
  }

  function enterRoom() {
    active = true;
    state = LAN.getView() || state;
    document.body.dataset.view = "lan";
    LocalNet.keepAwake(true); // screen stays on in a room so the connection is not dropped
    $("#lobbyMyName").value = "";
    $("#chatInput").value = "";
    if (LAN.getRole() === "host") renderChatLog([]);
    setUnread(0);
    openLobby();
  }

  /* ---------- Leaving ---------- */

  async function confirmLeave() {
    if (!active) return true;
    const host = LAN.getRole() === "host";
    const ok = await UI.confirm(
      host
        ? "The next player becomes the host and the room stays open."
        : "You can rejoin with the Room ID and password.",
      {
        title: host ? "Close the room?" : "Leave the room?",
        ok: host ? "Close room" : "Leave",
        danger: true,
      },
    );
    if (ok) leaveRoom();
    return ok;
  }

  function leaveRoom() {
    clearInterval(countdownHandle);
    clearTimeout(retryHandle);
    LocalNet.keepAwake(false);
    LAN.reset();
    active = false;
    phase = "none";
    state = null;
    Object.keys(el).forEach((k) => UI.close(el[k]));
    Game.stopTimer();
    Game.forceEnd();
    setStatus("");
    setHostAway(false);
    setHints(null);
    setMatchChat(false);
    hostId = null;
    renderChatLog([]);
    setUnread(0);
    if (hooks.onExit) hooks.onExit();
  }

  /* ---------- Lobby ---------- */

  function openLobby() {
    phase = "lobby";
    document.body.dataset.view = "lan";
    document.body.classList.remove("in-match");
    setStatus("");
    UI.close(el.scoresModal);
    UI.close(el.roundModal);
    renderLobby(true);
    UI.open(el.lobbyModal);
  }

  function me() {
    const id = LAN.getMyId();
    return state && state.players.find((p) => p.id === id);
  }

  function cfgText(cfg) {
    const t = TIMER_OPTIONS.find(([v]) => v === cfg.timer);
    const timer = cfg.timer > 0 ? (t ? t[1] : cfg.timer + " seconds") + " per round" : "No timer";
    return `${cfg.rounds} round${cfg.rounds === 1 ? "" : "s"} · ${timer}`;
  }

  function renderLobby(force) {
    if (!state) return;
    const host = LAN.isAdmin();
    const mine = me();
    const room = LAN.getRoom() || {};

    $("#lobbyRoomId").textContent = room.roomId || "—";
    $("#lobbyRoomPass").textContent = room.password || "—";

    const nameInput = $("#lobbyMyName");
    if (mine && document.activeElement !== nameInput) nameInput.value = mine.name;

    const online = state.players.filter((p) => p.connected).length;
    $("#lobbyCount").textContent = `${online} player${online === 1 ? "" : "s"}`;

    renderTeams(host, mine, force);

    // Settings: the host edits, everyone else reads.
    $("#lobbyCfgEdit").classList.toggle("hidden", !host);
    $("#lobbyCfgView").classList.toggle("hidden", host);
    if (host) {
      if (document.activeElement !== $("#cfgRounds")) $("#cfgRounds").value = state.cfg.rounds;
      const timerSel = $("#cfgTimer");
      if (document.activeElement !== timerSel) {
        if (!TIMER_OPTIONS.some(([v]) => v === state.cfg.timer)) {
          timerSel.insertAdjacentHTML(
            "beforeend",
            `<option value="${state.cfg.timer}">${state.cfg.timer} seconds</option>`,
          );
        }
        timerSel.value = state.cfg.timer;
      }
      Store.set("matchCfg", {
        rounds: state.cfg.rounds,
        timer: state.cfg.timer,
        teams: state.teams,
      });
    } else {
      $("#lobbyCfgView").textContent = cfgText(state.cfg);
    }

    $("#btnLobbyStart").classList.toggle("hidden", !host);
    $("#lobbyHint").textContent = host
      ? online < 2
        ? "Share the Room ID and password so friends can join."
        : "Everyone picks a team, then start when ready."
      : "Waiting for the host to start…";
  }

  function teamSignature(host, mine) {
    return JSON.stringify([
      host,
      mine && mine.team,
      state.teams.map((t) => t.color),
      state.players.map((p) => [p.id, p.name, p.team, p.connected, p.isHost]),
    ]);
  }

  let lastSig = "";
  function renderTeams(host, mine, force) {
    const box = $("#lobbyTeams");
    const sig = teamSignature(host, mine);
    if (!force && sig === lastSig) {
      // Same structure: only refresh team names the user is not editing.
      box.querySelectorAll("[data-team-input]").forEach((inp) => {
        const t = state.teams[+inp.dataset.teamInput];
        if (t && document.activeElement !== inp && !renameTimers[inp.dataset.teamInput])
          inp.value = t.name;
      });
      return;
    }
    lastSig = sig;

    // Keep what the user is typing across the rebuild.
    const focused = document.activeElement;
    let keep = null;
    if (focused && focused.dataset && focused.dataset.teamInput != null && box.contains(focused)) {
      keep = {
        i: focused.dataset.teamInput,
        value: focused.value,
        start: focused.selectionStart,
        end: focused.selectionEnd,
      };
    }

    const myId = LAN.getMyId();
    const canAdd = state.teams.length < LAN.limits.MAX_TEAMS; // any player may add a team
    box.innerHTML =
      state.teams
        .map((t, i) => {
          const members = state.players.filter((p) => p.team === i);
          const isMine = mine && mine.team === i;
          const rows = members.length
            ? members
                .map((p) => {
                  const initial = esc((p.name || "?").trim().charAt(0).toUpperCase() || "?");
                  return `<li class="member${p.id === myId ? " me" : ""}${p.connected ? "" : " off"}">
                    <span class="avatar" aria-hidden="true">${initial}</span>
                    <span class="member-name">${esc(p.name)}</span>
                    ${
                      p.id === myId
                        ? '<span class="tag you">You</span>'
                        : p.isHost
                          ? '<span class="tag">Host</span>'
                          : ""
                    }
                    ${
                      host && p.id !== myId && !p.isServer
                        ? `<button class="btn-x" type="button" data-kick="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">×</button>`
                        : ""
                    }
                  </li>`;
                })
                .join("")
            : '<li class="member empty">No players yet</li>';
          return `<section class="team-card${isMine ? " mine" : ""}" style="--team:${color(t.color)}">
            <div class="team-card-head">
              <span class="swatch" aria-hidden="true"></span>
              <input class="team-name" type="text" maxlength="14" value="${esc(t.name)}"
                data-team-input="${i}" aria-label="Team ${i + 1} name" autocomplete="off" spellcheck="false" enterkeyhint="done" />
              <span class="team-count">${members.length}</span>
              ${
                host && state.teams.length > 1
                  ? `<button class="btn-x" type="button" data-remove-team="${i}" aria-label="Remove team ${esc(t.name)}">×</button>`
                  : ""
              }
            </div>
            <ul class="team-members">${rows}</ul>
            ${
              isMine
                ? '<div class="team-joined">Your team</div>'
                : `<button class="btn-join" type="button" data-join="${i}">Join team</button>`
            }
          </section>`;
        })
        .join("") +
      (canAdd ? '<button class="team-add" type="button" data-add-team>+ Add team</button>' : "");

    if (keep) {
      const inp = box.querySelector(`[data-team-input="${keep.i}"]`);
      if (inp) {
        inp.value = keep.value;
        inp.focus({ preventScroll: true });
        try {
          inp.setSelectionRange(keep.start, keep.end);
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  function onTeamsClick(e) {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.join != null) {
      UI.haptic(10);
      LAN.chooseTeam(+t.dataset.join);
    } else if (t.dataset.addTeam != null) {
      LAN.addTeam();
    } else if (t.dataset.removeTeam != null) {
      LAN.removeTeam(+t.dataset.removeTeam);
    } else if (t.dataset.kick) {
      const p = state.players.find((x) => x.id === t.dataset.kick);
      UI.confirm("They can rejoin with the Room ID and password.", {
        title: `Remove ${p ? p.name : "this player"}?`,
        ok: "Remove",
        danger: true,
      }).then((ok) => ok && LAN.kick(t.dataset.kick));
    }
  }

  function onTeamsInput(e) {
    const inp = e.target;
    if (inp.dataset.teamInput == null) return;
    const i = inp.dataset.teamInput;
    clearTimeout(renameTimers[i]);
    renameTimers[i] = setTimeout(() => {
      delete renameTimers[i];
      const name = inp.value.trim();
      if (name) LAN.renameTeam(+i, name);
    }, 250);
  }

  function onTeamsBlur(e) {
    const inp = e.target;
    if (inp.dataset.teamInput == null || !state) return;
    const t = state.teams[+inp.dataset.teamInput];
    if (t && !inp.value.trim()) inp.value = t.name; // a team can't be nameless
  }

  function shareInvite() {
    const room = LAN.getRoom();
    if (!room) return;
    let text = `Join my Wordlex room!\nRoom ID: ${room.roomId}\nPassword: ${room.password}`;
    if (LAN.getMode() === "local") {
      text += "\nJoin my Wi-Fi or hotspot first, then choose Same Wi-Fi in the game.";
    } else if (/^https:$/.test(location.protocol) && !window.Capacitor) {
      const url = new URL(location.href);
      url.search = "";
      url.hash = "";
      url.searchParams.set("room", room.roomId);
      url.searchParams.set("pass", room.password);
      text += `\n${url.toString()}`;
    }
    UI.shareText(text, "Invite copied");
  }

  function pushConfig() {
    LAN.setConfig({
      rounds: parseInt($("#cfgRounds").value, 10),
      timer: parseInt($("#cfgTimer").value, 10),
    });
  }

  /* ---------- Callbacks from LAN ---------- */

  let hostId = null;

  function onState(s) {
    if (!active && LAN.getRole()) active = true;
    const h = s.players.find((p) => p.isHost);
    if (h && hostId && h.id !== hostId) {
      const mineNow = h.id === LAN.getMyId();
      // The device that runs the room announces its own take-over elsewhere.
      if (!mineNow) UI.toast(`${h.name} is now the host`, 3000);
      else if (LAN.getRole() !== "host") UI.toast("You are the host again", 3000);
      if (phase === "lobby") lastSig = "";
      if (phase === "results") showResultControls();
    }
    if (h) hostId = h.id;
    state = s;
    if (!s.inMatch) {
      if (phase === "match")
        openLobby(); // the match ended while we were away
      else if (phase === "lobby") renderLobby(false);
      return;
    }
    if (phase === "lobby") {
      // Joined a room where a match is already running.
      showMatchView();
      Game.start("lan", { done: true });
      setStatus("Match in progress — you'll play from the next round.");
    }
    renderHud();
    showTeammateSolves();
    setDoneStatus();
    if (UI.isOpen(el.scoresModal)) renderScores();
  }

  function showMatchView() {
    phase = "match";
    document.body.dataset.view = "lan";
    document.body.classList.add("in-match");
    UI.close(el.lobbyModal);
    UI.close(el.resultModal);
    UI.close(el.roundModal);
    UI.close(el.reconnectModal);
  }

  function onRound(msg) {
    clearInterval(countdownHandle);
    if (!(msg.done || msg.spectating)) UI.close(el.chatModal); // I am guessing: chat is closed
    showMatchView();
    $("#hudRound").textContent = msg.n;
    $("#hudTotal").textContent = msg.total;
    Game.start("lan", {
      evaluator: (g) => LAN.submitGuess(g),
      timer: msg.timer,
      remainingMs: msg.remainingMs,
      history: msg.history,
      done: msg.done,
      won: msg.won,
    });
    setHints(msg.done ? null : msg.hints);
    // Chat opens for a player once their own round is over (or they are only watching).
    setMatchChat(!!(msg.done || msg.spectating));
    if (msg.spectating) setStatus("Match in progress — you'll play from the next round.");
    else if (msg.done) setDoneStatus("You have finished this round.");
    else setStatus("");
    if (!msg.done) doneBase = "";
    renderHud();
  }

  /** While I'm still guessing, keep the names of teammates who have solved it on screen. */
  function showTeammateSolves() {
    const mine = me();
    if (phase !== "match" || !mine || mine.status !== "playing" || Game.isFinished()) return;
    const names = state.players
      .filter((p) => p.id !== mine.id && p.team === mine.team && p.status === "won")
      .map((p) => p.name);
    if (names.length)
      setStatus(`Solved by your teammate${names.length > 1 ? "s" : ""}: ${names.join(", ")}`);
  }

  /** Called by main.js when this player's own board is finished. */
  function onLocalFinish(p) {
    if (phase !== "match") return;
    setHints(null);
    UI.close(el.hintModal);
    setMatchChat(true);
    if (p.won) {
      setDoneStatus("Solved!");
      FX.confetti(40);
    } else if (p.reason === "time") setStatus("Time's up!");
    else setDoneStatus("Out of guesses.");
  }

  let doneBase = ""; // set once my own round is over

  /** After I finish: say how many players the round is still waiting for. */
  function setDoneStatus(base) {
    if (base != null) doneBase = base;
    if (!doneBase || phase !== "match" || !state) return;
    const n = state.players.filter((p) => p.connected && p.status === "playing").length;
    setStatus(
      n > 0
        ? `${doneBase} Waiting for ${n} player${n === 1 ? "" : "s"}. You can chat meanwhile.`
        : `${doneBase} Round is ending…`,
    );
  }

  function setStatus(text) {
    $("#statusLine").textContent = text;
  }

  function renderHud() {
    if (!state) return;
    if (state.round) $("#hudRound").textContent = state.round;
    $("#hudTotal").textContent = state.total;
    const mine = me();
    $("#teamChips").innerHTML = state.teamScores
      .map(
        (t) => `<span class="chip${mine && mine.team === t.id ? " mine" : ""}">
          <span class="swatch" style="background:${color(t.color)}"></span>
          <span class="chip-name">${esc(t.name)}</span><b>${t.score}</b></span>`,
      )
      .join("");
  }

  function statusTag(p) {
    if (!p.connected) return '<span class="tag off">offline</span>';
    if (p.status === "won") return `<span class="tag ok">solved ${p.tries}/6</span>`;
    if (p.status === "lost") return '<span class="tag bad">missed</span>';
    if (p.status === "playing") return `<span class="tag">${p.tries}/6</span>`;
    return "";
  }

  const sameScore = (a, b) => a.score === b.score;

  function leaderboardHTML(s, opts) {
    opts = opts || {};
    const myId = LAN.getMyId();
    const rows = ['<div class="lb-section">Teams</div>'];
    const teamRanks = Rules.ranks(s.teamScores, sameScore);
    s.teamScores.forEach((t, i) => {
      rows.push(`<div class="lb-row rank-${teamRanks[i]}">
        <span class="lb-rank">${teamRanks[i]}</span>
        <span class="lb-name"><span class="swatch" style="background:${color(t.color)}"></span><b>${esc(t.name)}</b>
          <span class="muted">· ${t.members} player${t.members === 1 ? "" : "s"}</span></span>
        <span class="pts">${t.score}</span>
      </div>`);
    });
    rows.push('<div class="lb-section">Players</div>');
    const sorted = [...s.players].sort(Rules.comparePlayers);
    const playerRanks = Rules.ranks(sorted, sameScore);
    sorted.forEach((p, i) => {
      const team = s.teams ? s.teams[p.team] : state && state.teams[p.team];
      const extra = opts.gained
        ? p.gained > 0
          ? `<span class="tag ok">+${p.gained}</span>`
          : p.gained < 0
            ? `<span class="tag bad">−${-p.gained}</span>`
            : '<span class="tag">+0</span>'
        : statusTag(p);
      rows.push(`<div class="lb-row rank-${playerRanks[i]}${p.id === myId ? " me" : ""}">
          <span class="lb-rank">${playerRanks[i]}</span>
          <span class="lb-name"><span class="swatch" style="background:${color(team && team.color)}"></span>${esc(p.name)} ${extra}</span>
          <span class="pts">${p.score}</span>
        </div>`);
    });
    return rows.join("");
  }

  function renderScores() {
    if (!state) return;
    const host = LAN.isAdmin();
    $("#leaderboard").innerHTML = leaderboardHTML(state);
    $("#btnEndRound").classList.toggle("hidden", !host);
    $("#btnRestartMatch").classList.toggle("hidden", !host);
    $("#btnLeaveMatch").textContent = host ? "Close room" : "Leave match";
  }

  function onRoundEnd(p) {
    doneBase = "";
    Game.forceEnd();
    Game.stopTimer(); // also for players who had already finished
    UI.close(el.chatModal);
    setHints(null);
    UI.close(el.hintModal);
    setStatus("");
    UI.close(el.scoresModal);
    $("#roundTitle").textContent = `Round ${p.round} of ${p.total}`;
    $("#roundWord").innerHTML = `The word was <b>${esc(String(p.answer).toUpperCase())}</b>`;
    $("#roundLeaderboard").innerHTML = leaderboardHTML(
      { players: p.players, teamScores: p.teamScores, teams: state && state.teams },
      { gained: true },
    );
    const endsAt = Date.now() + p.nextInMs;
    const hint = $("#roundNextHint");
    const tick = () => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      hint.textContent = p.last ? `Final results in ${left}…` : `Next round in ${left}…`;
      if (left <= 0) clearInterval(countdownHandle);
    };
    clearInterval(countdownHandle);
    countdownHandle = setInterval(tick, 250);
    tick();
    UI.open(el.roundModal);
  }

  /* ---------- Final results ---------- */

  function onEnd(p) {
    clearInterval(countdownHandle);
    phase = "results";
    Game.stopTimer();
    UI.close(el.chatModal);
    Game.forceEnd();
    setStatus("");
    document.body.classList.remove("in-match");
    UI.close(el.roundModal);
    UI.close(el.scoresModal);

    const teamsList = p.teamScores || [];
    const players = [...(p.players || [])].sort(Rules.comparePlayers);
    // Only teams that actually have players can win or tie.
    const active = teamsList.filter((t) => t.members > 0);
    const topScore = active.length ? active[0].score : 0;
    const tied = active.filter((t) => t.score === topScore);
    // A draw with no podium only when every score is exactly zero. Hints can push a score
    // below zero, and then 0 beats -3 like any other higher score.
    const nobodyScored = players.every((x) => x.score === 0);
    const isDraw = nobodyScored || tied.length > 1;
    const badge = (t) =>
      `<span class="badge"><span class="swatch" style="background:${color(t.color)}"></span>${esc(t.name)}</span>`;

    const aw = p.awards || { best: null, teams: {} };
    const byId = (id) => players.find((x) => x.id === id) || null;
    const mvpOf = (teamId) => byId((aw.teams || {})[teamId]);

    const card = el.resultModal.querySelector(".modal-card");
    card.classList.add("wide");
    const stats = $("#resultStats");
    stats.className = "lan-results";

    $("#resultTitle").textContent = isDraw ? "DRAW" : "MATCH OVER";
    if (nobodyScored)
      $("#resultWord").innerHTML =
        '<div class="win-team">Nobody scored, so there is no winner.</div>';
    else if (tied.length > 1)
      $("#resultWord").innerHTML =
        `<div class="win-team">${tied.map(badge).join(" ")} tied on ${topScore} pts</div>`;
    else if (active.length === 1)
      $("#resultWord").innerHTML =
        `<div class="win-team">${badge(active[0])} finished with ${topScore} pts</div>`;
    else if (active.length)
      $("#resultWord").innerHTML =
        `<div class="win-team">Winner ${badge(active[0])} with ${topScore} pts</div>`;
    else $("#resultWord").textContent = "";

    // Players level on points share a place, a podium step and the Best player card.
    const places = Rules.ranks(players, sameScore);
    const leaders = nobodyScored ? [] : players.filter((x) => x.score === players[0].score);
    const teamPlaces = Rules.ranks(teamsList, sameScore);

    // The podium is for teams: the match is a team contest. Players are listed below it.
    const activePlaces = Rules.ranks(active, sameScore);
    const playerRow = (x, i) => {
      const t = teamOf(x, p) || {};
      const isMvp = mvpOf(x.team) && mvpOf(x.team).id === x.id;
      return `<div class="lb-row rank-${nobodyScored ? 0 : places[i]}${x.id === LAN.getMyId() ? " me" : ""}">
        <span class="lb-rank">${nobodyScored ? "–" : places[i]}</span>
        <span class="lb-name"><span class="swatch" style="background:${color(t.color)}"></span>${esc(x.name)}
          <span class="muted">· ${esc(t.name || "")}</span>
          ${isMvp ? '<span class="tag ok">MVP</span>' : ""}</span>
        <span class="pts">${x.score}</span></div>`;
    };
    const teamRow = (t, i) => `<div class="lb-row">
        <span class="lb-rank">${nobodyScored ? "–" : teamPlaces[i]}</span>
        <span class="lb-name"><span class="swatch" style="background:${color(t.color)}"></span><b>${esc(t.name)}</b>
          <span class="muted">· ${t.members}</span></span>
        <span class="pts">${t.score}</span></div>`;
    // Teams that did not fit on the podium (4th and lower, or empty teams).
    const offPodium = teamsList
      .map((t, i) => [t, i])
      .filter(([t]) => nobodyScored || active.indexOf(t) < 0 || active.indexOf(t) > 2);

    stats.innerHTML =
      // With no points on the board there is no podium, only the lists.
      (nobodyScored
        ? ""
        : podiumHTML(
            active.slice(0, 3).map((t) => ({
              name: t.name,
              score: t.score,
              color: t.color,
              badge: mvpOf(t.id)
                ? `MVP ${mvpOf(t.id).name}`
                : `${t.members} player${t.members === 1 ? "" : "s"}`,
            })),
            activePlaces,
          )) +
      (offPodium.length
        ? `<div class="rest-list">${offPodium.map(([t, i]) => teamRow(t, i)).join("")}</div>`
        : "") +
      (leaders.length
        ? `<div class="award"><span class="award-label">${leaders.length > 1 ? "Best players · tied" : "Best player"}</span>
            ${leaders
              .map(
                (x) =>
                  `<span class="award-name"><span class="swatch" style="background:${color((teamOf(x, p) || {}).color)}"></span>${esc(x.name)}</span>`,
              )
              .join("")}
            <span class="award-pts">${leaders[0].score} pts${leaders.length > 1 ? " each" : ` · ${leaders[0].roundsWon} solved`}</span></div>`
        : "") +
      `<h3>Players</h3><div class="team-summary">${players.map(playerRow).join("")}</div>`;

    showResultControls();

    UI.open(el.resultModal);
    if (!nobodyScored) FX.confetti(90);
  }

  /** Buttons under the final results; refreshed if the host controls change hands. */
  function showResultControls() {
    const host = LAN.isAdmin();
    const again = $("#btnPlayAgain");
    again.classList.toggle("hidden", !host);
    again.textContent = "Play again";
    again.onclick = () => LAN.startMatch();
    $("#btnBackLobby").classList.remove("hidden");
    $("#btnResultChat").classList.remove("hidden");
    $("#resultHint").textContent = host
      ? "Play again with the same teams, or go back to the lobby to change them."
      : "Waiting for the host to start the next match.";
  }

  function teamOf(p, payload) {
    const list = (state && state.teams) || [];
    if (list[p.team]) return list[p.team];
    const t = (payload.teamScores || []).find((x) => x.id === p.team);
    return t || null;
  }

  /** items: up to three { name, score, color, badge }, best first. places: their shared ranks. */
  function podiumHTML(items, places) {
    if (!items.length) return "";
    const order = [1, 0, 2]; // visual order: 2nd, 1st, 3rd
    const medal = { 1: "gold", 2: "silver", 3: "bronze" };
    const cells = order
      .map((idx) => {
        const it = items[idx];
        if (!it) return ""; // fewer than three: the others stay centred
        const place = places[idx]; // level on points: same place and same medal
        const c = color(it.color);
        const initial = esc((it.name || "?").trim().charAt(0).toUpperCase() || "?");
        return `<div class="podium-spot ${medal[place]}">
          <div class="podium-head">
            <div class="podium-avatar" style="background:${c}">${initial}</div>
            <div class="podium-name">${esc(it.name)}</div>
            <div class="podium-score">${it.score} pts</div>
          </div>
          <div class="podium-pedestal">
            <div class="podium-medal" aria-label="Place ${place}">${place}</div>
            <div class="podium-badge" style="background:${c}">${esc(it.badge)}</div>
          </div>
        </div>`;
      })
      .join("");
    return `<div class="podium-wrap"><div class="podium">${cells}</div></div>`;
  }
  /* ---------- Chat ---------- */

  const CHAT_DOM_MAX = 100;
  let unread = 0;

  function chatRow(m) {
    const team = state && state.teams[m.team];
    const mine = m.id === LAN.getMyId();
    return `<div class="chat-msg${mine ? " me" : ""}">
      <span class="swatch" style="background:${color(team && team.color)}"></span><span class="chat-name">${esc(m.name)}</span><span class="chat-text">${esc(m.text)}</span>
    </div>`;
  }

  function renderChatLog(items) {
    const log = $("#chatLog");
    log.innerHTML = items.length
      ? items.slice(-CHAT_DOM_MAX).map(chatRow).join("")
      : '<p class="chat-empty">No messages yet. Say hi!</p>';
    log.scrollTop = log.scrollHeight;
  }

  function addChat(m) {
    const log = $("#chatLog");
    const empty = log.querySelector(".chat-empty");
    if (empty) empty.remove();
    log.insertAdjacentHTML("beforeend", chatRow(m));
    // The new line slides in: from the right if it is mine, from the left if received.
    const row = log.lastElementChild;
    if (row) row.classList.add(m.id === LAN.getMyId() ? "in-sent" : "in-received");
    while (log.children.length > CHAT_DOM_MAX) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
    // Chat closed: count it on the Chat buttons and show a short preview.
    if (!UI.isOpen(el.chatModal) && m.id !== LAN.getMyId()) {
      setUnread(unread + 1);
      ringChat();
      const text = String(m.text);
      UI.toast(`${m.name}: ${text.length > 60 ? text.slice(0, 60) + "…" : text}`, 2600);
    }
  }

  function setMatchChat(on) {
    $("#btnMatchChat").classList.toggle("hidden", !on);
  }

  function setUnread(n) {
    unread = n;
    document.querySelectorAll("[data-chat-badge]").forEach((b) => {
      b.textContent = n > 9 ? "9+" : String(n);
      b.classList.toggle("hidden", n === 0);
    });
  }

  /** Wiggle the chat icon and pop its badge when a message arrives. */
  function ringChat() {
    document.querySelectorAll(".chat-btn").forEach((b) => {
      b.classList.remove("ring");
      void b.offsetWidth; // restart the animation if it is already running
      b.classList.add("ring");
      setTimeout(() => b.classList.remove("ring"), 900);
    });
  }

  function openChat() {
    setUnread(0);
    UI.open(el.chatModal);
    const log = $("#chatLog");
    log.scrollTop = log.scrollHeight;
  }

  function onChatSubmit(e) {
    e.preventDefault();
    const input = $("#chatInput");
    const text = input.value.trim();
    if (!text) return;
    if (LAN.sendChat(text)) input.value = "";
    else UI.toast("Slow down a little");
    input.focus({ preventScroll: true });
  }

  /* ---------- Hints (cost 1 point each) ---------- */

  let hints = null; // { left, max } while I can still take one this round

  /** Show what earlier hints revealed on the keyboard, and whether more can be taken. */
  function setHints(h) {
    hints = h && h.left > 0 ? { left: h.left, max: h.max || h.left } : null;
    if (h) {
      (h.absent || []).forEach((ch) => Keyboard.setStatus(ch, "absent"));
      (h.present || []).forEach((ch) => Keyboard.setStatus(ch, "present"));
    }
    const b = $("#btnHint");
    b.classList.toggle("hidden", !h);
    b.disabled = !hints;
  }

  function openHint() {
    if (!hints || phase !== "match" || Game.isFinished()) return;
    $("#hintLeft").textContent =
      `${hints.left} of ${hints.max} hint${hints.max === 1 ? "" : "s"} left this round.`;
    UI.open(el.hintModal);
  }

  let hintBusy = false;
  async function takeHint(kind) {
    if (hintBusy || !hints) return;
    hintBusy = true;
    const res = await LAN.requestHint(kind);
    hintBusy = false;
    UI.close(el.hintModal);
    if (!res || !Array.isArray(res.letters)) {
      return UI.toast((res && res.error) || "No response — try again", 2400);
    }
    if (phase !== "match") return;
    const shown = res.letters.map((ch) => String(ch).toUpperCase()).join(", ");
    setHints({
      left: res.left,
      max: hints ? hints.max : res.left,
      absent: res.kind === "remove" ? res.letters : [],
      present: res.kind === "yellow" ? res.letters : [],
    });
    UI.haptic(15);
    UI.toast(
      res.kind === "yellow"
        ? `Hint: the word has the letter ${shown} (−1 point)`
        : `Hint: no ${shown} in the word (−1 point)`,
      3200,
    );
  }

  /* ---------- Connection problems ---------- */

  function setHostAway(on) {
    $("#netBanner").classList.toggle("hidden", !on);
  }

  function onConnection(kind) {
    if (!active) return;
    if (kind === "hostGone") {
      leaveRoom();
      UI.toast("The host closed the room", 2600);
      return;
    }
    if (kind === "hostAway") return setHostAway(true);
    if (kind === "hostBack") return setHostAway(false);
    setHostAway(false);
    $("#reconnectText").textContent = "Trying to reconnect…";
    $("#btnReconnect").classList.add("hidden");
    UI.open(el.reconnectModal);
    tryRejoin(0, false);
  }

  function tryRejoin(attempt, manual) {
    clearTimeout(retryHandle);
    if (!active) return;
    $("#reconnectText").textContent =
      attempt < 3
        ? "Trying to reconnect…"
        : "Still trying… If the host has left, the next player takes over. Your points are kept.";
    $("#btnReconnect").classList.add("hidden");
    retryHandle = setTimeout(
      () => {
        LAN.rejoin()
          .then((res) => {
            setHostAway(false);
            UI.close(el.reconnectModal);
            if (res && res.host) {
              UI.toast(
                phase === "match"
                  ? "You are now the host. The round restarts with a new word."
                  : "You are now the host",
                3600,
              );
              if (phase === "lobby") renderLobby(true);
              if (phase === "match") setStatus("New host. The round restarts in a moment…");
            } else UI.toast("Reconnected");
          })
          .catch((err) => {
            if (!active) return;
            if (!manual && attempt + 1 < RETRY_DELAYS.length) return tryRejoin(attempt + 1, false);
            const why = err && /not found/i.test(err.message) ? "The room is no longer open." : "";
            $("#reconnectText").textContent = `Could not reconnect. ${why}`.trim();
            $("#btnReconnect").classList.remove("hidden");
          });
      },
      manual ? 0 : RETRY_DELAYS[attempt],
    );
  }

  return { init, isActive, openStart, openJoinForm, confirmLeave, leaveRoom, onLocalFinish };
})();
