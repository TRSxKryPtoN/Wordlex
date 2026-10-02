/* =========================================================
   localnet.js — multiplayer with NO internet.

   Everyone joins the same Wi-Fi or phone hotspot. The host's
   phone runs a small WebSocket server (the native "LocalRoom"
   plugin in the Android / iOS app) and guests connect straight
   to its local address.

   The two classes below imitate the small part of PeerJS that
   lan.js uses, so the match logic is identical in both modes:
     HostPeer  : events "open"(roomCode) "connection"(conn) "error"
     GuestPeer : events "open" "error";  connect(roomCode) -> conn
     conn      : .open  .send(text)  .close()
                 events "open" "data"(text) "close" "error"

   The host chooses any Room ID. Guests find the room by scanning
   their own network (see scan below), so nobody types an address.
   ========================================================= */
window.LocalNet = (function () {
  const PORT = 47800;
  const CONNECT_TIMEOUT_MS = 6000;

  function plugin() {
    const cap = window.Capacitor;
    return (cap && cap.Plugins && cap.Plugins.LocalRoom) || null;
  }

  /** True inside the native app, where the host can run a local server. */
  function available() {
    return !!plugin();
  }

  /* ---------- Finding rooms on the network ----------
     Step 1 finds the addresses on this phone's network that have the game's port
     open. Step 2 asks each of those "who is there?" and a phone hosting a Wordlex
     room answers with its Room ID. No internet and no extra permissions needed. */

  const PROBE_TIMEOUT_MS = 2500;
  const KNOCK_TIMEOUT_MS = 900;
  const BATCH = 40;

  /** This phone's own Wi-Fi / hotspot address, or "" when it is on no network. */
  function myIp() {
    const native = plugin();
    if (!native || !native.getLocalIp) return Promise.resolve("");
    return Promise.resolve(native.getLocalIp())
      .then((r) => String((r && r.ip) || ""))
      .catch(() => "");
  }

  /** Ask one address whether it hosts a room. Resolves to room info or null. */
  function probe(ip) {
    return new Promise((resolve) => {
      let ws;
      let settled = false;
      const finish = (room) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch (e) {
          /* ignore */
        }
        resolve(room);
      };
      const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
      try {
        ws = new WebSocket(`ws://${ip}:${PORT}`);
      } catch (e) {
        return finish(null);
      }
      ws.onopen = () => ws.send(JSON.stringify({ type: "who" }));
      ws.onmessage = (e) => {
        let m = null;
        try {
          m = JSON.parse(e.data);
        } catch (err) {
          /* not ours */
        }
        if (!m || m.type !== "room" || typeof m.roomId !== "string") return finish(null);
        finish({
          ip,
          roomId: m.roomId.slice(0, 16),
          hostName: String(m.hostName || "Host").slice(0, 16),
          players: Number(m.players) || 0,
          max: Number(m.max) || 0,
          inMatch: !!m.inMatch,
        });
      };
      ws.onerror = () => finish(null);
      ws.onclose = () => finish(null);
    });
  }

  let lastHostIp = "";

  /** Does anything answer on the game's port at this address? (plain HTTP, quick to fail) */
  function knock(ip) {
    return new Promise((resolve) => {
      const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = setTimeout(() => {
        if (ctl) ctl.abort();
        resolve(false);
      }, KNOCK_TIMEOUT_MS);
      fetch(`http://${ip}:${PORT}/`, {
        mode: "no-cors",
        cache: "no-store",
        signal: ctl && ctl.signal,
      })
        .then(() => true)
        .catch(() => false)
        .then((ok) => {
          clearTimeout(timer);
          resolve(ok);
        });
    });
  }

  /**
   * Addresses on this network with the game's port open.
   * Uses the app's native scanner when it has one (fast and reliable); otherwise
   * knocks on each address from JavaScript. WebSockets are not used for this step
   * because browsers deliberately slow down many failed WebSocket attempts.
   */
  async function listHosts(cancelled) {
    const native = plugin();
    if (native && native.findHosts) {
      try {
        const r = await native.findHosts({ port: PORT, timeout: 400 });
        if (!r || !r.ip) throw new Error("no-network");
        return Array.isArray(r.hosts) ? r.hosts.map(String) : [];
      } catch (e) {
        if (e && e.message === "no-network") throw e;
        /* older app build: fall through to the JavaScript scan */
      }
    }
    const mine = await myIp();
    const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})$/.exec(mine);
    if (!m) throw new Error("no-network");
    const prefix = m[1];
    const self = Number(m[2]);
    const all = [];
    for (let n = 1; n <= 254; n++) if (n !== self) all.push(`${prefix}.${n}`);
    const hosts = [];
    for (let i = 0; i < all.length; i += BATCH) {
      if (cancelled && cancelled()) break;
      const part = all.slice(i, i + BATCH);
      const res = await Promise.all(part.map(knock));
      res.forEach((ok, k) => ok && hosts.push(part[k]));
    }
    return hosts;
  }

  /**
   * Look for rooms on this network.
   * opts.onRoom(room)  called as each room is found
   * opts.cancelled()   return true to stop early
   * Resolves to the list of rooms. Rejects with "no-network" when not on Wi-Fi / hotspot.
   */
  async function scan(opts) {
    opts = opts || {};
    const hosts = await listHosts(opts.cancelled);
    // Likely hosts first: the last one we played with, then the hotspot phone (.1).
    hosts.sort((a, b) => rank(a) - rank(b));
    const rooms = [];
    for (const ip of hosts) {
      if (opts.cancelled && opts.cancelled()) break;
      const room = await probe(ip);
      if (!room) continue;
      rooms.push(room);
      if (opts.onRoom) opts.onRoom(room);
    }
    return rooms;
  }

  function rank(ip) {
    if (ip === lastHostIp) return 0;
    return /\.1$/.test(ip) ? 1 : 2;
  }

  /* ---------- Tiny event emitter ---------- */

  function emitter(obj) {
    const handlers = {};
    obj.on = function (name, fn) {
      (handlers[name] = handlers[name] || []).push(fn);
      return obj;
    };
    obj._emit = function (name, arg) {
      (handlers[name] || []).slice().forEach((fn) => {
        try {
          fn(arg);
        } catch (e) {
          console.error(e);
        }
      });
    };
    return obj;
  }

  /* ---------- Host: native WebSocket server ---------- */

  function HostPeer() {
    const self = emitter(this);
    const native = plugin();
    const conns = new Map(); // client id -> conn
    const subs = [];
    self.destroyed = false;
    self.id = null;

    function listen(name, fn) {
      // Capacitor returns either a handle or a promise of one.
      Promise.resolve(native.addListener(name, fn)).then((h) => {
        if (self.destroyed) h && h.remove && h.remove();
        else subs.push(h);
      });
    }

    function makeConn(id) {
      const c = emitter({ open: true });
      c.send = (text) => {
        if (c.open) native.send({ id, data: String(text) });
      };
      c.close = () => {
        if (!c.open) return;
        c.open = false;
        conns.delete(id);
        native.disconnect({ id });
        setTimeout(() => c._emit("close"), 0);
      };
      return c;
    }

    if (!native) {
      setTimeout(() => self._emit("error", { type: "unsupported" }), 0);
      return;
    }

    listen("clientConnected", (e) => {
      const c = makeConn(e.id);
      conns.set(e.id, c);
      self._emit("connection", c);
    });
    listen("clientMessage", (e) => {
      const c = conns.get(e.id);
      if (c && c.open) c._emit("data", e.data);
    });
    listen("clientDisconnected", (e) => {
      const c = conns.get(e.id);
      if (!c) return;
      conns.delete(e.id);
      if (c.open) {
        c.open = false;
        c._emit("close");
      }
    });

    Promise.resolve(native.start({ port: PORT }))
      .then((res) => {
        if (self.destroyed) return;
        const ip = String((res && res.ip) || "");
        if (!ip) {
          native.stop();
          return self._emit("error", { type: "no-network" });
        }
        self.id = ip;
        self._emit("open", ip);
      })
      .catch((err) => {
        if (!self.destroyed)
          self._emit("error", { type: "start-failed", message: String(err && err.message) });
      });

    self.reconnect = function () {};
    self.destroy = function () {
      if (self.destroyed) return;
      self.destroyed = true;
      subs.forEach((h) => h && h.remove && h.remove());
      conns.forEach((c) => (c.open = false));
      conns.clear();
      try {
        native.stop();
      } catch (e) {
        /* ignore */
      }
    };
  }

  /* ---------- Guest: plain WebSocket to the host ---------- */

  function GuestPeer() {
    const self = emitter(this);
    let ws = null;
    self.destroyed = false;
    setTimeout(() => self.destroyed || self._emit("open"), 0);

    // target: { roomId, address }. Without an address the room is looked up by its ID.
    self.connect = function (target) {
      const c = emitter({ open: false });
      const unavailable = (type) => setTimeout(() => self._emit("error", { type }), 0);
      if (target && target.address) {
        open(c, target.address);
      } else {
        scan({ cancelled: () => self.destroyed })
          .then((rooms) => {
            if (self.destroyed) return;
            const room = rooms.find((r) => r.roomId === target.roomId);
            if (room) open(c, room.ip);
            else unavailable("peer-unavailable");
          })
          .catch(() => unavailable("no-network"));
      }
      return c;
    };

    function open(c, ip) {
      c.address = ip;
      lastHostIp = ip;
      let opened = false;
      try {
        ws = new WebSocket(`ws://${ip}:${PORT}`);
      } catch (e) {
        setTimeout(() => self._emit("error", { type: "peer-unavailable" }), 0);
        return;
      }
      const sock = ws;
      const timer = setTimeout(() => {
        if (!opened) {
          try {
            sock.close();
          } catch (e) {
            /* ignore */
          }
          self._emit("error", { type: "peer-unavailable" });
        }
      }, CONNECT_TIMEOUT_MS);

      sock.onopen = () => {
        opened = true;
        clearTimeout(timer);
        c.open = true;
        c._emit("open");
      };
      sock.onmessage = (e) => {
        if (typeof e.data === "string") c._emit("data", e.data);
      };
      sock.onerror = () => {
        if (!opened) {
          clearTimeout(timer);
          self._emit("error", { type: "peer-unavailable" });
        }
      };
      sock.onclose = () => {
        clearTimeout(timer);
        if (c.open) {
          c.open = false;
          c._emit("close");
        }
      };
      c.send = (text) => {
        if (c.open && sock.readyState === 1) sock.send(String(text));
      };
      c.close = () => {
        try {
          sock.close();
        } catch (e) {
          /* ignore */
        }
      };
    }

    self.reconnect = function () {};
    self.destroy = function () {
      self.destroyed = true;
      try {
        if (ws) ws.close();
      } catch (e) {
        /* ignore */
      }
    };
  }

  return { PORT, available, myIp, scan, HostPeer, GuestPeer };
})();
