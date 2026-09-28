import { useState, useEffect, useRef, useCallback } from "react";

// ponytail: fast poll of our own /api/device relay, not the camera.
// The camera is behind NAT with no inbound port, and an https page
// cannot load an http:// image anyway, so every frame has to come
// through Vercel. The ETag/304 on the relay means a poll that finds
// no new frame costs a few bytes, not a whole JPEG.
const POLL_MS = 400;

// Ceiling: this can never beat the device's FRAME_UPLOAD_INTERVAL,
// and the relay adds one relay hop. Real streaming wants a
// long-lived chunked response (MJPEG over SSE) on the device.
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
  const [big, setBig] = useState(false);
  const img = useRef(null);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        // "no-cache" revalidates: sends If-None-Match and honours a
        // 304. "no-store" would skip the HTTP cache and re-download
        // the whole frame on every poll.
        const r = await fetch("/api/device", { cache: "no-cache" });
        // 304 means no new frame. Keep the old <img> src so the
        // picture does not flicker black between frames.
        if (r.status === 304) return;
        if (!r.ok) throw new Error(`relay ${r.status}`);
        const j = await r.json();
        if (stop) return;
        setRelay(j);
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
  }, []);

  // Fullscreen the live view, the way a security monitor should work.
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
    const on = (e) => e.key === "f" && !e.target.matches("input,textarea") && toggleBig();
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [toggleBig]);

  const d = relay?.status;
  const age = relay?.seenAt ? Date.now() - Date.parse(relay.seenAt) : null;
  const online = d && age != null && age < STALE_MS;

  return (
    <>
      <h1>ESP32-CAM</h1>
      <div className="sub">
        {online ? `seen ${Math.round(age / 1000)}s ago` : "offline"}
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

      {relay?.frame && (
        <img
          ref={img}
          className="view"
          src={relay.frame}
          alt="camera"
          onClick={toggleBig}
        />
      )}

      {relay?.frame && (
        <div className="bar">
          <button onClick={toggleBig}>{big ? "Exit fullscreen" : "Fullscreen"}</button>
          <a className="btn" href={relay.frame} download="capture.jpg">Save frame</a>
        </div>
      )}
    </>
  );
}
