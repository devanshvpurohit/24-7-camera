// Single relay for the device.
//
// POST      (from ESP32): application/json -> status, anything else -> JPEG frame
// GET      ?json         (from dashboard): last status
// GET                   (from dashboard): live multipart/x-mixed-replace stream
//
// One file on purpose: Vercel bundles each function separately, so the
// status buffer and the frame buffer must live in the same function to
// share one memory space.
//
// ponytail: state lives in this instance's memory. Ceiling: a cold start or
// a second instance wipes it, and the ESP32's continuous POSTs keep the
// instance warm so it holds in practice. Vercel Blob / KV if it must survive
// scale-out.

const BOUNDARY = "frame";

let last = { status: null, frame: null, seenAt: null, seq: 0 };

export const config = { maxDuration: 60 };

// Multipart part for one JPEG. The browser decodes a
// multipart/x-mixed-replace <img> natively, so no player library.
function part(buf) {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`
    ),
    buf,
    Buffer.from("\r\n"),
  ]);
}

export default function handler(req, res) {
  if (req.method === "POST") {
    res.setHeader("Access-Control-Allow-Origin", "*");

    const type = req.headers["content-type"] || "";

    if (type.startsWith("application/json")) {
      // Vercel usually hands over a parsed object, but not always - a
      // string here would leave every dashboard card reading undefined.
      last.status =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } else {
      const buf = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(String(req.body ?? ""), "binary");

      if (buf.length) last.frame = buf;
    }

    // seq, not a timestamp: Date has ms resolution and two pushes in the
    // same ms would repeat an ETag, stranding a viewer on a cached frame.
    last.seq += 1;
    last.seenAt = new Date().toISOString();
    return res.status(200).json({ ok: true, seq: last.seq });
  }

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "GET or POST only" });
  }

  // ---- live stream -------------------------------------------------------
  if (!req.query?.json) {
    res.setHeader("Content-Type", `multipart/x-mixed-replace; boundary=${BOUNDARY}`);
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Connection", "close");
    // Stops nginx and friends from buffering the whole thing.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let sent = -1;
    res.write(`--${BOUNDARY}\r\n\r\n`);

    // ponytail: 50ms tick, so frames appear as the device lands them.
    // Ceiling: the stream is cut at maxDuration and the viewer reconnects.
    // A persistent upstream connection (device POSTs a chunked multipart
    // body that we pipe straight through) is the next step up, and needs
    // a plan that allows request streaming.
    const tick = setInterval(() => {
      if (last.seq !== sent && last.frame) {
        sent = last.seq;
        res.write(part(last.frame));
      }
    }, 50);

    // The client going away, or the platform ending the function, must
    // clear the timer or this holds the instance open.
    const stop = () => clearInterval(tick);
    req.on("close", stop);
    res.on("close", stop);
    res.on("finish", stop);
    return;
  }

  // ---- status JSON -------------------------------------------------------
  const tag = `"${last.seq}"`;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("ETag", tag);
  res.setHeader("Cache-Control", "no-cache");

  if (req.headers["if-none-match"] === tag) {
    return res.status(304).end();
  }

  return res.status(200).json({ status: last.status, seenAt: last.seenAt });
}
