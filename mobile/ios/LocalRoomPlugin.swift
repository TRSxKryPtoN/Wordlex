// Wordlex "LocalRoom" plugin (iOS).
//
// Runs a small WebSocket server on the HOST iPhone so friends on the same Wi-Fi
// or hotspot can play with no internet. Uses Apple's Network framework, so no
// extra library is needed. Requires iOS 13+ and Capacitor 6 or newer.
//
// Setup (see MOBILE.md):
//   1. In Xcode, drag this file and AppViewController.swift into the "App" group
//      (tick "Copy items if needed", target: App).
//   2. Main.storyboard -> Bridge View Controller -> Identity inspector ->
//      Class: AppViewController, Module: App.
//   3. Info.plist: add NSLocalNetworkUsageDescription and
//      NSAppTransportSecurity > NSAllowsLocalNetworking = YES.

import Capacitor
import Foundation
import Network

@objc(LocalRoomPlugin)
public class LocalRoomPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalRoomPlugin"
    public let jsName = "LocalRoom"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocalIp", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "findHosts", returnType: CAPPluginReturnPromise)
    ]

    private let queue = DispatchQueue(label: "wordlex.localroom")
    private var listener: NWListener?
    private var clients: [String: NWConnection] = [:]
    private var nextId = 1

    /// start({ port }) -> { ip, port }. ip is "" when the phone is on no Wi-Fi / hotspot.
    @objc func start(_ call: CAPPluginCall) {
        let portNumber = UInt16(call.getInt("port") ?? 47800)
        queue.async {
            self.stopServer()

            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            let ws = NWProtocolWebSocket.Options()
            ws.autoReplyPing = true
            params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)

            guard let port = NWEndpoint.Port(rawValue: portNumber),
                  let newListener = try? NWListener(using: params, on: port) else {
                call.reject("Could not start the local room")
                return
            }

            var answered = false
            newListener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if !answered {
                        answered = true
                        call.resolve(["ip": LocalRoomPlugin.localIp(), "port": Int(portNumber)])
                    }
                case .failed(let error):
                    if !answered {
                        answered = true
                        call.reject("Could not start the local room: \(error.localizedDescription)")
                    }
                default:
                    break
                }
            }
            newListener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            self.listener = newListener
            newListener.start(queue: self.queue)
        }
    }

    private func accept(_ connection: NWConnection) {
        let id = "c\(nextId)"
        nextId += 1
        connection.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                self.clients[id] = connection
                self.notifyListeners("clientConnected", data: ["id": id])
                self.receive(id, connection)
            case .failed, .cancelled:
                self.drop(id)
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    private func receive(_ id: String, _ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self = self else { return }
            if let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                as? NWProtocolWebSocket.Metadata {
                switch meta.opcode {
                case .text:
                    if let data = data, let text = String(data: data, encoding: .utf8) {
                        self.notifyListeners("clientMessage", data: ["id": id, "data": text])
                    }
                case .close:
                    connection.cancel()
                    return
                default:
                    break
                }
            }
            if error != nil {
                connection.cancel()
                return
            }
            self.receive(id, connection)
        }
    }

    private func drop(_ id: String) {
        if clients.removeValue(forKey: id) != nil {
            notifyListeners("clientDisconnected", data: ["id": id])
        }
    }

    /// send({ id, data })
    @objc func send(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        let text = call.getString("data") ?? ""
        queue.async {
            if let connection = self.clients[id] {
                let meta = NWProtocolWebSocket.Metadata(opcode: .text)
                let context = NWConnection.ContentContext(identifier: "text", metadata: [meta])
                connection.send(content: text.data(using: .utf8), contentContext: context,
                                isComplete: true, completion: .contentProcessed { _ in })
            }
            call.resolve()
        }
    }

    /// disconnect({ id })
    @objc func disconnect(_ call: CAPPluginCall) {
        let id = call.getString("id") ?? ""
        queue.async {
            self.clients[id]?.cancel()
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        queue.async {
            self.stopServer()
            call.resolve()
        }
    }

    @objc func getLocalIp(_ call: CAPPluginCall) {
        call.resolve(["ip": LocalRoomPlugin.localIp()])
    }

    /// findHosts({ port, timeout }) -> { ip, hosts: [..] }
    /// Lists the addresses on this phone's network that have the game's port open.
    @objc func findHosts(_ call: CAPPluginCall) {
        let portNumber = UInt16(call.getInt("port") ?? 47800)
        let timeoutMs = call.getInt("timeout") ?? 400
        let mine = LocalRoomPlugin.localIp()
        guard !mine.isEmpty, let dot = mine.lastIndex(of: "."),
              let port = NWEndpoint.Port(rawValue: portNumber) else {
            call.resolve(["ip": "", "hosts": []])
            return
        }
        let prefix = String(mine[...dot])
        let scanQueue = DispatchQueue(label: "wordlex.localroom.scan")
        let group = DispatchGroup()
        var hosts: [String] = []

        for n in 1...254 {
            let ip = "\(prefix)\(n)"
            if ip == mine { continue }
            group.enter()
            let connection = NWConnection(host: NWEndpoint.Host(ip), port: port, using: .tcp)
            var finished = false
            let finish: (Bool) -> Void = { open in
                if finished { return }
                finished = true
                if open { hosts.append(ip) }
                connection.cancel()
                group.leave()
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: finish(true)
                case .failed: finish(false)
                default: break
                }
            }
            connection.start(queue: scanQueue)
            scanQueue.asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) { finish(false) }
        }
        group.notify(queue: scanQueue) {
            call.resolve(["ip": mine, "hosts": hosts])
        }
    }

    private func stopServer() {
        listener?.cancel()
        listener = nil
        let old = clients
        clients.removeAll()
        old.values.forEach { $0.cancel() }
    }

    /// This phone's IPv4 address on its own hotspot (bridge*) or on Wi-Fi (en0).
    static func localIp() -> String {
        var hotspot = ""
        var wifi = ""
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else { return "" }
        defer { freeifaddrs(list) }
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let item = cursor {
            let ifa = item.pointee
            cursor = ifa.ifa_next
            guard let addr = ifa.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: ifa.ifa_name)
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count),
                           nil, 0, NI_NUMERICHOST) != 0 { continue }
            let ip = String(cString: host)
            if name.hasPrefix("bridge") { hotspot = ip } else if name == "en0" { wifi = ip }
        }
        return hotspot.isEmpty ? wifi : hotspot
    }
}
