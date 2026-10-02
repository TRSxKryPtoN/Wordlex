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
    [90, "90 seconds"],
    [120, "2 minutes"],
    [180, "3 minutes"],
    [300, "5 minutes"],
  ];
  const RETRY_DELAYS = [800, 2500, 5000];

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
    el.lobbyModal.addEventListener("modal:back", confirmLeave);
    $("#btnShareInvite").onclick = shareInvite;
    $("#btnLobbyStart").onclick = () => {
      if (LAN.getRole() === "host") LAN.startMatch();
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
      host ? "The room closes for everyone." : "You can rejoin with the Room ID and password.",
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
    LAN.reset();
    active = false;
    phase = "none";
    state = null;
    Object.keys(el).forEach((k) => UI.close(el[k]));
    Game.stopTimer();
    Game.forceEnd();
    setStatus("");
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
    const host = LAN.getRole() === "host";
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
                      host && !p.isHost
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

  function pushConfig() {
    LAN.setConfig({
      rounds: parseInt($("#cfgRounds").value, 10),
      timer: parseInt($("#cfgTimer").value, 10),
    });
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

  /* ---------- Callbacks from LAN ---------- */

  function onState(s) {
    if (!active && LAN.getRole()) active = true;
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
    if (UI.isOpen(el.scoresModal)) renderScores();
  }

  function showMatchView() {
    phase = "match";
    document.body.dataset.view = "lan";
    document.body.classList.add("in-match");
    UI.close(el.chatModal);
    UI.close(el.lobbyModal);
    UI.close(el.resultModal);
    UI.close(el.roundModal);
    UI.close(el.reconnectModal);
  }

  function onRound(msg) {
    clearInterval(countdownHandle);
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
    if (msg.spectating) setStatus("Match in progress — you'll play from the next round.");
    else if (msg.done) setStatus("Waiting for the other players…");
    else setStatus("");
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
    if (p.won) {
      setStatus("Solved! Waiting for the other players…");
      FX.confetti(40);
    } else if (p.reason === "time") setStatus("Time's up!");
    else setStatus("Out of guesses. Waiting for the other players…");
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

  function leaderboardHTML(s, opts) {
    opts = opts || {};
    const myId = LAN.getMyId();
    const rows = ['<div class="lb-section">Teams</div>'];
    s.teamScores.forEach((t, rank) => {
      rows.push(`<div class="lb-row rank-${rank + 1}">
        <span class="lb-rank">${rank + 1}</span>
        <span class="lb-name"><span class="swatch" style="background:${color(t.color)}"></span><b>${esc(t.name)}</b>
          <span class="muted">· ${t.members} player${t.members === 1 ? "" : "s"}</span></span>
        <span class="pts">${t.score}</span>
      </div>`);
    });
    rows.push('<div class="lb-section">Players</div>');
    [...s.players].sort(Rules.comparePlayers).forEach((p, rank) => {
      const team = s.teams ? s.teams[p.team] : state && state.teams[p.team];
      const extra = opts.gained
        ? p.gained > 0
          ? `<span class="tag ok">+${p.gained}</span>`
          : '<span class="tag">+0</span>'
        : statusTag(p);
      rows.push(`<div class="lb-row rank-${rank + 1}${p.id === myId ? " me" : ""}">
          <span class="lb-rank">${rank + 1}</span>
          <span class="lb-name"><span class="swatch" style="background:${color(team && team.color)}"></span>${esc(p.name)} ${extra}</span>
          <span class="pts">${p.score}</span>
        </div>`);
    });
    return rows.join("");
  }

  function renderScores() {
    if (!state) return;
    const host = LAN.getRole() === "host";
    $("#leaderboard").innerHTML = leaderboardHTML(state);
    $("#btnEndRound").classList.toggle("hidden", !host);
    $("#btnRestartMatch").classList.toggle("hidden", !host);
    $("#btnLeaveMatch").textContent = host ? "Close room" : "Leave match";
  }

  function onRoundEnd(p) {
    Game.forceEnd();
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
    Game.forceEnd();
    setStatus("");
    document.body.classList.remove("in-match");
    UI.close(el.roundModal);
    UI.close(el.scoresModal);

    const host = LAN.getRole() === "host";
    const teamsList = p.teamScores || [];
    const players = [...(p.players || [])].sort(Rules.comparePlayers);
    const topScore = teamsList.length ? teamsList[0].score : 0;
    const tied = teamsList.filter((t) => t.score === topScore);
    const isDraw = tied.length > 1;
    const badge = (t) =>
      `<span class="badge"><span class="swatch" style="background:${color(t.color)}"></span>${esc(t.name)}</span>`;

    const aw = p.awards || { best: null, teams: {} };
    const byId = (id) => players.find((x) => x.id === id) || null;
    const best = byId(aw.best);
    const mvpOf = (teamId) => byId((aw.teams || {})[teamId]);

    const card = el.resultModal.querySelector(".modal-card");
    card.classList.add("wide");
    const stats = $("#resultStats");
    stats.className = "lan-results";

    $("#resultTitle").textContent = isDraw ? "It's a draw" : "Match over";
    if (!teamsList.length) $("#resultWord").textContent = "";
    else if (isDraw)
      $("#resultWord").innerHTML =
        `<div class="win-team">${tied.map(badge).join(" ")} tied on ${topScore} pts</div>`;
    else
      $("#resultWord").innerHTML =
        `<div class="win-team">Winner ${badge(teamsList[0])} with ${topScore} pts</div>`;

    stats.innerHTML =
      podiumHTML(players, p) +
      restListHTML(players.slice(3)) +
      (best
        ? `<div class="award"><span class="award-label">Best player</span>
            <span class="award-name"><span class="swatch" style="background:${color((teamOf(best, p) || {}).color)}"></span>${esc(best.name)}</span>
            <span class="award-pts">${best.score} pts · ${best.roundsWon} solved</span></div>`
        : "") +
      `<h3>Teams</h3><div class="team-summary">${teamsList
        .map(
          (t, i) => `<div class="lb-row rank-${i + 1}">
            <span class="lb-rank">${i + 1}</span>
            <span class="lb-name"><span class="swatch" style="background:${color(t.color)}"></span><b>${esc(t.name)}</b>
              <span class="muted">· ${t.members}</span>
              ${mvpOf(t.id) ? `<span class="tag ok">MVP ${esc(mvpOf(t.id).name)}</span>` : ""}</span>
            <span class="pts">${t.score}</span></div>`,
        )
        .join("")}</div>`;

    const again = $("#btnPlayAgain");
    again.classList.toggle("hidden", !host);
    again.textContent = "Play again";
    again.onclick = () => LAN.startMatch();
    $("#btnBackLobby").classList.remove("hidden");
    $("#btnShare").classList.add("hidden");
    $("#btnResultChat").classList.remove("hidden");
    $("#resultHint").textContent = host
      ? "Play again with the same teams, or go back to the lobby to change them."
      : "Waiting for the host to start the next match.";

    UI.open(el.resultModal);
    FX.confetti(90);
  }

  function teamOf(p, payload) {
    const list = (state && state.teams) || [];
    if (list[p.team]) return list[p.team];
    const t = (payload.teamScores || []).find((x) => x.id === p.team);
    return t || null;
  }

  function podiumHTML(players, payload) {
    const top = players.slice(0, 3);
    if (!top.length) return "";
    const order = [1, 0, 2]; // visual order: 2nd, 1st, 3rd
    const klass = ["silver", "gold", "bronze"];
    const rankNums = [2, 1, 3];
    const cells = order
      .map((idx, col) => {
        const p = top[idx];
        if (!p) return `<div class="podium-spot ${klass[col]} empty"></div>`;
        const team = teamOf(p, payload);
        const c = color(team && team.color);
        const initial = esc((p.name || "?").trim().charAt(0).toUpperCase() || "?");
        return `<div class="podium-spot ${klass[col]}">
          <div class="podium-head">
            <div class="podium-avatar" style="background:${c}">${initial}</div>
            <div class="podium-name">${esc(p.name)}</div>
            <div class="podium-score">${p.score} pts</div>
          </div>
          <div class="podium-pedestal">
            <div class="podium-badge" style="background:${c}">${team ? esc(team.name) : "—"}</div>
            <div class="podium-rank">${rankNums[col]}</div>
          </div>
        </div>`;
      })
      .join("");
    return `<div class="podium-wrap"><div class="podium">${cells}</div></div>`;
  }

  function restListHTML(rest) {
    if (!rest.length) return "";
    const myId = LAN.getMyId();
    return (
      '<div class="rest-list">' +
      rest
        .map((p, i) => {
          const team = state && state.teams[p.team];
          return `<div class="lb-row${p.id === myId ? " me" : ""}">
            <span class="lb-rank">${i + 4}</span>
            <span class="lb-name"><span class="swatch" style="background:${color(team && team.color)}"></span>${esc(p.name)}</span>
            <span class="pts">${p.score}</span></div>`;
        })
        .join("") +
      "</div>"
    );
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
    while (log.children.length > CHAT_DOM_MAX) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
    // Chat closed: count it on the Chat buttons and show a short preview.
    if (!UI.isOpen(el.chatModal) && m.id !== LAN.getMyId()) {
      setUnread(unread + 1);
      const text = String(m.text);
      UI.toast(`${m.name}: ${text.length > 60 ? text.slice(0, 60) + "…" : text}`, 2600);
    }
  }

  function setUnread(n) {
    unread = n;
    document.querySelectorAll("[data-chat-badge]").forEach((b) => {
      b.textContent = n > 9 ? "9+" : String(n);
      b.classList.toggle("hidden", n === 0);
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

  /* ---------- Connection problems ---------- */

  function onConnection(kind) {
    if (!active) return;
    if (kind === "hostGone") {
      leaveRoom();
      UI.toast("The host closed the room", 2600);
      return;
    }
    $("#reconnectText").textContent = "Trying to reconnect…";
    $("#btnReconnect").classList.add("hidden");
    UI.open(el.reconnectModal);
    tryRejoin(0, false);
  }

  function tryRejoin(attempt, manual) {
    clearTimeout(retryHandle);
    if (!active) return;
    $("#reconnectText").textContent = "Trying to reconnect…";
    $("#btnReconnect").classList.add("hidden");
    retryHandle = setTimeout(
      () => {
        LAN.rejoin()
          .then(() => {
            UI.close(el.reconnectModal);
            UI.toast("Reconnected");
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
