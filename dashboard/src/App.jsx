import { useState, useEffect } from "react";

// ponytail: 3s poll of our own /api/device relay, not the camera.
// The camera is behind NAT and has no inbound port. This only
// updates as fast as the ESP32 pushes (status 30s, frame 3s) -
// add SSE /events server-side if you want push instead of poll.
const POLL_MS = 3000;

const fmtUptime = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ` +
    `${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
};

// Status ages out at 45s: ESP32 pushes every 30s, so two missed
// pushes means it is gone.
const STALE_MS = 45000;

const CARDS = [
  ["wifi", "WiFi", (d) => d.wifi, (d) => d.wifi === "connected"],
  ["ip", "IP", (d) => d.ip || "-"],
  ["ssid", "SSID", (d) => d.ssid || "-"],
  ["rssi", "RSSI", (d) => `${d.rssi} dBm`, (d) => d.rssi > -70],
  ["camera", "Camera", (d) => (d.camera ? "ready" : "error"), (d) => d.camera],
  ["uptime", "Uptime", (d) => fmtUptime(d.uptime)],
  ["heap", "Free Heap", (d) => `${Math.round(d.heap / 1024)} KB`, (d) => d.heap > 40000],
  ["psram", "PSRAM", (d) => (d.psram > 0 ? `${Math.round(d.psram / 1024)} KB` : "none")],
  ["vercel", "Relay", (d) => (d.vercelOk ? "pushing" : "failing"), (d) => d.vercelOk],
];

export default function App() {
  const [relay, setRelay] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await (await fetch("/api/device")).json();
        if (stop) return;
        setRelay(r);
        setErr(r.status ? "" : "waiting for camera to push");
      } catch (e) {
        if (!stop) setErr(e.message);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, []);

  const d = relay?.status;
  const age = relay?.seenAt ? Date.now() - Date.parse(relay.seenAt) : null;
  const online = d && age != null && age < STALE_MS;

  return (
    <>
      <h1>ESP32-CAM</h1>
      <div className="sub">
        {online ? `seen ${Math.round(age / 1000)}s ago` : "offline"}
      </div>

      {err && <div className="err">{err}</div>}

      <div className="grid">
        {CARDS.map(([id, label, get, ok]) => (
          <div className="card" key={id}>
            <div className="k">{label}</div>
            <div className={`v ${online ? (ok && ok(d) ? "ok" : ok ? "bad" : "") : "muted"}`}>
              {online ? get(d) : "…"}
            </div>
          </div>
        ))}
      </div>

      {relay?.frame && <img src={relay.frame} alt="camera" />}
    </>
  );
}
