// Single relay for the device.
//
// POST  (from ESP32): application/json -> status, anything else -> JPEG frame
// GET   (from dashboard): last status + last frame
//
// One file on purpose: Vercel bundles each function separately, so status
// and frame must live in the same function to share one memory space.
//
// ponytail: state lives in this instance's memory. Ceiling: a cold start or
// a second instance wipes it, and the ESP32's 3s POST keeps the instance warm
// so it holds in practice. Vercel Blob / KV if you need it to survive scale-out.

let last = { status: null, frame: null, seenAt: null, seq: 0 };

export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "POST") {
    const type = req.headers["content-type"] || "";

    if (type.startsWith("application/json")) {
      last.status = req.body;
    } else {
      const buf = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(String(req.body ?? ""), "binary");

      if (buf.length) last.frame = buf.toString("base64");
    }

    // seq, not the timestamp: Date has millisecond resolution and two
    // pushes inside the same ms would repeat an ETag, leaving the
    // dashboard stuck on a cached frame.
    last.seq += 1;
    last.seenAt = new Date().toISOString();
    return res.status(200).json({ ok: true });
  }

  if (req.method === "GET") {
    // ETag on seq: the dashboard polls far faster than the camera
    // pushes, so most polls are "nothing new" and must not re-send
    // the same ~60KB frame. 304 here is what makes the stream cheap.
    const tag = `"${last.seq}"`;

    res.setHeader("ETag", tag);
    res.setHeader("Cache-Control", "no-cache");

    if (req.headers["if-none-match"] === tag) {
      return res.status(304).end();
    }

    return res.status(200).json({
      status: last.status,
      seenAt: last.seenAt,
      frame: last.frame ? `data:image/jpeg;base64,${last.frame}` : null,
    });
  }

  res.setHeader("Allow", "GET, POST");
  res.status(405).json({ error: "GET or POST only" });
}
