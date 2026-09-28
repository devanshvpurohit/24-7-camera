// JPEG ingest. Firmware POSTs a frame every 3s with Content-Type: image/jpeg.
//
// ponytail: acks and discards. Nothing is persisted - serverless has no
// writable disk and a memory Map dies on cold start. Wire up Vercel Blob
// (or S3/R2) here when you actually want to keep the frames.
export default function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  const len = Number(req.headers["content-length"] || 0);

  // Vercel caps the request body at 4.5 MB.
  if (len > 4_500_000) {
    return res.status(413).json({ error: "frame too large", bytes: len });
  }

  res.status(200).json({ ok: true, bytes: len, at: new Date().toISOString() });
}
