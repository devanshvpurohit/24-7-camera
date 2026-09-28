// Heartbeat. Firmware GETs this every 30s; it only needs a 200 so the
// dashboard card goes green and Serial prints something useful.
//
// ponytail: no storage, no auth. Serverless memory dies between
// invocations, so "last seen" needs Vercel KV (or a real DB) if you
// ever want history across instances.
export default function handler(req, res) {
  res.status(200).json({ ok: true, at: new Date().toISOString() });
}
