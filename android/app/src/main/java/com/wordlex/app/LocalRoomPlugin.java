// Wordlex "LocalRoom" plugin (Android).
//
// Runs a small WebSocket server on the HOST phone so friends on the same Wi-Fi
// or hotspot can play with no internet. Guests need nothing native: they connect
// with a normal WebSocket from the game.
//
// Setup (see MOBILE.md):
//   1. Copy this file next to MainActivity.java and change the package line below
//      to match the first line of your MainActivity.java.
//   2. android/app/build.gradle -> dependencies:
//        implementation 'org.java-websocket:Java-WebSocket:1.5.6'
//   3. MainActivity.java:  registerPlugin(LocalRoomPlugin.class);  before super.onCreate(...)
package com.wordlex.app;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

@CapacitorPlugin(name = "LocalRoom")
public class LocalRoomPlugin extends Plugin {

    private WebSocketServer server;
    private final Map<String, WebSocket> clients = new ConcurrentHashMap<>();
    private final AtomicInteger nextId = new AtomicInteger(1);

    /** start({ port }) -> { ip, port }. ip is "" when the phone is on no Wi-Fi / hotspot. */
    @PluginMethod
    public void start(final PluginCall call) {
        final int port = call.getInt("port", 47800);
        stopServer();

        final AtomicBoolean answered = new AtomicBoolean(false);

        server = new WebSocketServer(new InetSocketAddress(port)) {
            @Override
            public void onStart() {
                if (answered.compareAndSet(false, true)) {
                    JSObject ret = new JSObject();
                    ret.put("ip", localIp());
                    ret.put("port", port);
                    call.resolve(ret);
                }
            }

            @Override
            public void onOpen(WebSocket conn, ClientHandshake handshake) {
                String id = "c" + nextId.getAndIncrement();
                conn.setAttachment(id);
                clients.put(id, conn);
                JSObject data = new JSObject();
                data.put("id", id);
                notifyListeners("clientConnected", data);
            }

            @Override
            public void onMessage(WebSocket conn, String message) {
                String id = conn.getAttachment();
                if (id == null) return;
                JSObject data = new JSObject();
                data.put("id", id);
                data.put("data", message);
                notifyListeners("clientMessage", data);
            }

            @Override
            public void onClose(WebSocket conn, int code, String reason, boolean remote) {
                String id = conn.getAttachment();
                if (id == null || clients.remove(id) == null) return;
                JSObject data = new JSObject();
                data.put("id", id);
                notifyListeners("clientDisconnected", data);
            }

            @Override
            public void onError(WebSocket conn, Exception ex) {
                // conn == null means the server itself failed (for example the port is busy).
                if (conn == null && answered.compareAndSet(false, true)) {
                    call.reject("Could not start the local room: " + ex.getMessage());
                }
            }
        };
        server.setReuseAddr(true);
        server.setConnectionLostTimeout(20); // drop players whose phone vanished
        server.start();
    }

    /** send({ id, data }) */
    @PluginMethod
    public void send(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        WebSocket conn = id == null ? null : clients.get(id);
        if (conn != null && conn.isOpen() && data != null) {
            try {
                conn.send(data);
            } catch (Exception ignored) {
                // the connection is closing; onClose will report it
            }
        }
        call.resolve();
    }

    /** disconnect({ id }) */
    @PluginMethod
    public void disconnect(PluginCall call) {
        String id = call.getString("id");
        WebSocket conn = id == null ? null : clients.get(id);
        if (conn != null) conn.close();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopServer();
        call.resolve();
    }

    /**
     * findHosts({ port, timeout }) -> { ip, hosts: [..] }
     * Lists the addresses on this phone's network (x.x.x.1 - x.x.x.254) that have the
     * game's port open, so guests can find rooms without typing an address.
     * ip is "" when the phone is on no Wi-Fi / hotspot.
     */
    @PluginMethod
    public void findHosts(final PluginCall call) {
        final int port = call.getInt("port", 47800);
        final int timeout = call.getInt("timeout", 400);
        final String mine = localIp();
        if (mine.isEmpty()) {
            JSObject ret = new JSObject();
            ret.put("ip", "");
            ret.put("hosts", new JSArray());
            call.resolve(ret);
            return;
        }
        new Thread(() -> {
            final String prefix = mine.substring(0, mine.lastIndexOf('.') + 1);
            ExecutorService pool = Executors.newFixedThreadPool(48);
            List<Future<String>> jobs = new ArrayList<>();
            for (int n = 1; n <= 254; n++) {
                final String ip = prefix + n;
                if (ip.equals(mine)) continue;
                jobs.add(pool.submit(() -> {
                    Socket socket = new Socket();
                    try {
                        socket.connect(new InetSocketAddress(ip, port), timeout);
                        return ip;
                    } catch (Exception e) {
                        return null;
                    } finally {
                        try {
                            socket.close();
                        } catch (Exception ignored) {
                            // nothing to do
                        }
                    }
                }));
            }
            JSArray hosts = new JSArray();
            for (Future<String> job : jobs) {
                try {
                    String ip = job.get();
                    if (ip != null) hosts.put(ip);
                } catch (Exception ignored) {
                    // that address did not answer
                }
            }
            pool.shutdown();
            JSObject ret = new JSObject();
            ret.put("ip", mine);
            ret.put("hosts", hosts);
            call.resolve(ret);
        }).start();
    }

    @PluginMethod
    public void getLocalIp(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ip", localIp());
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        stopServer();
    }

    private void stopServer() {
        final WebSocketServer old = server;
        server = null;
        clients.clear();
        if (old == null) return;
        new Thread(() -> {
            try {
                old.stop(500);
            } catch (Exception ignored) {
                // already stopped
            }
        }).start();
    }

    /** This phone's address on Wi-Fi or on its own hotspot. Never the mobile-data address. */
    private String localIp() {
        String fallback = "";
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                String name = nif.getName().toLowerCase();
                if (name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("pdp")
                        || name.startsWith("tun") || name.startsWith("dummy")) continue; // mobile data / VPN
                boolean wifiLike = name.startsWith("wlan") || name.startsWith("swlan")
                        || name.startsWith("ap") || name.startsWith("softap") || name.startsWith("wl");
                for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
                    if (!(addr instanceof Inet4Address) || !addr.isSiteLocalAddress()) continue;
                    if (wifiLike) return addr.getHostAddress();
                    if (fallback.isEmpty()) fallback = addr.getHostAddress();
                }
            }
        } catch (Exception ignored) {
            // fall through
        }
        return fallback;
    }
}
