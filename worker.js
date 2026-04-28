const WS_API = "https://webshare.cz/api";

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|webm|m4v)(\?|$)/i;
const AUDIO_EXT = /\.(mp3|flac|wav|aac|m4a|ogg)(\?|$)/i;

let cachedWst = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") return cors(json({ ok: true }));

      if (url.pathname === "/") {
        return cors(json({
          ok: true,
          name: "LechPlay Webshare API",
          endpoints: [
            "/api/search?q=avatar&category=video&offset=0&limit=40",
            "/api/search?q=metallica&category=audio&offset=0&limit=40",
            "/api/search?q=home&category=adult&offset=0&limit=40",
            "/api/my?q=avatar",
            "/api/play?ident=FILE_IDENT",
            "/api/favorites",
            "/api/favorite?ident=FILE_IDENT",
            "/api/login-test",
            "/proxy?url=direct_link"
          ]
        }));
      }

      if (url.pathname === "/api/login-test") {
        cachedWst = null;
        const wst = await getWst(env);
        return cors(json({ ok: true, wstLength: wst.length }));
      }

      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") || "";
        const category = url.searchParams.get("category") || "video";
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 40)));

        return cors(json(await searchPublic(q, category, offset, limit)));
      }

      if (url.pathname === "/api/favorites") {
        return cors(json(await getFavorites(env)));
      }

      if (url.pathname === "/api/favorite") {
        const ident = url.searchParams.get("ident") || "";

        if (request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          return cors(json(await addFavorite(env, body)));
        }

        if (request.method === "DELETE") {
          if (!ident) throw new Error("Missing ident");
          return cors(json(await removeFavorite(env, ident)));
        }

        return cors(json({ error: true, message: "Method not allowed" }, 405));
      }

      if (url.pathname === "/api/my") {
        return cors(json(await searchMyFiles(url.searchParams.get("q") || "", env)));
      }

      if (url.pathname === "/api/play") {
        const ident =
          url.searchParams.get("ident") ||
          identFromUrl(url.searchParams.get("url") || "");

        if (!ident) throw new Error("Missing ident or Webshare URL");

        return cors(json(await playByIdent(ident, env)));
      }

      if (url.pathname === "/proxy") {
        const target = url.searchParams.get("url");
        if (!target) throw new Error("Missing url");
        return proxy(target, request);
      }

      return cors(json({ error: true, message: "Not found" }, 404));

    } catch (e) {
      return cors(json({
        error: true,
        message: e?.message || String(e),
        stack: e?.stack ? String(e.stack).slice(0, 800) : ""
      }, 500));
    }
  }
};

async function getFavorites(env) {
  const store = getFavoritesStore(env);
  const raw = await store.get("items");

  let items = [];
  try {
    items = raw ? JSON.parse(raw) : [];
  } catch (e) {
    items = [];
  }

  if (!Array.isArray(items)) items = [];

  return {
    ok: true,
    source: "cloudflare-kv",
    count: items.length,
    items
  };
}

async function addFavorite(env, item) {
  const store = getFavoritesStore(env);
  const ident = String(item?.ident || "").trim();

  if (!ident) throw new Error("Missing ident");

  const current = await getFavorites(env);
  let items = current.items.filter(x => x && x.ident !== ident);

  const clean = {
    ident,
    title: String(item.title || item.name || "Bez názvu"),
    name: String(item.name || item.title || "Bez názvu"),
    image: String(item.image || item.stripe || ""),
    stripe: String(item.stripe || item.image || ""),
    type: String(item.type || ""),
    size: Number(item.size || 0),
    category: String(item.category || "video"),
    url: String(item.url || ""),
    savedAt: new Date().toISOString()
  };

  items.unshift(clean);
  items = items.slice(0, 500);

  await store.put("items", JSON.stringify(items));

  return {
    ok: true,
    action: "added",
    count: items.length,
    item: clean
  };
}

async function removeFavorite(env, ident) {
  const store = getFavoritesStore(env);

  const current = await getFavorites(env);
  const items = current.items.filter(x => x && x.ident !== ident);

  await store.put("items", JSON.stringify(items));

  return {
    ok: true,
    action: "removed",
    count: items.length,
    ident
  };
}

function getFavoritesStore(env) {
  if (!env.FAVORITES) {
    throw new Error("Missing Cloudflare KV binding FAVORITES");
  }
  return env.FAVORITES;
}

async function searchPublic(q, category = "video", offset = 0, limit = 40) {
  q = String(q || "").trim();
  category = String(category || "video").toLowerCase();
  offset = Math.max(0, Number(offset || 0));
  limit = Math.min(100, Math.max(1, Number(limit || 40)));

  if (!q) {
    return {
      q,
      category,
      webshareCategory: category,
      source: "webshare-public",
      offset,
      limit,
      nextOffset: offset,
      hasMore: false,
      count: 0,
      items: []
    };
  }

  let webshareCategory = "video";

  if (category === "audio") webshareCategory = "audio";
  if (category === "adult") webshareCategory = "adult";
  if (category === "video") webshareCategory = "video";

  const xml = await wsPost("/search/", {
    what: q,
    category: webshareCategory,
    sort: "largest",
    limit: String(limit),
    offset: String(offset)
  });

  let items = parseFiles(xml);

  if (category === "audio") {
    items = items.filter(isAudioItem);
  } else {
    items = items.filter(isVideoItem);
  }

  items = items.map(x => ({
    ...x,
    category
  }));

  return {
    q,
    category,
    webshareCategory,
    source: "webshare-public",
    offset,
    limit,
    nextOffset: offset + limit,
    hasMore: items.length >= limit,
    count: items.length,
    items
  };
}

async function searchMyFiles(q, env) {
  const wst = await getWst(env);

  const xml = await wsPost("/files/", {
    path: "/",
    private: "1",
    search: String(q || "").trim(),
    sort_by: "name",
    sort_order: "asc",
    include_removed: "0",
    limit: "80",
    offset: "0",
    wst
  });

  const items = parseFiles(xml).filter(isVideoItem);

  return {
    q,
    source: "webshare-my-files",
    count: items.length,
    items
  };
}

async function playByIdent(ident, env) {
  let wst = await getWst(env);

  try {
    return await playWithWst(ident, wst, env);
  } catch (e) {
    cachedWst = null;
    wst = await getWst(env);
    return await playWithWst(ident, wst, env);
  }
}

async function playWithWst(ident, wst, env) {
  const info = await fileInfo(ident).catch(() => ({ ident }));

  const xml = await wsPost("/file_link/", {
    ident,
    wst,
    download_type: "file_download",
    force_https: "1"
  });

  const status = tag(xml, "status");
  if (status !== "OK") throw new Error(apiError(xml, "file_link failed"));

  const link = tag(xml, "link");
  if (!link) throw new Error("Webshare did not return link");

  const forceProxy = String(env.WEBSHARE_FORCE_PROXY || "1") === "1";

  return {
    ...info,
    ident,
    videoUrl: forceProxy ? undefined : link,
    proxyUrl: forceProxy ? "/proxy?url=" + encodeURIComponent(link) : undefined,
    directLink: link,
    type: guessType(link, info?.type)
  };
}

async function fileInfo(ident) {
  const xml = await wsPost("/file_info/", { ident });

  const status = tag(xml, "status");
  if (status !== "OK") throw new Error(apiError(xml, "file_info failed"));

  return {
    ident,
    title: tag(xml, "name"),
    name: tag(xml, "name"),
    description: tag(xml, "description"),
    size: Number(tag(xml, "size") || 0),
    type: guessType(tag(xml, "name"), tag(xml, "type")),
    image: tag(xml, "img") || tag(xml, "stripe"),
    available: tag(xml, "available") === "1",
    password: tag(xml, "password") === "1",
    copyrighted: tag(xml, "copyrighted") === "1"
  };
}

async function getWst(env) {
  if (cachedWst) return cachedWst;

  if (!env.WEBSHARE_USERNAME || !env.WEBSHARE_PASSWORD) {
    throw new Error("Missing WEBSHARE_USERNAME or WEBSHARE_PASSWORD");
  }

  const username = String(env.WEBSHARE_USERNAME).trim();
  const password = String(env.WEBSHARE_PASSWORD);

  const saltXml = await wsPost("/salt/", {
    username_or_email: username
  });

  const salt = tag(saltXml, "salt");
  if (!salt) throw new Error("Salt failed: " + saltXml.slice(0, 250));

  const md5Crypted = md5crypt(password, salt);
  const passwordDigest = await sha1(md5Crypted);
  const digest = md5Hex(username + ":Webshare:" + password);

  const loginXml = await wsPost("/login/", {
    username_or_email: username,
    password: passwordDigest,
    digest,
    keep_logged_in: "1"
  });

  const status = tag(loginXml, "status");
  if (status !== "OK") {
    throw new Error("Login failed: " + loginXml.slice(0, 250));
  }

  const wst = tag(loginXml, "wst") || tag(loginXml, "token");
  if (!wst) {
    throw new Error("Login OK but missing WST/token: " + loginXml.slice(0, 250));
  }

  cachedWst = wst;
  return cachedWst;
}

async function proxy(target, request) {
  const safe = new URL(target).href;

  const headers = new Headers();
  headers.set("user-agent", request.headers.get("user-agent") || "Mozilla/5.0");

  const range = request.headers.get("range");
  if (range) headers.set("range", range);

  const upstream = await fetch(safe, {
    method: "GET",
    headers,
    redirect: "follow"
  });

  const h = new Headers(upstream.headers);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Accept-Ranges", "bytes");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: h
  });
}

async function wsPost(path, data) {
  const body = new URLSearchParams();

  for (const [k, v] of Object.entries(data || {})) {
    if (v !== undefined && v !== null && String(v) !== "") {
      body.set(k, String(v));
    }
  }

  const res = await fetch(WS_API + path, {
    method: "POST",
    headers: {
      "Accept": "text/xml; charset=UTF-8",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    },
    body: body.toString()
  });

  const txt = await res.text();

  if (!res.ok) {
    throw new Error("Webshare HTTP " + res.status + ": " + txt.slice(0, 200));
  }

  return txt;
}

function parseFiles(xml) {
  const blocks = [...String(xml || "").matchAll(/<file>([\s\S]*?)<\/file>/gi)].map(m => m[1]);

  return blocks.map(b => ({
    ident: tag(b, "ident"),
    title: tag(b, "name"),
    name: tag(b, "name"),
    type: guessType(tag(b, "name"), tag(b, "type")),
    image: tag(b, "img") || tag(b, "stripe"),
    stripe: tag(b, "stripe"),
    size: Number(tag(b, "size") || 0),
    password: tag(b, "password") === "1",
    queued: tag(b, "queued") === "1",
    positive_votes: Number(tag(b, "positive_votes") || 0),
    negative_votes: Number(tag(b, "negative_votes") || 0),
    url: tag(b, "ident") ? "https://webshare.cz/file/" + tag(b, "ident") : ""
  })).filter(x => x.ident && x.title);
}

function isVideoItem(x) {
  const n = String(x.name || x.title || "").toLowerCase();
  const t = String(x.type || "").toLowerCase();

  return (
    t.includes("video") ||
    ["mkv", "mp4", "avi", "mov", "webm", "m4v"].includes(t) ||
    VIDEO_EXT.test(n)
  );
}

function isAudioItem(x) {
  const n = String(x.name || x.title || "").toLowerCase();
  const t = String(x.type || "").toLowerCase();

  return (
    t.includes("audio") ||
    ["mp3", "flac", "wav", "aac", "m4a", "ogg"].includes(t) ||
    AUDIO_EXT.test(n)
  );
}

function tag(xml, name) {
  const re = new RegExp("<" + name + ">(.*?)<\\/" + name + ">", "is");
  const m = re.exec(xml || "");
  return m ? decodeXml(m[1].trim()) : "";
}

function decodeXml(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function apiError(xml, fallback) {
  return [tag(xml, "code"), tag(xml, "message")].filter(Boolean).join(": ") || fallback;
}

function identFromUrl(u) {
  const s = String(u || "");

  let m = /webshare\.cz\/(?:#\/)?file\/([A-Za-z0-9]+)/i.exec(s);
  if (m) return m[1];

  m = /[?&]ident=([A-Za-z0-9]+)/i.exec(s);
  if (m) return m[1];

  return "";
}

function guessType(link, fallback) {
  const ext =
    (String(link || "").match(/\.([a-z0-9]+)(?:\?|$)/i) || [])[1] ||
    fallback ||
    "video";

  const lower = String(ext).toLowerCase();

  if (lower === "mp4") return "video/mp4";
  if (lower === "webm") return "video/webm";
  if (lower === "mkv") return "video/x-matroska";
  if (lower === "m4v") return "video/mp4";
  if (lower === "avi") return "video/x-msvideo";

  if (lower === "mp3") return "audio/mpeg";
  if (lower === "flac") return "audio/flac";
  if (lower === "wav") return "audio/wav";
  if (lower === "aac") return "audio/aac";
  if (lower === "m4a") return "audio/mp4";
  if (lower === "ogg") return "audio/ogg";

  if (lower.startsWith("video/")) return lower;
  if (lower.startsWith("audio/")) return lower;

  return "video/" + lower;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function cors(resp) {
  const h = new Headers(resp.headers);

  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", "content-type,accept,range");

  return new Response(resp.body, {
    status: resp.status,
    headers: h
  });
}

async function sha1(text) {
  const data = new TextEncoder().encode(String(text || ""));
  const hash = await crypto.subtle.digest("SHA-1", data);

  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function md5Hex(text) {
  return md5Bytes(utf8(String(text || "")))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function md5crypt(password, salt) {
  const magic = "$1$";

  password = String(password || "");
  salt = String(salt || "");

  if (salt.startsWith("$1$")) salt = salt.slice(3);
  salt = salt.split("$")[0].slice(0, 8);

  const pw = utf8(password);
  const sl = utf8(salt);
  const mg = utf8(magic);

  let ctx = [...pw, ...mg, ...sl];
  let alt = md5Bytes([...pw, ...sl, ...pw]);

  for (let i = pw.length; i > 0; i -= 16) {
    ctx.push(...alt.slice(0, Math.min(16, i)));
  }

  for (let i = pw.length; i > 0; i >>= 1) {
    ctx.push(i & 1 ? 0 : pw[0]);
  }

  let final = md5Bytes(ctx);

  for (let i = 0; i < 1000; i++) {
    let ctx2 = [];

    if (i & 1) ctx2.push(...pw);
    else ctx2.push(...final);

    if (i % 3) ctx2.push(...sl);
    if (i % 7) ctx2.push(...pw);

    if (i & 1) ctx2.push(...final);
    else ctx2.push(...pw);

    final = md5Bytes(ctx2);
  }

  return magic + salt + "$" +
    to64((final[0] << 16) | (final[6] << 8) | final[12], 4) +
    to64((final[1] << 16) | (final[7] << 8) | final[13], 4) +
    to64((final[2] << 16) | (final[8] << 8) | final[14], 4) +
    to64((final[3] << 16) | (final[9] << 8) | final[15], 4) +
    to64((final[4] << 16) | (final[10] << 8) | final[5], 4) +
    to64(final[11], 2);
}

function to64(v, n) {
  const chars = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let s = "";

  while (n-- > 0) {
    s += chars[v & 0x3f];
    v >>>= 6;
  }

  return s;
}

function utf8(s) {
  return Array.from(new TextEncoder().encode(String(s)));
}

function md5Bytes(input) {
  const msg = input.slice();
  const bitLen = msg.length * 8;

  msg.push(0x80);

  while (msg.length % 64 !== 56) {
    msg.push(0);
  }

  let len = BigInt(bitLen);

  for (let i = 0; i < 8; i++) {
    msg.push(Number((len >> BigInt(8 * i)) & 0xffn));
  }

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const s = [
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5,9,14,20, 5,9,14,20, 5,9,14,20, 5,9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21
  ];

  const K = [];

  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }

  for (let off = 0; off < msg.length; off += 64) {
    const M = [];

    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] =
        (msg[j] |
        (msg[j + 1] << 8) |
        (msg[j + 2] << 16) |
        (msg[j + 3] << 24)) >>> 0;
    }

    let A = a;
    let B = b;
    let C = c;
    let D = d;

    for (let i = 0; i < 64; i++) {
      let F;
      let g;

      if (i < 16) {
        F = (B & C) | ((~B) & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | ((~D) & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | (~D));
        g = (7 * i) % 16;
      }

      F = add32(add32(add32(F, A), K[i]), M[g]);

      A = D;
      D = C;
      C = B;
      B = add32(B, rotl(F, s[i]));
    }

    a = add32(a, A);
    b = add32(b, B);
    c = add32(c, C);
    d = add32(d, D);
  }

  const out = [];

  for (const w of [a, b, c, d]) {
    out.push(
      w & 255,
      (w >>> 8) & 255,
      (w >>> 16) & 255,
      (w >>> 24) & 255
    );
  }

  return out;
}

function add32(x, y) {
  return (x + y) >>> 0;
}

function rotl(x, n) {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}
