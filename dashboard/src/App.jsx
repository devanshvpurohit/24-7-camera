import { useState, useEffect } from "react";

// ponytail: 3s polling of the device's own /status endpoint.
// Ceiling: no sub-second updates. Add SSE /events on the ESP32
// if you ever need live state streaming.
const POLL_MS = 3000;

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
  ["vercel", "Vercel", (d) => d.vercel, (d) => d.vercelOk],
];

export default function App() {
  const [base, setBase] = useState(() => localStorage.getItem("camUrl") || "");
  const [draft, setDraft] = useState(base);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!base) return;
    let stop = false;
    const tick = async () => {
      try {
        const d = await (await fetch(`${base}/status`)).json();
        if (!stop) {
          setData(d);
          setErr("");
        }
      } catch (e) {
        if (!stop) setErr(`${base} unreachable: ${e.message}`);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [base]);

  const connect = () => {
    const clean = draft.trim().replace(/\/+$/, "");
    localStorage.setItem("camUrl", clean);
    setData(null);
    setBase(clean);
  };

  return (
    <>
      <h1>ESP32-CAM</h1>
      <div className="sub">Dashboard</div>

      <div className="bar">
        <input
          value={draft}
          spellCheck="false"
          placeholder="http://192.168.1.50"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && connect()}
        />
        <button onClick={connect}>Connect</button>
        <a className="btn" href={base} target="_blank" rel="noreferrer">Camera</a>
        <a className="btn" href={`${base}/capture`} target="_blank" rel="noreferrer">Capture</a>
        <a className="btn" href={`${base}/status`} target="_blank" rel="noreferrer">JSON</a>
        <a className="btn" href={`${base}/reset`}>Reset WiFi</a>
      </div>

      {err && <div className="err">{err}</div>}

      <div className="grid">
        {CARDS.map(([id, label, get, ok]) => (
          <div className="card" key={id}>
            <div className="k">{label}</div>
            <div className={`v ${data ? (ok ? (ok(data) ? "ok" : "bad") : "") : "muted"}`}>
              {data ? get(data) : "…"}
            </div>
          </div>
        ))}
      </div>

      {data && data.camera && <img src={`${base}/stream`} alt="live stream" />}
    </>
  );
}
