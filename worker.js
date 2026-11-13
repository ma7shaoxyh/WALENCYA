// CF Config Panel — Cloudflare Worker edition (single file, no dependencies)
// Panel + subscription + VLESS/Trojan over WebSocket+TLS, storage in KV.
//
// Required bindings (Settings → Bindings / Variables):
//   KV         : KV namespace (e.g. cf-config-panel-kv)
//   ADMIN_PASS : secret, panel password
// Optional variables:
//   PROXY_IP   : fallback "ip" or "ip:port" for destinations behind Cloudflare

import { connect } from "cloudflare:sockets";

const enc = new TextEncoder();
const dec = new TextDecoder();
const DOH = "https://1.1.1.1/dns-query";
const DEFAULTS = { addresses: [], port: 443, fp: "chrome", proxyIp: "" };

/* ------------------------------ utils ------------------------------ */
const hex = (u) => [...u].map((x) => x.toString(16).padStart(2, "0")).join("");
const json = (o, s = 200, h = {}) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store", ...h } });
const html = (b, s = 200) => new Response(b, { status: s, headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const safeEq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg))));
}
function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };

// SHA-224 (needed for Trojan; WebCrypto doesn't provide it)
const K256 = (() => { const k = []; let n = 2; while (k.length < 64) { let p = true; for (let d = 2; d * d <= n; d++) if (n % d === 0) { p = false; break; } if (p) k.push(Math.floor((Math.cbrt(n) % 1) * 4294967296)); n++; } return k; })();
function sha224hex(str) {
  const m = enc.encode(str), l = m.length, nb = ((l + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(nb); buf.set(m); buf[l] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(nb - 4, (l * 8) >>> 0); dv.setUint32(nb - 8, Math.floor((l * 8) / 4294967296));
  let H = [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4];
  const w = new Array(64), rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < nb; o += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(o + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + w[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H = [H[0] + a | 0, H[1] + b | 0, H[2] + c | 0, H[3] + d | 0, H[4] + e | 0, H[5] + f | 0, H[6] + g | 0, H[7] + h | 0];
  }
  return H.slice(0, 7).map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

/* --------------------------- storage / auth --------------------------- */
const getSettings = async (env) => ({ ...DEFAULTS, ...((await env.KV.get("settings", { type: "json", cacheTtl: 60 })) || {}) });
const userOk = (u) => u && u.enabled && (!u.expire || u.expire > Date.now());
async function listUsers(env) {
  const l = await env.KV.list({ prefix: "u:", limit: 1000 });
  const us = await Promise.all(l.keys.map((k) => env.KV.get(k.name, { type: "json" })));
  return us.filter(Boolean).sort((a, b) => b.created - a.created);
}
async function isAuthed(req, env) {
  const c = (req.headers.get("cookie") || "").match(/(?:^|;\s*)wp=(\d+)\.([0-9a-f]+)/);
  if (!c || Number(c[1]) < Date.now()) return false;
  return safeEq(c[2], await hmac(env.ADMIN_PASS, c[1]));
}

/* --------------------------- links / subscription --------------------------- */
function buildLinks(u, s, host) {
  const addrs = s.addresses.length ? s.addresses : [host];
  const out = [];
  addrs.forEach((a, i) => {
    for (const proto of ["vless", "trojan"]) {
      const path = encodeURIComponent(`/ws/${proto}/${u.uuid}?ed=2560`);
      const q = `security=tls&sni=${host}&fp=${s.fp}&alpn=http%2F1.1&type=ws&host=${host}&path=${path}`;
      const name = encodeURIComponent(`${u.name}-${proto}${addrs.length > 1 ? "-" + (i + 1) : ""}`);
      const url = proto === "vless"
        ? `vless://${u.uuid}@${a}:${s.port}?encryption=none&${q}#${name}`
        : `trojan://${u.uuid}@${a}:${s.port}?${q}#${name}`;
      out.push({ proto, url });
    }
  });
  return out;
}

/* ------------------------------- router ------------------------------- */
export default {
  async fetch(req, env) {
    try {
      const url = new URL(req.url), p = url.pathname;
      if ((req.headers.get("Upgrade") || "").toLowerCase() === "websocket") return wsEntry(req, env, url);
      if (p.startsWith("/ws/")) return new Response("Expected WebSocket", { status: 426 });
      if (!env.KV || !env.ADMIN_PASS)
        return html(`<meta charset=utf-8><body dir=rtl style="font-family:sans-serif;padding:24px"><h3>تنظیمات ناقص است</h3><p>باید Binding با نام <b>KV</b> و Secret با نام <b>ADMIN_PASS</b> اضافه شود.</p><p>وضعیت: KV ${env.KV ? "✅" : "❌"} | ADMIN_PASS ${env.ADMIN_PASS ? "✅" : "❌"}</p>`, 500);
      if (p === "/") return Response.redirect(url.origin + "/panel", 302);
      if (p === "/panel") return html(PANEL_HTML);
      if (p.startsWith("/sub/")) return sub(env, url, p.slice(5));
      if (p.startsWith("/api/")) return api(req, env, url, p);
      return new Response("Not Found", { status: 404 });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};

async function sub(env, url, id) {
  const u = uuidRe.test(id) ? await env.KV.get("u:" + id, { type: "json" }) : null;
  if (!userOk(u)) return new Response("Forbidden", { status: 403 });
  const links = buildLinks(u, await getSettings(env), url.hostname).map((l) => l.url).join("\n");
  return new Response(btoa(links), {
    headers: {
      "content-type": "text/plain;charset=utf-8",
      "profile-update-interval": "6",
      "subscription-userinfo": `upload=0; download=0; total=0${u.expire ? "; expire=" + Math.floor(u.expire / 1000) : ""}`,
    },
  });
}

async function api(req, env, url, p) {
  if (p === "/api/login" && req.method === "POST") {
    const { password = "" } = await req.json().catch(() => ({}));
    if (!safeEq(await hmac("x", String(password)), await hmac("x", env.ADMIN_PASS))) return json({ error: "رمز اشتباه است" }, 401);
    const exp = String(Date.now() + 7 * 864e5);
    return json({ ok: true }, 200, { "set-cookie": `wp=${exp}.${await hmac(env.ADMIN_PASS, exp)}; Path=/; Max-Age=604800; HttpOnly; Secure; SameSite=Strict` });
  }
  if (!(await isAuthed(req, env))) return json({ error: "unauthorized" }, 401);
  if (req.method !== "GET" && !(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "bad request" }, 400);

  if (p === "/api/logout") return json({ ok: true }, 200, { "set-cookie": "wp=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict" });

  if (p === "/api/state") {
    const s = await getSettings(env), users = await listUsers(env);
    return json({
      host: url.hostname, settings: s,
      users: users.map((u) => ({ ...u, active: !!userOk(u), sub: `${url.origin}/sub/${u.uuid}`, links: buildLinks(u, s, url.hostname) })),
    });
  }
  if (p === "/api/settings" && req.method === "POST") {
    const b = await req.json();
    const addresses = String(b.addresses || "").split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^[A-Za-z0-9.\-:\[\]]+$/.test(x));
    const port = [443, 2053, 2083, 2087, 2096, 8443].includes(Number(b.port)) ? Number(b.port) : 443;
    const fp = ["chrome", "firefox", "safari", "ios", "android", "edge", "random"].includes(b.fp) ? b.fp : "chrome";
    const proxyIp = String(b.proxyIp || "").trim().slice(0, 100);
    await env.KV.put("settings", JSON.stringify({ addresses, port, fp, proxyIp }));
    return json({ ok: true });
  }
  if (p === "/api/user" && req.method === "POST") {
    const b = await req.json();
    const name = String(b.name || "user").replace(/[^\w\u0600-\u06FF\- ]/g, "").trim().slice(0, 30) || "user";
    const days = Math.max(0, parseInt(b.days, 10) || 0);
    const u = { uuid: crypto.randomUUID(), name, enabled: true, created: Date.now(), expire: days ? Date.now() + days * 864e5 : 0 };
    await env.KV.put("u:" + u.uuid, JSON.stringify(u));
    return json({ ok: true });
  }
  const m = p.match(/^\/api\/user\/([0-9a-f-]{36})$/);
  if (m) {
    const key = "u:" + m[1], u = await env.KV.get(key, { type: "json" });
    if (!u) return json({ error: "not found" }, 404);
    if (req.method === "DELETE") { await env.KV.delete(key); return json({ ok: true }); }
    if (req.method === "PATCH") {
      const b = await req.json();
      if (typeof b.enabled === "boolean") u.enabled = b.enabled;
      if (b.days !== undefined) { const d = parseInt(b.days, 10) || 0; u.expire = d > 0 ? Date.now() + d * 864e5 : 0; }
      await env.KV.put(key, JSON.stringify(u));
      return json({ ok: true });
    }
  }
  return json({ error: "not found" }, 404);
}

/* ---------------------------- proxy (WebSocket) ---------------------------- */
async function wsEntry(req, env, url) {
  const seg = url.pathname.split("/").filter(Boolean);
  if (seg[0] !== "ws" || seg.length < 3) return new Response("Not Found", { status: 404 });
  const id = seg[seg.length - 1].toLowerCase(), proto = seg[seg.length - 2];
  if ((proto !== "vless" && proto !== "trojan") || !uuidRe.test(id) || !env.KV) return new Response("Not Found", { status: 404 });
  const user = await env.KV.get("u:" + id, { type: "json", cacheTtl: 60 });
  if (!userOk(user)) return new Response("Forbidden", { status: 403 });

  const pair = new WebSocketPair(), [client, server] = Object.values(pair);
  server.accept();
  const early = req.headers.get("sec-websocket-protocol") || "";
  handleSession(server, proto, user.uuid, early, env).catch(() => closeWs(server));
  return new Response(null, { status: 101, webSocket: client, headers: early ? { "sec-websocket-protocol": early } : {} });
}

const closeWs = (ws) => { try { if (ws.readyState === 1 || ws.readyState === 2) ws.close(); } catch (e) {} };

async function handleSession(ws, proto, uuid, early, env) {
  const readable = new ReadableStream({
    start(c) {
      ws.addEventListener("message", (e) => c.enqueue(e.data));
      ws.addEventListener("close", () => { try { c.close(); } catch (e) {} });
      ws.addEventListener("error", (e) => c.error(e));
      if (early) { try { c.enqueue(b64urlToBytes(early).buffer); } catch (e) {} }
    },
  });
  const trojanHash = proto === "trojan" ? sha224hex(uuid) : "";
  let writer = null, udp = null;

  const open = async (host, port, first, header) => {
    const dial = async (h, pt) => {
      const sock = connect({ hostname: h, port: pt });
      await sock.opened;
      if (writer) { try { writer.releaseLock(); } catch (e) {} }
      writer = sock.writable.getWriter();
      if (first.length) await writer.write(first);
      return sock;
    };
    const pump = async (sock, hdr, canRetry) => {
      let got = false;
      await sock.readable.pipeTo(new WritableStream({
        async write(chunk) {
          got = true;
          if (ws.readyState !== 1) throw new Error("ws closed");
          if (hdr) { ws.send(concat(hdr, new Uint8Array(chunk))); hdr = null; } else ws.send(chunk);
        },
      })).catch(() => {});
      if (!got && canRetry) return retry();
      closeWs(ws);
    };
    const retry = async () => {
      const s = await getSettings(env);
      const pip = (env.PROXY_IP || s.proxyIp || "").trim();
      if (!pip) return closeWs(ws);
      const [h, pt] = pip.split(":");
      try { pump(await dial(h, Number(pt) || port), header, false); } catch (e) { closeWs(ws); }
    };
    try { pump(await dial(host, port), header, true); } catch (e) { await retry(); }
  };

  await readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (udp) return udp(chunk);
      if (writer) return writer.write(chunk);
      const h = proto === "vless" ? parseVless(chunk, uuid) : parseTrojan(chunk, trojanHash);
      if (h.error) throw new Error(h.error);
      if (h.cmd === 2) {
        if (h.port !== 53) throw new Error("udp only dns");
        udp = makeUdp(ws, h.header);
        return udp(h.payload);
      }
      await open(h.addr, h.port, h.payload, h.header);
    },
    close() { },
  })).catch(() => closeWs(ws));
}

function readAddr(u, i, t, domT, v6T) {
  if (t === 1) return { addr: u.slice(i, i + 4).join("."), i: i + 4 };
  if (t === domT) { const l = u[i++]; return { addr: dec.decode(u.slice(i, i + l)), i: i + l }; }
  if (t === v6T) { const x = []; for (let k = 0; k < 8; k++) x.push(((u[i + 2 * k] << 8) | u[i + 2 * k + 1]).toString(16)); return { addr: x.join(":"), i: i + 16 }; }
  return null;
}

function parseVless(b, uuid) {
  const u = new Uint8Array(b);
  if (u.length < 24) return { error: "short" };
  if (hex(u.slice(1, 17)) !== uuid.replace(/-/g, "")) return { error: "uuid" };
  let i = 18 + u[17];
  const cmd = u[i++];
  if (cmd !== 1 && cmd !== 2) return { error: "cmd" };
  const port = (u[i] << 8) | u[i + 1]; i += 2;
  const t = u[i++];
  // vless: 1=ipv4, 2=domain, 3=ipv6
  const r = readAddr(u, i, t, 2, 3);
  if (!r || !r.addr) return { error: "addr" };
  return { cmd, port, addr: r.addr, payload: u.slice(r.i), header: new Uint8Array([u[0], 0]) };
}

function parseTrojan(b, hash) {
  const u = new Uint8Array(b);
  if (u.length < 62 || dec.decode(u.slice(0, 56)) !== hash) return { error: "auth" };
  let i = 58; // skip CRLF
  const cmd = u[i++];
  if (cmd !== 1) return { error: "cmd" };
  const t = u[i++];
  // trojan: 1=ipv4, 3=domain, 4=ipv6
  const r = readAddr(u, i, t, 3, 4);
  if (!r || !r.addr) return { error: "addr" };
  i = r.i;
  const port = (u[i] << 8) | u[i + 1]; i += 2;
  return { cmd: 1, port, addr: r.addr, payload: u.slice(i + 2), header: null };
}

// UDP is supported for DNS only (resolved through DNS-over-HTTPS)
function makeUdp(ws, header) {
  let hdr = header, buf = new Uint8Array(0);
  return async (chunk) => {
    buf = concat(buf, new Uint8Array(chunk));
    while (buf.length >= 2) {
      const len = (buf[0] << 8) | buf[1];
      if (buf.length < 2 + len) break;
      const pkt = buf.slice(2, 2 + len); buf = buf.slice(2 + len);
      const r = await fetch(DOH, { method: "POST", headers: { "content-type": "application/dns-message" }, body: pkt });
      const ans = new Uint8Array(await r.arrayBuffer());
      const out = new Uint8Array((hdr ? hdr.length : 0) + 2 + ans.length);
      let o = 0;
      if (hdr) { out.set(hdr, 0); o = hdr.length; hdr = null; }
      out[o] = ans.length >> 8; out[o + 1] = ans.length & 255; out.set(ans, o + 2);
      if (ws.readyState === 1) ws.send(out);
    }
  };
}

/* ---------------------------------- UI ---------------------------------- */
const PANEL_HTML = `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>CF Config Panel</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0d1020;color:#e8e9f5;font:15px/1.6 Tahoma,Vazirmatn,system-ui,sans-serif}
.w{max-width:720px;margin:0 auto;padding:14px}h1{font-size:18px;margin:6px 0 14px}
.c{background:#171b33;border:1px solid #262c52;border-radius:12px;padding:12px;margin-bottom:12px}
input,select,textarea{width:100%;background:#0d1020;color:#fff;border:1px solid #2d3563;border-radius:8px;padding:9px;font:inherit;margin:4px 0}
button{background:#5b6cff;color:#fff;border:0;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer;margin:3px 0 3px 4px}
button.g{background:#252b52}button.r{background:#c0392b}.row{display:flex;gap:8px}.row>*{flex:1}
.b{font-size:12px;padding:2px 8px;border-radius:99px;background:#1f7a4d}.b.x{background:#8a3b3b}
code{display:block;direction:ltr;text-align:left;word-break:break-all;font-size:11px;background:#0d1020;padding:6px;border-radius:6px;margin:4px 0}
.m{opacity:.7;font-size:12px}
</style></head><body><div class="w" id="app"></div><script>
function h(t,a){var e=document.createElement(t);a=a||{};for(var k in a){if(k==="onclick")e.onclick=a[k];else if(k==="value")e.value=a[k];else e.setAttribute(k,a[k])}
for(var i=2;i<arguments.length;i++){[].concat(arguments[i]).forEach(function(x){if(x!=null&&x!==false)e.append(x)})}return e}
var app=document.getElementById("app");
function api(p,m,b){return fetch(p,{method:m||"GET",headers:{"content-type":"application/json"},body:b?JSON.stringify(b):undefined}).then(function(r){
 if(r.status===401&&p!=="/api/login"){loginView();throw 0}return r.json().then(function(j){if(!r.ok)throw new Error(j.error||"خطا");return j})})}
function copy(t){if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(function(){alert("کپی شد")},function(){prompt("کپی کنید:",t)});else prompt("کپی کنید:",t)}
function err(e){if(e)alert(e.message||e)}
function loginView(){app.replaceChildren(h("h1",0,"ورود به پنل"),h("div",{class:"c"},
 h("input",{id:"pw",type:"password",placeholder:"رمز عبور"}),
 h("button",{onclick:function(){api("/api/login","POST",{password:document.getElementById("pw").value}).then(load).catch(err)}},"ورود")))}
function load(){api("/api/state").then(render).catch(function(e){if(e)err(e)})}
function render(s){
 var nm=h("input",{placeholder:"نام کاربر"}),dy=h("input",{type:"number",placeholder:"مدت (روز) — خالی = نامحدود"});
 var ad=h("textarea",{rows:"3",placeholder:"IP/دامنه تمیز (هر خط یکی) — خالی = خود دامنه ورکر"},s.settings.addresses.join("\\n"));
 var pt=h("select",0,[443,2053,2083,2087,2096,8443].map(function(p){var o=h("option",{value:p},p);if(p===s.settings.port)o.selected=true;return o}));
 var fp=h("select",0,["chrome","firefox","safari","ios","android","edge","random"].map(function(p){var o=h("option",{value:p},p);if(p===s.settings.fp)o.selected=true;return o}));
 var px=h("input",{placeholder:"Proxy IP (اختیاری) مثل 1.2.3.4:443",value:s.settings.proxyIp});
 app.replaceChildren(
  h("h1",0,"CF Config Panel — "+s.host),
  h("div",{class:"c"},h("b",0,"کاربر جدید"),nm,dy,h("button",{onclick:function(){api("/api/user","POST",{name:nm.value,days:dy.value}).then(load).catch(err)}},"ساخت")),
  s.users.map(function(u){
   var box=h("div");
   return h("div",{class:"c"},
    h("div",{class:"row"},h("b",0,u.name),h("span",{class:"b"+(u.active?"":" x")},u.active?"فعال":"غیرفعال")),
    h("div",{class:"m"},u.expire?"انقضا: "+new Date(u.expire).toLocaleDateString("fa-IR"):"بدون انقضا"),
    h("button",{onclick:function(){copy(u.sub)}},"کپی لینک ساب"),
    h("button",{class:"g",onclick:function(){box.hasChildNodes()?box.replaceChildren():box.replaceChildren.apply(box,u.links.map(function(l){return h("div",0,h("code",0,l.url),h("button",{class:"g",onclick:function(){copy(l.url)}},"کپی "+l.proto))}))}},"کانفیگ‌ها"),
    h("button",{class:"g",onclick:function(){api("/api/user/"+u.uuid,"PATCH",{enabled:!u.enabled}).then(load).catch(err)}},u.enabled?"غیرفعال":"فعال"),
    h("button",{class:"g",onclick:function(){var d=prompt("تمدید چند روز؟ (0 = نامحدود)","30");if(d!==null)api("/api/user/"+u.uuid,"PATCH",{days:d}).then(load).catch(err)}},"تمدید"),
    h("button",{class:"r",onclick:function(){if(confirm("حذف شود؟"))api("/api/user/"+u.uuid,"DELETE").then(load).catch(err)}},"حذف"),box)}),
  h("div",{class:"c"},h("b",0,"تنظیمات"),ad,h("div",{class:"row"},pt,fp),px,
   h("button",{onclick:function(){api("/api/settings","POST",{addresses:ad.value,port:pt.value,fp:fp.value,proxyIp:px.value}).then(load).catch(err)}},"ذخیره")),
  h("button",{class:"g",onclick:function(){api("/api/logout","POST",{}).then(loginView)}},"خروج"))}
load();
</script></body></html>`;
