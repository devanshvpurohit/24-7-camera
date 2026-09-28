import assert from "node:assert";
const h = (await import("/Users/devanshvpurohit/qw/dashboard/api/device.js")).default;

const call = (method, { type, body, len } = {}) => {
  const res = { _h: {}, setHeader(k,v){this._h[k]=v}, status(c){this.code=c;return this},
    json(o){this.out=o;return this} };
  h({ method, headers: type ? { "content-type": type, "content-length": len ?? (typeof body === "string" || Buffer.isBuffer(body) ? Buffer.byteLength(body) : 0) } : {} , body }, res);
  return res;
};

let r = call("GET");
assert.equal(r.code, 200);
assert.equal(r.out.status, null, "empty before first push");
assert.equal(r.out.frame, null);
assert.equal(r._h["Access-Control-Allow-Origin"], "*");
console.log("GET before push OK");

r = call("POST", { type: "application/json", body: { wifi: "connected", rssi: -55, camera: true, uptime: 1234 } });
assert.equal(r.code, 200);
r = call("GET");
assert.equal(r.out.status.rssi, -55);
assert.ok(r.out.seenAt, "seenAt set");
console.log("status POST + GET OK");

const jpeg = Buffer.from([0xff,0xd8,0xff,0xe0,1,2,3,0xff,0xd9]);
r = call("POST", { type: "image/jpeg", body: jpeg, len: jpeg.length });
assert.equal(r.code, 200);
r = call("GET");
assert.ok(r.out.frame.startsWith("data:image/jpeg;base64,"), "frame is a data URI");
assert.equal(Buffer.from(r.out.frame.split(",")[1], "base64").toString("hex"), jpeg.toString("hex"));
console.log("jpeg round-trip byte-exact OK, base64 len", r.out.frame.length);

r = call("PUT");
assert.equal(r.code, 405);
assert.equal(r._h.Allow, "GET, POST");
console.log("405 OK");

r = call("POST", { type: "image/jpeg", body: "", len: 0 });
r = call("GET");
assert.ok(r.out.frame, "previous frame survives an empty POST");
console.log("empty POST keeps last frame OK");
