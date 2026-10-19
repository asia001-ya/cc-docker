/** Synthetic HTTP/SOCKS/DNS endpoints used only on disposable internal Docker networks. */
import http from "node:http";
import net from "node:net";
import dgram from "node:dgram";

const targets = [];
http.createServer((request, response) => {
  if (request.url === "/generate_204") { response.writeHead(204); response.end(); return; }
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(request.url === "/targets" ? targets : {
    viaProxy: request.socket.remoteAddress === "127.0.0.1",
    local: request.socket.localAddress,
  }));
}).listen(18080, "0.0.0.0");

net.createServer((socket) => {
  socket.on("error", () => {});
  let pending = Buffer.alloc(0), greeted = false;
  const receive = (data) => {
    pending = Buffer.concat([pending, data]);
    if (!greeted) {
      if (pending.length < 2 || pending.length < 2 + pending[1]) return;
      if (pending[0] !== 5) return socket.destroy();
      pending = pending.subarray(2 + pending[1]);
      greeted = true;
      socket.write(Buffer.from([5, 0]));
    }
    if (pending.length < 5) return;
    const kind = pending[3];
    const length = kind === 1 ? 10 : kind === 3 ? 7 + pending[4] : kind === 4 ? 22 : 0;
    if (!length) return socket.destroy();
    if (pending.length < length) return;
    const host = kind === 3 ? pending.subarray(5, length - 2).toString() : kind === 1 ? [...pending.subarray(4, 8)].join(".") : "ipv6";
    const port = pending.readUInt16BE(length - 2);
    targets.push({ host, port });
    socket.removeListener("data", receive);
    if (host !== "probe.tdc.test" || port !== 18080) {
      socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
      return;
    }
    const remaining = pending.subarray(length);
    const upstream = net.createConnection({ host: "127.0.0.1", port: 18080 }, () => {
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      if (remaining.length) upstream.write(remaining);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  };
  socket.on("data", receive);
}).listen(1080, "0.0.0.0");

net.createServer((socket) => { socket.on("error", () => {}); socket.end("dns-test"); }).listen(53, "0.0.0.0");
const udp = dgram.createSocket("udp4");
udp.on("message", (data, peer) => udp.send(data, peer.port, peer.address));
udp.bind(53, "0.0.0.0");
