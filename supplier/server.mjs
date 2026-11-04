import net from "node:net";
import { readFile, chmod, lstat, rename, mkdir } from "node:fs/promises";
import { createHash, timingSafeEqual, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

const { SUPPLIER_SOCKET, SUPPLIER_TOKEN_FILE, SUPPLIER_STATE, PRP_BINARY } =
  process.env;
if (!SUPPLIER_SOCKET || !SUPPLIER_TOKEN_FILE || !SUPPLIER_STATE || !PRP_BINARY)
  throw new Error(
    "Supplier socket, token file, state and binary paths are required",
  );
const digest = (value) => createHash("sha256").update(value).digest();
const token = (await readFile(SUPPLIER_TOKEN_FILE, "utf8")).trim();
if (!/^[a-f0-9]{64}$/.test(token))
  throw new Error("Invalid supplier execution capability");
const expected = digest(token);
await mkdir(path.dirname(SUPPLIER_SOCKET), { recursive: true, mode: 0o700 });
try {
  const stat = await lstat(SUPPLIER_SOCKET);
  if (!stat.isSocket()) throw new Error("Refusing non-socket endpoint");
  await new Promise((resolve, reject) => {
    const probe = net.createConnection(SUPPLIER_SOCKET);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("Supplier already listening"));
    });
    probe.once("error", (error) =>
      error.code === "ECONNREFUSED" ? resolve() : reject(error),
    );
  });
  await rename(
    SUPPLIER_SOCKET,
    `${SUPPLIER_SOCKET}.stale-${randomBytes(8).toString("hex")}`,
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

let queue = Promise.resolve();
let pending = 0;
function execute(action) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      PRP_BINARY,
      ["--state-dir", SUPPLIER_STATE, "supplier", "rpc"],
      { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH } },
    );
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 150000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 65536) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 2000) stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0)
        return reject(
          new Error(
            "Supplier worker unavailable; verification remains pending",
          ),
        );
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Supplier response invalid"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(action));
  });
}
const server = net.createServer((socket) => {
  let buffer = Buffer.alloc(0),
    accepted = false;
  socket.setTimeout(5000, () => socket.destroy());
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    if (accepted) return socket.destroy();
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 32772) return socket.destroy();
    if (buffer.length < 4) return;
    const size = buffer.readUInt32BE();
    if (size > 32768) return socket.destroy();
    if (buffer.length < size + 4) return;
    if (buffer.length !== size + 4) return socket.destroy();
    let request;
    try {
      request = JSON.parse(buffer.subarray(4).toString());
      if (
        Object.keys(request).sort().join(",") !== "action,token" ||
        typeof request.token !== "string" ||
        !timingSafeEqual(digest(request.token), expected)
      )
        return socket.destroy();
    } catch {
      return socket.destroy();
    }
    accepted = true;
    buffer.fill(0);
    socket.setTimeout(180000);
    const send = (response) => {
      const body = Buffer.from(JSON.stringify(response));
      if (body.length > 65536) return socket.destroy();
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      socket.end(Buffer.concat([header, body]));
    };
    if (pending >= 4) return send({ ok: false, error: "Supplier busy; retry" });
    pending++;
    const work = queue.then(() => execute(request.action));
    queue = work.catch(() => {});
    work
      .then(send, () =>
        send({
          ok: false,
          error: "Supplier worker unavailable; verification remains pending",
        }),
      )
      .finally(() => pending--);
  });
});
server.listen(SUPPLIER_SOCKET, async () => {
  await chmod(SUPPLIER_SOCKET, 0o600);
  console.log("Supplier execution socket ready");
});
server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
