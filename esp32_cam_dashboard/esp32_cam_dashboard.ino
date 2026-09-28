/*
  ============================================================
  ESP32-CAM + VERCEL
  AI Thinker ESP32-CAM

  Features:
  - Saved WiFi credentials using Preferences
  - Captive portal for WiFi setup
  - ESP32-CAM web interface
  - Dashboard at /dashboard
  - Live MJPEG stream
  - Single JPEG capture
  - WiFi reconnect
  - HTTPS connection to Vercel
  - Vercel heartbeat
  - JPEG upload to Vercel

  Board:
  AI Thinker ESP32-CAM
  ============================================================
*/

#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include "esp_camera.h"

// ============================================================
// VERCEL
// ============================================================

#define VERCEL_HOST "https://dashboard-mocha-eight-63.vercel.app"
#define VERCEL_ENDPOINT "/api/device"

// ============================================================
// WIFI SETUP AP
// ============================================================

#define AP_SSID     "SURDAS-CAM-Setup"
#define AP_PASSWORD "12345678"

// ============================================================
// WIFI TIMING
// ============================================================

#define WIFI_CONNECT_TIMEOUT_MS 15000UL
#define WIFI_RETRY_INTERVAL_MS  30000UL

// ============================================================
// SERVER
// ============================================================

WebServer server(80);
DNSServer dnsServer;
Preferences prefs;

// ============================================================
// CAMERA - AI THINKER ESP32-CAM
// ============================================================

#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27

#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5

#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

// ============================================================
// STATE
// ============================================================

bool cameraReady = false;
bool apMode = false;

unsigned long lastWifiRetry = 0;
unsigned long lastVercelPing = 0;
unsigned long lastFrameUpload = 0;
unsigned long bootMillis = 0;

int lastVercelCode = 0;

#define VERCEL_PING_INTERVAL  30000UL
// Frame rate of the remote stream. 700ms ~= 1.4fps over the relay.
// ponytail: JPEG size x this rate is the whole bandwidth bill. At VGA
// q12 that is roughly 60KB every 700ms (~7Mbps up). Drop FRAMESIZE to
// SVGA/HVGA and raise jpeg_quality (number = worse) if that hurts.
#define FRAME_UPLOAD_INTERVAL 700UL

// ============================================================
// HTML CAMERA PAGE
// ============================================================

const char CAMERA_PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>

<head>

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>ESP32-CAM</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #050505;
  color: white;
  font-family: Arial, sans-serif;
  text-align: center;
}

header {
  padding: 18px;
  background: #111;
  border-bottom: 1px solid #333;
}

h1 {
  margin: 0;
  font-size: 22px;
}

.status {
  margin-top: 6px;
  color: #00ff99;
  font-size: 13px;
}

.camera {
  width: 100%;
  max-width: 900px;
  margin: 20px auto;
  padding: 10px;
}

.camera img {
  width: 100%;
  height: auto;
  border-radius: 12px;
  background: #111;
  border: 1px solid #333;
}

.buttons {
  margin: 20px;
}

button {
  background: #151515;
  color: white;
  border: 1px solid #444;
  border-radius: 8px;
  padding: 12px 20px;
  margin: 5px;
  cursor: pointer;
}

button:hover {
  background: #222;
}

.info {
  color: #888;
  font-size: 13px;
  padding: 20px;
}

</style>

</head>

<body>

<header>

<h1>ESP32-CAM</h1>

<div class="status" id="status">
Connecting...
</div>

</header>

<div class="camera">

<img id="stream" src="/stream">

</div>

<div class="buttons">

<button onclick="capture()">
Capture
</button>

<button onclick="location.href='/dashboard'">
Dashboard
</button>

<button onclick="location.reload()">
Refresh
</button>

<button onclick="location.href='/status'">
Status
</button>

</div>

<div class="info">
AI Thinker ESP32-CAM
</div>

<script>

async function checkStatus() {

  try {

    const response = await fetch('/status');

    const data = await response.json();

    document.getElementById("status").innerHTML =
      data.wifi +
      " | " +
      data.ip;

  } catch(e) {

    document.getElementById("status").innerHTML =
      "Camera offline";

  }

}

function capture() {

  window.open(
    "/capture",
    "_blank"
  );

}

checkStatus();

setInterval(
  checkStatus,
  5000
);

</script>

</body>

</html>
)rawliteral";

// ============================================================
// DASHBOARD PAGE
// ============================================================

const char DASHBOARD_PAGE[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html>

<head>

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>ESP32-CAM Dashboard</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 20px;
  background: #050505;
  color: #eee;
  font-family: Arial, sans-serif;
}

h1 {
  margin: 0 0 4px;
  font-size: 22px;
}

.sub {
  color: #777;
  font-size: 13px;
  margin-bottom: 20px;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  max-width: 1000px;
}

.card {
  background: #111;
  border: 1px solid #2a2a2a;
  border-radius: 10px;
  padding: 14px;
}

.card .k {
  color: #777;
  font-size: 12px;
  text-transform: uppercase;
}

.card .v {
  font-size: 20px;
  margin-top: 6px;
  word-break: break-all;
}

.ok {
  color: #00ff99;
}

.bad {
  color: #ff4d4d;
}

.preview {
  max-width: 1000px;
  margin-top: 20px;
}

.preview img {
  width: 100%;
  border-radius: 10px;
  border: 1px solid #2a2a2a;
  display: block;
}

a.btn {
  display: inline-block;
  background: #151515;
  color: #eee;
  border: 1px solid #444;
  border-radius: 8px;
  padding: 10px 16px;
  margin: 16px 6px 0 0;
  text-decoration: none;
  font-size: 14px;
}

a.btn:hover {
  background: #222;
}

</style>

</head>

<body>

<h1>ESP32-CAM</h1>

<div class="sub">
Dashboard
</div>

<div class="grid">

<div class="card">
<div class="k">WiFi</div>
<div class="v" id="wifi">-</div>
</div>

<div class="card">
<div class="k">IP</div>
<div class="v" id="ip">-</div>
</div>

<div class="card">
<div class="k">SSID</div>
<div class="v" id="ssid">-</div>
</div>

<div class="card">
<div class="k">RSSI</div>
<div class="v" id="rssi">-</div>
</div>

<div class="card">
<div class="k">Camera</div>
<div class="v" id="camera">-</div>
</div>

<div class="card">
<div class="k">Uptime</div>
<div class="v" id="uptime">-</div>
</div>

<div class="card">
<div class="k">Free Heap</div>
<div class="v" id="heap">-</div>
</div>

<div class="card">
<div class="k">PSRAM</div>
<div class="v" id="psram">-</div>
</div>

<div class="card">
<div class="k">Relay</div>
<div class="v" id="clients">-</div>
</div>

</div>

<div class="preview">

<img src="/stream" alt="stream">

</div>

<a class="btn" href="/">
Camera
</a>

<a class="btn"
href="/capture"
target="_blank">
Capture
</a>

<a class="btn"
href="/status"
target="_blank">
JSON
</a>

<a class="btn"
href="/reset">
Reset WiFi
</a>

<script>

const POLL_MS = 3000;

function fmtUptime(ms) {

  const s = Math.floor(ms / 1000);

  const d = Math.floor(s / 86400);

  const h =
    Math.floor(
      s % 86400 / 3600
    );

  const m =
    Math.floor(
      s % 3600 / 60
    );

  return d +
    "d " +
    h +
    "h " +
    m +
    "m " +
    (s % 60) +
    "s";

}

function set(id, text, good) {

  const el =
    document.getElementById(id);

  el.textContent = text;

  el.className =
    "v " +
    (
      good === undefined
      ? ""
      : good
        ? "ok"
        : "bad"
    );

}

async function poll() {

  try {

    const response =
      await fetch("/status");

    const d =
      await response.json();

    const up =
      d.wifi === "connected";

    set(
      "wifi",
      d.wifi,
      up
    );

    set(
      "ip",
      d.ip || "-",
      up
    );

    set(
      "ssid",
      d.ssid || "-",
      up
    );

    set(
      "rssi",
      d.rssi + " dBm",
      up
    );

    set(
      "camera",
      d.camera
        ? "ready"
        : "error",
      d.camera
    );

    set(
      "uptime",
      fmtUptime(d.uptime)
    );

    set(
      "heap",
      Math.round(
        d.heap / 1024
      ) + " KB"
    );

    set(
      "psram",
      d.psram > 0
        ? Math.round(
            d.psram / 1024
          ) + " KB"
        : "none"
    );

    set(
      "clients",
      d.vercelOk
        ? "relay ok"
        : "relay failing",
      d.vercelOk
    );

  } catch(e) {

    set(
      "wifi",
      "offline",
      false
    );

  }

}

poll();

setInterval(
  poll,
  POLL_MS
);

</script>

</body>

</html>
)rawliteral";

// ============================================================
// CAMERA INITIALIZATION
// ============================================================

bool initCamera() {

  Serial.println();
  Serial.println(
    "================================"
  );

  Serial.println(
    "Initializing ESP32-CAM"
  );

  Serial.println(
    "================================"
  );

  camera_config_t config;

  config.ledc_channel =
    LEDC_CHANNEL_0;

  config.ledc_timer =
    LEDC_TIMER_0;

  config.pin_d0 =
    Y2_GPIO_NUM;

  config.pin_d1 =
    Y3_GPIO_NUM;

  config.pin_d2 =
    Y4_GPIO_NUM;

  config.pin_d3 =
    Y5_GPIO_NUM;

  config.pin_d4 =
    Y6_GPIO_NUM;

  config.pin_d5 =
    Y7_GPIO_NUM;

  config.pin_d6 =
    Y8_GPIO_NUM;

  config.pin_d7 =
    Y9_GPIO_NUM;

  config.pin_xclk =
    XCLK_GPIO_NUM;

  config.pin_pclk =
    PCLK_GPIO_NUM;

  config.pin_vsync =
    VSYNC_GPIO_NUM;

  config.pin_href =
    HREF_GPIO_NUM;

  config.pin_sccb_sda =
    SIOD_GPIO_NUM;

  config.pin_sccb_scl =
    SIOC_GPIO_NUM;

  config.pin_pwdn =
    PWDN_GPIO_NUM;

  config.pin_reset =
    RESET_GPIO_NUM;

  config.xclk_freq_hz =
    20000000;

  config.pixel_format =
    PIXFORMAT_JPEG;

  // ==========================================================
  // PSRAM
  // ==========================================================

  if (psramFound()) {

    Serial.println(
      "[CAM] PSRAM detected"
    );

    config.frame_size =
      FRAMESIZE_VGA;

    config.jpeg_quality =
      12;

    config.fb_count =
      2;

    config.grab_mode =
      CAMERA_GRAB_LATEST;

  } else {

    Serial.println(
      "[CAM] No PSRAM"
    );

    config.frame_size =
      FRAMESIZE_QVGA;

    config.jpeg_quality =
      15;

    config.fb_count =
      1;

    config.grab_mode =
      CAMERA_GRAB_WHEN_EMPTY;
  }

  // ==========================================================
  // INIT
  // ==========================================================

  esp_err_t err =
    esp_camera_init(
      &config
    );

  if (err != ESP_OK) {

    Serial.printf(
      "[CAM] Camera init failed: 0x%x\n",
      err
    );

    return false;
  }

  sensor_t *sensor =
    esp_camera_sensor_get();

  if (sensor) {

    sensor->set_brightness(
      sensor,
      0
    );

    sensor->set_contrast(
      sensor,
      0
    );

    sensor->set_saturation(
      sensor,
      0
    );

    sensor->set_framesize(
      sensor,
      psramFound()
        ? FRAMESIZE_VGA
        : FRAMESIZE_QVGA
    );
  }

  Serial.println(
    "[CAM] Camera initialized"
  );

  return true;
}

// ============================================================
// WIFI CONNECT SAVED
// ============================================================

bool wifiConnectSaved() {

  String ssid =
    prefs.getString(
      "ssid",
      ""
    );

  String pass =
    prefs.getString(
      "pass",
      ""
    );

  if (ssid.length() == 0) {

    Serial.println(
      "[WiFi] No saved credentials"
    );

    return false;
  }

  Serial.println();

  Serial.println(
    "================================"
  );

  Serial.print(
    "[WiFi] Connecting to: "
  );

  Serial.println(ssid);

  Serial.println(
    "================================"
  );

  WiFi.mode(
    WIFI_STA
  );

  WiFi.begin(
    ssid.c_str(),
    pass.c_str()
  );

  unsigned long start =
    millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - start <
      WIFI_CONNECT_TIMEOUT_MS
  ) {

    delay(300);

    Serial.print(".");
  }

  Serial.println();

  if (
    WiFi.status() ==
    WL_CONNECTED
  ) {

    Serial.println(
      "[WiFi] Connected"
    );

    Serial.print(
      "[WiFi] IP: "
    );

    Serial.println(
      WiFi.localIP()
    );

    Serial.print(
      "[WiFi] RSSI: "
    );

    Serial.println(
      WiFi.RSSI()
    );

    return true;
  }

  Serial.println(
    "[WiFi] Connection failed"
  );

  WiFi.disconnect(true);

  return false;
}

// ============================================================
// WIFI SCAN
// ============================================================

String buildNetworkOptions() {

  String html = "";

  int count =
    WiFi.scanNetworks();

  Serial.print(
    "[AP] Networks found: "
  );

  Serial.println(count);

  if (count <= 0) {

    return
      "<option value=''>No networks found</option>";
  }

  for (
    int i = 0;
    i < count;
    i++
  ) {

    String ssid =
      WiFi.SSID(i);

    if (ssid.length() == 0)
      continue;

    html +=
      "<option value=\"" +
      ssid +
      "\">";

    html += ssid;

    html +=
      " (" +
      String(WiFi.RSSI(i)) +
      " dBm)";

    html +=
      "</option>";
  }

  WiFi.scanDelete();

  return html;
}

// ============================================================
// CAPTIVE PORTAL ROOT
// ============================================================

void handleSetupRoot() {

  String options =
    buildNetworkOptions();

  String html =
    R"rawliteral(
<!DOCTYPE html>
<html>

<head>

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>ESP32-CAM WiFi Setup</title>

<style>

body {
  background:#050505;
  color:white;
  font-family:Arial;
  padding:25px;
}

.container {
  max-width:500px;
  margin:auto;
}

h1 {
  text-align:center;
}

input,
select {
  width:100%;
  padding:13px;
  margin:8px 0;
  background:#111;
  color:white;
  border:1px solid #444;
  border-radius:7px;
}

button {
  width:100%;
  padding:14px;
  margin-top:15px;
  background:#00aa66;
  color:white;
  border:0;
  border-radius:7px;
  font-size:16px;
}

</style>

</head>

<body>

<div class="container">

<h1>ESP32-CAM Setup</h1>

<form action="/connect"
method="POST">

<label>
WiFi Network
</label>

<select name="ssid">

)rawliteral";

  html += options;

  html +=
    R"rawliteral(

</select>

<label>
Password
</label>

<input
type="password"
name="pass"
placeholder="WiFi password">

<button type="submit">
Connect
</button>

</form>

</div>

</body>

</html>

)rawliteral";

  server.send(
    200,
    "text/html",
    html
  );
}

// ============================================================
// SCAN
// ============================================================

void handleScan() {

  server.send(
    200,
    "text/html",
    buildNetworkOptions()
  );
}

// ============================================================
// CONNECT
// ============================================================

void handleConnect() {

  if (
    !server.hasArg("ssid")
  ) {

    server.send(
      400,
      "text/plain",
      "Missing SSID"
    );

    return;
  }

  String ssid =
    server.arg("ssid");

  String pass =
    server.arg("pass");

  Serial.println();

  Serial.println(
    "[AP] Saving WiFi credentials"
  );

  Serial.print(
    "[AP] SSID: "
  );

  Serial.println(ssid);

  prefs.putString(
    "ssid",
    ssid
  );

  prefs.putString(
    "pass",
    pass
  );

  String html =
    R"rawliteral(
<!DOCTYPE html>
<html>

<head>

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>Saved</title>

</head>

<body
style="background:#050505;color:white;font-family:Arial;text-align:center;padding:50px">

<h1>WiFi Saved</h1>

<p>
ESP32-CAM is restarting...
</p>

</body>

</html>
)rawliteral";

  server.send(
    200,
    "text/html",
    html
  );

  delay(1000);

  ESP.restart();
}

// ============================================================
// RESET WIFI
// ============================================================

void handleReset() {

  prefs.remove("ssid");

  prefs.remove("pass");

  server.send(
    200,
    "text/plain",
    "WiFi credentials erased. Restarting..."
  );

  delay(1000);

  ESP.restart();
}

// ============================================================
// CAMERA ROOT
// ============================================================

void handleCameraRoot() {

  server.send_P(
    200,
    "text/html",
    CAMERA_PAGE
  );
}

// ============================================================
// DASHBOARD
// ============================================================

void handleDashboard() {

  server.send_P(
    200,
    "text/html",
    DASHBOARD_PAGE
  );
}

// ============================================================
// CAPTURE JPEG
// ============================================================

void handleCapture() {

  if (!cameraReady) {

    server.send(
      503,
      "text/plain",
      "Camera not ready"
    );

    return;
  }

  camera_fb_t *fb =
    esp_camera_fb_get();

  if (!fb) {

    server.send(
      500,
      "text/plain",
      "Camera capture failed"
    );

    return;
  }

  server.sendHeader(
    "Content-Disposition",
    "inline; filename=capture.jpg"
  );

  server.setContentLength(
    fb->len
  );

  server.send(
    200,
    "image/jpeg"
  );

  WiFiClient client =
    server.client();

  client.write(
    fb->buf,
    fb->len
  );

  esp_camera_fb_return(
    fb
  );
}

// ============================================================
// MJPEG STREAM
// ============================================================

void handleStream() {

  if (!cameraReady) {

    server.send(
      503,
      "text/plain",
      "Camera not ready"
    );

    return;
  }

  WiFiClient client =
    server.client();

  client.setTimeout(5);

  server.sendContent(
    "HTTP/1.1 200 OK\r\n"
    "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n"
    "Cache-Control: no-cache\r\n"
    "Pragma: no-cache\r\n"
    "Access-Control-Allow-Origin: *\r\n\r\n"
  );

  while (
    client.connected()
  ) {

    camera_fb_t *fb =
      esp_camera_fb_get();

    if (!fb) {

      Serial.println(
        "[CAM] Capture failed"
      );

      break;
    }

    server.sendContent(
      "--frame\r\n"
    );

    server.sendContent(
      "Content-Type: image/jpeg\r\n"
    );

    server.sendContent(
      "Content-Length: " +
      String(fb->len) +
      "\r\n\r\n"
    );

    client.write(
      fb->buf,
      fb->len
    );

    server.sendContent(
      "\r\n"
    );

    esp_camera_fb_return(
      fb
    );

    delay(30);
  }
}

// ============================================================
// STATUS
// ============================================================

String statusJson() {

  String json = "{";

  json +=
    "\"wifi\":\"";

  if (
    WiFi.status() ==
    WL_CONNECTED
  ) {

    json += "connected";

  } else {

    json += "disconnected";
  }

  json += "\",";

  json +=
    "\"ip\":\"";

  json +=
    WiFi.localIP().toString();

  json += "\",";

  json +=
    "\"ssid\":\"";

  json +=
    WiFi.SSID();

  json += "\",";

  json +=
    "\"rssi\":";

  json +=
    String(WiFi.RSSI());

  json += ",";

  json +=
    "\"camera\":";

  json +=
    cameraReady
      ? "true"
      : "false";

  json += ",";

  json +=
    "\"uptime\":";

  json +=
    String(
      millis() - bootMillis
    );

  json += ",";

  json +=
    "\"heap\":";

  json +=
    String(
      ESP.getFreeHeap()
    );

  json += ",";

  json +=
    "\"psram\":";

  json +=
    String(
      ESP.getFreePsram()
    );

  json += ",";

  json +=
    "\"vercelOk\":";

  json +=
    lastVercelCode > 0
      ? "true"
      : "false";

  json += "}";

  return json;
}

void handleStatus() {

  server.sendHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  server.send(
    200,
    "application/json",
    statusJson()
  );
}

// ============================================================
// NOT FOUND
// ============================================================

void handleNotFound() {

  if (apMode) {

    server.sendHeader(
      "Location",
      "/",
      true
    );

    server.send(
      302,
      "text/plain",
      ""
    );

    return;
  }

  server.send(
    404,
    "text/plain",
    "Not Found"
  );
}

// ============================================================
// NORMAL SERVER
// ============================================================

void startCameraServer() {

  server.on(
    "/",
    HTTP_GET,
    handleCameraRoot
  );

  server.on(
    "/dashboard",
    HTTP_GET,
    handleDashboard
  );

  server.on(
    "/stream",
    HTTP_GET,
    handleStream
  );

  server.on(
    "/capture",
    HTTP_GET,
    handleCapture
  );

  server.on(
    "/status",
    HTTP_GET,
    handleStatus
  );

  server.on(
    "/reset",
    HTTP_GET,
    handleReset
  );

  server.onNotFound(
    handleNotFound
  );

  server.begin();

  Serial.println(
    "[HTTP] Camera server started"
  );

  Serial.print(
    "[HTTP] Dashboard: http://"
  );

  Serial.print(
    WiFi.localIP()
  );

  Serial.println(
    "/dashboard"
  );
}

// ============================================================
// SETUP ACCESS POINT
// ============================================================

void startSetupAP() {

  apMode = true;

  WiFi.mode(
    WIFI_AP
  );

  bool ok;

  if (
    strlen(AP_PASSWORD) >= 8
  ) {

    ok =
      WiFi.softAP(
        AP_SSID,
        AP_PASSWORD
      );

  } else {

    ok =
      WiFi.softAP(
        AP_SSID
      );
  }

  IPAddress ip =
    WiFi.softAPIP();

  Serial.println();

  Serial.println(
    "================================"
  );

  Serial.println(
    "ESP32-CAM SETUP MODE"
  );

  Serial.print(
    "SSID: "
  );

  Serial.println(
    AP_SSID
  );

  Serial.print(
    "IP: "
  );

  Serial.println(
    ip
  );

  Serial.print(
    "AP started: "
  );

  Serial.println(
    ok ? "YES" : "NO"
  );

  Serial.println(
    "================================"
  );

  dnsServer.start(
    53,
    "*",
    ip
  );

  server.on(
    "/",
    HTTP_GET,
    handleSetupRoot
  );

  server.on(
    "/scan",
    HTTP_GET,
    handleScan
  );

  server.on(
    "/connect",
    HTTP_POST,
    handleConnect
  );

  server.on(
    "/reset",
    HTTP_GET,
    handleReset
  );

  server.onNotFound(
    handleNotFound
  );

  server.begin();
}

// ============================================================
// VERCEL RELAY
// ============================================================
//
// IMPORTANT:
// ESP32 Arduino Core 3.3.11 defines:
//
// HTTPClient::POST(uint8_t *payload, size_t size)
//
// but our function uses const uint8_t*.
//
// const_cast is used only at the POST call because
// HTTPClient does not need to modify the payload.
// ============================================================

int vercelPost(
  const char *contentType,
  const uint8_t *body,
  size_t len
) {

  if (
    WiFi.status() !=
    WL_CONNECTED
  ) {

    Serial.println(
      "[Vercel] WiFi not connected"
    );

    return -1;
  }

  String url =
    String(VERCEL_HOST) +
    VERCEL_ENDPOINT;

  WiFiClientSecure client;

  // Vercel uses HTTPS.
  // This skips certificate verification.
  client.setInsecure();

  HTTPClient http;

  if (
    !http.begin(
      client,
      url
    )
  ) {

    Serial.println(
      "[Vercel] http.begin failed"
    );

    return -1;
  }

  http.setTimeout(
    15000
  );

  http.addHeader(
    "Content-Type",
    contentType
  );

  http.addHeader(
    "User-Agent",
    "ESP32-CAM/1.0"
  );

  // ==========================================================
  // FIX FOR ESP32 CORE 3.3.11
  // ==========================================================

  int code =
    http.POST(
      const_cast<uint8_t *>(body),
      len
    );

  lastVercelCode =
    code;

  Serial.print(
    "[Vercel] POST "
  );

  Serial.print(
    url
  );

  Serial.print(
    " -> "
  );

  Serial.print(
    code
  );

  Serial.print(
    " ("
  );

  Serial.print(
    len
  );

  Serial.println(
    " bytes)"
  );

  if (code < 0) {

    Serial.print(
      "[Vercel] Error: "
    );

    Serial.println(
      http.errorToString(code)
    );

  } else {

    Serial.print(
      "[Vercel] Response: "
    );

    Serial.println(
      http.getString()
    );
  }

  http.end();

  return code;
}

// ============================================================
// PUSH STATUS TO VERCEL
// ============================================================

void pushStatusToVercel() {

  String json =
    statusJson();

  vercelPost(
    "application/json",
    (const uint8_t *)json.c_str(),
    json.length()
  );
}

// ============================================================
// PUSH CAMERA FRAME TO VERCEL
// ============================================================

void pushFrameToVercel() {

  // ponytail: this blocks the loop for the whole HTTPS POST, so the
  // local /stream and /capture page stutter while a frame is going up
  // and the real frame rate is capped by upload time rather than by
  // FRAME_UPLOAD_INTERVAL. Non-blocking upload (a FreeRTOS task) if
  // the local page needs to stay smooth.
  if (!cameraReady) {

    return;
  }

  camera_fb_t *fb =
    esp_camera_fb_get();

  if (!fb) {

    Serial.println(
      "[Vercel] Camera capture failed"
    );

    return;
  }

  vercelPost(
    "image/jpeg",
    fb->buf,
    fb->len
  );

  esp_camera_fb_return(
    fb
  );
}

// ============================================================
// WIFI WATCHDOG
// ============================================================

void checkWiFi() {

  if (
    apMode
  ) {

    return;
  }

  if (
    WiFi.status() ==
    WL_CONNECTED
  ) {

    return;
  }

  if (
    millis() -
    lastWifiRetry <
    WIFI_RETRY_INTERVAL_MS
  ) {

    return;
  }

  lastWifiRetry =
    millis();

  Serial.println(
    "[WiFi] Connection lost"
  );

  String ssid =
    prefs.getString(
      "ssid",
      ""
    );

  String pass =
    prefs.getString(
      "pass",
      ""
    );

  if (
    ssid.length() == 0
  ) {

    return;
  }

  Serial.println(
    "[WiFi] Reconnecting..."
  );

  WiFi.disconnect();

  delay(200);

  WiFi.begin(
    ssid.c_str(),
    pass.c_str()
  );
}

// ============================================================
// SETUP
// ============================================================

void setup() {

  Serial.begin(
    115200
  );

  delay(1000);

  bootMillis =
    millis();

  Serial.println();
  Serial.println();

  Serial.println(
    "========================================"
  );

  Serial.println(
    "       ESP32-CAM + VERCEL"
  );

  Serial.println(
    "========================================"
  );

  // ==========================================================
  // Preferences
  // ==========================================================

  prefs.begin(
    "cam-wifi",
    false
  );

  // ==========================================================
  // Camera
  // ==========================================================

  cameraReady =
    initCamera();

  if (!cameraReady) {

    Serial.println(
      "[CAM] WARNING: Camera unavailable"
    );
  }

  // ==========================================================
  // WiFi
  // ==========================================================

  bool connected =
    wifiConnectSaved();

  if (connected) {

    apMode = false;

    startCameraServer();

    delay(1000);

    // First Vercel status push
    pushStatusToVercel();

  } else {

    startSetupAP();
  }
}

// ============================================================
// LOOP
// ============================================================

void loop() {

  // ==========================================================
  // Captive portal
  // ==========================================================

  if (apMode) {

    dnsServer.processNextRequest();

    server.handleClient();

    delay(2);

    return;
  }

  // ==========================================================
  // Camera server
  // ==========================================================

  server.handleClient();

  // ==========================================================
  // WiFi
  // ==========================================================

  checkWiFi();

  // ==========================================================
  // Vercel
  // ==========================================================

  if (
    WiFi.status() ==
    WL_CONNECTED
  ) {

    // --------------------------------------------------------
    // Status
    // --------------------------------------------------------

    if (
      millis() -
      lastVercelPing >=
      VERCEL_PING_INTERVAL
    ) {

      lastVercelPing =
        millis();

      pushStatusToVercel();
    }

    // --------------------------------------------------------
    // Camera frame
    // --------------------------------------------------------

    if (
      millis() -
      lastFrameUpload >=
      FRAME_UPLOAD_INTERVAL
    ) {

      lastFrameUpload =
        millis();

      pushFrameToVercel();
    }
  }

  delay(2);
}