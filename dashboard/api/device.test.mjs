import assert from "node:assert";

const mod = await import("/Users/devanshvpurohit/qw/dashboard/api/device.js");
const handler = mod.default;

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

// Real res, minus the socket. write/end collect into `chunks` so we can
// assert on the bytes a browser would actually receive.
const open = [];

const mkRes = () => ({
  _h: {},
  chunks: [],
  setHeader(k, v) { this._h[k.toLowerCase()] = v; return this; },
  flushHeaders() { this.flushed = true; },
  status(c) { this.code = c; return this; },
  json(o) { this.out = o; this.chunks.push(Buffer.from(JSON.stringify(o))); return this; },
  write(b) {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
    this.chunks.push(buf);
    return true;
  },
  end() { this.ended = true; return this; },
  on(ev, fn) { (this._on ||= {})[ev] = fn; return this; },
  fire(ev) { this._on?.[ev]?.(); },
  body() { return Buffer.concat(this.chunks); },
});

const call = (method, { type, body, len, query, ...extra } = {}) => {
  const res = mkRes();
  const headers = {
    ...extra,
    ...(type ? { "content-type": type, "content-length": String(len ?? Buffer.byteLength(body)) } : {}),
  };
  handler({ method, headers, body, query, on(ev, fn) { (this._reqOn ||= {})[ev] = fn; } }, res);
  if (res._on) open.push(res);
  return res;
};

// --- status + frame ingest -------------------------------------------------

let r = call("GET", { query: { json: "1" } });
assert.equal(r.code, 200);
assert.equal(r.out.status, null, "empty before first push");
assert.equal(r.out.frame, undefined, "json path must not carry frame bytes");
console.log("status JSON before push OK");

r = call("POST", { type: "application/json", body: JSON.stringify({ wifi: "connected", rssi: -55, camera: true, uptime: 1234 }) });
assert.equal(r.code, 200);
r = call("GET", { query: { json: "1" } });
assert.equal(r.out.status.rssi, -55);
assert.ok(r.out.seenAt, "seenAt set");
console.log("status POST + GET OK");

r = call("PUT", { query: { json: "1" } });
assert.equal(r.code, 405);
assert.equal(r._h.allow, "GET, POST");
console.log("405 OK");

// --- multipart stream ------------------------------------------------------

r = call("GET");
assert.match(r._h["content-type"], /^multipart\/x-mixed-replace; boundary=frame$/);
assert.equal(r._h["cache-control"], "no-store, no-cache, must-revalidate");
assert.equal(r._h["x-accel-buffering"], "no");
assert.equal(r.flushed, true, "headers flushed immediately");
console.log("stream headers OK:", r._h["content-type"]);

// status must NOT be able to satisfy the stream: no frame, no body.
assert.equal(r.body().toString(), "--frame\r\n\r\n", "stream opens with a bare boundary");

r = call("POST", { type: "image/jpeg", body: jpeg });
assert.equal(r.code, 200);

// Let the 50ms tick fire, then read what a browser would have parsed.
const s = call("GET");
await new Promise((ok) => setTimeout(ok, 120));
const stream = s.body().toString();
assert.ok(stream.startsWith("--frame\r\n\r\n"), "opens with boundary preamble");

const m = stream.match(/--frame\r\nContent-Type: image\/jpeg\r\nContent-Length: (\d+)\r\n\r\n/);
assert.ok(m, "a full part header was written");
const len = Number(m[1]);
assert.equal(len, jpeg.length, "Content-Length matches the JPEG");

// Slice the Buffer, never the string: JPEG bytes above 0x7F would be
// mangled by a utf-8 round trip and the test would lie.
const raw = s.body();
const start = raw.indexOf(Buffer.from(m[0]));
const got = raw.subarray(start + Buffer.byteLength(m[0]), start + Buffer.byteLength(m[0]) + len);
assert.equal(got.toString("hex"), jpeg.toString("hex"), "JPEG bytes are byte-exact on the wire");
assert.equal(raw.subarray(start + Buffer.byteLength(m[0]) + len, start + Buffer.byteLength(m[0]) + len + 2).toString(), "\r\n", "part ends with CRLF");
console.log(`multipart part OK: ${len} bytes, byte-exact, CRLF terminated`);

// A viewer joining later must not get a wall of buffered frames, only the
// newest: the tick fires on seq change, one part per new frame.
assert.equal((stream.match(/Content-Type: image\/jpeg/g) || []).length, 1,
  "unchanged frame is not re-sent");

// --- ETag on the json path -------------------------------------------------

const tag = call("GET", { query: { json: "1" } })._h.etag;
assert.ok(tag, "ETag set on status path");
const poll = call("GET", { query: { json: "1" }, "if-none-match": tag });
assert.equal(poll.code, 304, "unchanged status poll is 304");
assert.equal(poll.ended, true, "304 carries no body");

call("POST", { type: "image/jpeg", body: Buffer.from([9, 9, 9]) });
assert.equal(call("GET", { query: { json: "1" }, "if-none-match": tag }).code, 200,
  "a push invalidates the ETag");
console.log("ETag/304 OK");

// --- same-millisecond pushes ----------------------------------------------

const a = call("GET", { query: { json: "1" } })._h.etag;
call("POST", { type: "image/jpeg", body: Buffer.from([1]) });
call("POST", { type: "image/jpeg", body: Buffer.from([2]) });
assert.notEqual(call("GET", { query: { json: "1" } })._h.etag, a,
  "each push advances the ETag even inside one millisecond");
console.log("same-ms pushes advance ETag OK");

// --- client disconnect stops the tick -------------------------------------
// A viewer closing the tab must not leave the relay spinning: on Vercel
// that holds the function instance open and burns quota forever.

const live = call("GET");
await new Promise((ok) => setTimeout(ok, 120));
const before = live.body().length;

call("POST", { type: "image/jpeg", body: Buffer.from([1, 2, 3, 4]) });
live.fire("close");
await new Promise((ok) => setTimeout(ok, 120));

assert.equal(live.body().length, before, "no writes after the viewer disconnects");
console.log("disconnect stops the stream OK");

// Tidy up: every handler whose response never closed still has a live
// interval. Without this the test process never exits.
open.forEach((r) => r.fire("close"));

console.log("\nall relay tests passed");
