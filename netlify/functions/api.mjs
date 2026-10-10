import { getStore } from "@netlify/blobs";

const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const PRICES = { Standard: { week: 1.49, month: 2.49, life: 5 }, Pro: { week: 6.49, month: 8.99, life: 12 }, VIP: { month: 14.99, life: 25 } };
const DUR = { week: "1 Week", month: "1 Month", life: "Lifetime" };
const STATES = ["online", "updating", "maintenance"];
const GSTAT = ["supported", "patched", "updating", "implementing"];

async function who(req) {
  const t = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (!t) return null;
  const r = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + t } });
  return r.ok ? r.json() : null;
}

// Has this Discord user ever placed an order? (cached in a small "buyers" store)
async function hasOrder(uid) {
  const buyers = getStore("buyers");
  if (await buyers.get(uid)) return true;
  const { blobs } = await getStore("orders").list();
  const hit = blobs.some((b) => b.key.endsWith("-" + uid));
  if (hit) await buyers.set(uid, "1");
  return hit;
}

export default async (req) => {
  const a = new URL(req.url).searchParams.get("a");
  const settings = getStore("settings");
  const orders = getStore("orders");

  // Public: site status
  if (a === "status") {
    return J((await settings.get("status", { type: "json" })) || { state: "online", message: "" });
  }

  // Public: supported games list
  if (a === "games") {
    return J((await settings.get("games", { type: "json" })) || []);
  }

  // Public: reviews (everyone sees the same list)
  if (a === "reviews") {
    const store = getStore("reviews");
    const { blobs } = await store.list();
    const all = (await Promise.all(blobs.map((x) => store.get(x.key, { type: "json" })))).filter(Boolean);
    all.sort((x, y) => y.time - x.time);
    return J(all.slice(0, 200));
  }

  const u = await who(req);
  if (!u) return J({ error: "login required" }, 401);
  const isAdmin = u.id === process.env.ADMIN_ID;

  // Logged-in users: place an order
  if (a === "order" && req.method === "POST") {
    const b = await req.json();
    const price = PRICES[b.plan]?.[b.dur];
    if (price === undefined) return J({ error: "invalid plan" }, 400);
    const order = {
      id: Date.now() + "-" + u.id, time: Date.now(), userId: u.id, username: u.username,
      plan: b.plan, dur: b.dur, price, method: String(b.method || "").slice(0, 60), note: String(b.note || "").slice(0, 900)
    };
    await orders.setJSON(order.id, order);
    await getStore("buyers").set(u.id, "1");
    if (process.env.DISCORD_WEBHOOK) {
      await fetch(process.env.DISCORD_WEBHOOK, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "KoSMO Hub Orders", embeds: [{
          title: "🛒 New order", color: 0x8b5cf6, timestamp: new Date().toISOString(),
          fields: [
            { name: "Discord user", value: `${u.username} (<@${u.id}>)`, inline: true },
            { name: "Discord ID", value: u.id, inline: true },
            { name: "Plan", value: `${order.plan} · ${DUR[order.dur]}`, inline: true },
            { name: "Price", value: `$${price.toFixed(2)}`, inline: true },
            { name: "Payment method", value: order.method || "—", inline: true },
            { name: "Notes", value: order.note || "—" }
          ] }] })
      }).catch(() => {});
    }
    return J({ ok: true });
  }

  // Logged-in users: can I review, and what did I write?
  if (a === "myreview") {
    return J({
      canReview: await hasOrder(u.id),
      review: (await getStore("reviews").get(u.id, { type: "json" })) || null
    });
  }

  // Logged-in buyers: write or update their review (one per user)
  if (a === "review" && req.method === "POST") {
    if (!(await hasOrder(u.id))) return J({ error: "Place an order first to leave a review" }, 403);
    const b = await req.json();
    const rating = Number(b.rating);
    const text = String(b.text || "").trim().slice(0, 500);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return J({ error: "Pick 1 to 5 stars" }, 400);
    if (text.length < 3) return J({ error: "Write a short review" }, 400);
    const avatar = u.avatar && /^[a-zA-Z0-9_]+$/.test(u.avatar)
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : "";
    await getStore("reviews").setJSON(u.id, {
      id: u.id, name: String(u.global_name || u.username).slice(0, 40), avatar, rating, text, time: Date.now()
    });
    return J({ ok: true });
  }

  // Admin only
  if (!isAdmin) return J({ error: "forbidden" }, 403);

  if (a === "orders") {
    const { blobs } = await orders.list();
    const all = await Promise.all(blobs.map((x) => orders.get(x.key, { type: "json" })));
    return J(all.filter(Boolean).sort((x, y) => y.time - x.time).slice(0, 100));
  }

  if (a === "delreview" && req.method === "POST") {
    const b = await req.json();
    await getStore("reviews").delete(String(b.id || ""));
    return J({ ok: true });
  }

  if (a === "setstatus" && req.method === "POST") {
    const b = await req.json();
    if (!STATES.includes(b.state)) return J({ error: "invalid state" }, 400);
    await settings.setJSON("status", { state: b.state, message: String(b.message || "").slice(0, 120), time: Date.now() });
    return J({ ok: true });
  }

  if (a === "savegames" && req.method === "POST") {
    const b = await req.json();
    if (!Array.isArray(b.games) || b.games.length > 60) return J({ error: "invalid list" }, 400);
    const clean = [];
    for (const g of b.games) {
      const name = String(g.name || "").trim().slice(0, 60);
      const logo = String(g.logo || "").trim().slice(0, 500);
      if (!name || !GSTAT.includes(g.status)) return J({ error: "invalid game" }, 400);
      if (logo && !/^(https:\/\/|\/)/.test(logo)) return J({ error: "logo must be an https link" }, 400);
      clean.push({ name, logo, status: g.status });
    }
    await settings.setJSON("games", clean);
    return J({ ok: true });
  }

  return J({ error: "bad request" }, 400);
};

export const config = { path: "/api" };
