import { useState, useEffect, useRef, useCallback } from "react";

// ponytail: video comes from <img src="/api/device">. The browser decodes
// multipart/x-mixed-replace natively, so there is no player and no fetch
// loop. Ceiling: Vercel cuts the function at 60s, so we reconnect on
// error. The ESP32 cannot be streamed to directly (NAT, and an https
// page cannot load an http:// image) - everything goes through here.
const STREAM = "/api/device";
const POLL_MS = 5000;

// Status ages out at 45s: device pushes every 30s, so two missed pushes
// means it is gone.
const STALE_MS = 45000;

const fmtUptime = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ` +
    `${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
};

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
  const [d, setD] = useState(null);
  const [err, setErr] = useState("");
  const [age, setAge] = useState(null);
  const [big, setBig] = useState(false);
  // Bumped to restart the stream. Changing this is the whole reconnect.
  const [attempt, setAttempt] = useState(0);
  const img = useRef(null);

  // Status is cheap JSON on a separate path, so the stream can hold this
  // request open without blocking anything.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await fetch(`${STREAM}?json=1`, { cache: "no-cache" });
        if (r.status === 304) return;
        if (!r.ok) throw new Error(`relay ${r.status}`);
        const j = await r.json();
        if (stop) return;
        setD(j.status);
        setAge(j.seenAt ? Date.now() - Date.parse(j.seenAt) : null);
        setErr(j.status ? "" : "waiting for camera to push");
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
  }, [attempt]);

  // Reconnect when the platform cuts the stream, with a small backoff so a
  // dead relay does not spin.
  const onStreamEnd = useCallback(() => {
    const wait = Math.min(1000 * 2 ** Math.min(attempt, 4), 15000);
    setTimeout(() => setAttempt((a) => a + 1), wait);
  }, [attempt]);

  const toggleBig = useCallback(() => {
    if (document.fullscreenElement) return document.exitFullscreen();
    img.current?.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const on = () => setBig(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  useEffect(() => {
    const on = (e) =>
      e.key === "f" && !e.target.matches("input,textarea") && toggleBig();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [toggleBig]);

  const online = d && age != null && age < STALE_MS;

  return (
    <>
      <h1>ESP32-CAM</h1>
      <div className="sub">
        <span className={online ? "ok" : "bad"}>
          {online ? `live - seen ${Math.round(age / 1000)}s ago` : "offline"}
        </span>
        <span className="hint"> · f = fullscreen</span>
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

      <img
        key={attempt}
        ref={img}
        className="view"
        src={STREAM}
        alt="live camera"
        onClick={toggleBig}
        onError={onStreamEnd}
      />

      <div className="bar">
        <button onClick={toggleBig}>{big ? "Exit fullscreen" : "Fullscreen"}</button>
        <button onClick={() => setAttempt((a) => a + 1)}>Reconnect</button>
      </div>
    </>
  );
}
