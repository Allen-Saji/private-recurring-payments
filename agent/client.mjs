import net from "node:net";
import { readFile } from "node:fs/promises";

// No wallet or approval key access. The only credential is an execution capability.
export async function request(socketPath, tokenFile, action) {
  const token = (await readFile(tokenFile, "utf8")).trim();
  const payload = Buffer.from(JSON.stringify({ token, action }));
  if (payload.length > 32768) throw new Error("Request exceeds 32 KiB");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let received = Buffer.alloc(0);
    socket.setTimeout(180000, () =>
      socket.destroy(
        new Error("Signer response timed out; retry the same invoice."),
      ),
    );
    socket.on("connect", () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(payload.length);
      socket.write(Buffer.concat([header, payload]));
    });
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > 65540) {
        socket.destroy(new Error("Response exceeds limit"));
        return;
      }
      if (received.length >= 4) {
        const size = received.readUInt32BE();
        if (size > 65536) {
          socket.destroy(new Error("Response exceeds limit"));
          return;
        }
        if (received.length >= size + 4) {
          try {
            resolve(JSON.parse(received.subarray(4, size + 4).toString()));
          } catch (error) {
            reject(error);
          }
          socket.end();
        }
      }
    });
    socket.on("end", () => {
      if (received.length < 4 || received.length < received.readUInt32BE() + 4)
        reject(
          new Error(
            "Signer closed without a complete response; payment outcome may be unknown.",
          ),
        );
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  const [socket, tokenFile, op, arg] = process.argv.slice(2);
  if (!socket || !tokenFile || !["submit", "status"].includes(op) || !arg)
    throw new Error(
      "Usage: node client.mjs SOCKET TOKEN_FILE submit INVOICE_FILE | status PAYMENT_ID",
    );
  const action =
    op === "submit"
      ? { op, invoice: JSON.parse(await readFile(arg, "utf8")) }
      : { op, payment_id: arg };
  const result = await request(socket, tokenFile, action);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
