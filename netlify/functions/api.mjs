import { getStore } from "@netlify/blobs";

const J = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
const PRICES = { Standard: { week: 1.49, month: 2.49, life: 5 }, Pro: { week: 6.49, month: 8.99, life: 12 }, VIP: { month: 14.99, life: 25 } };
const DUR = { week: "1 Week", month: "1 Month", life: "Lifetime" };
const STATES = ["online", "updating", "maintenance"];

async function who(req) {
  const t = (req.headers.get("authorization") || "").replace("Bearer ", "");
  if (!t) return null;
  const r = await fetch("https://discord.com/api/users/@me", { headers: { Authorization: "Bearer " + t } });
  return r.ok ? r.json() : null;
}

export default async (req) => {
  const a = new URL(req.url).searchParams.get("a");
  const settings = getStore("settings");
  const orders = getStore("orders");

  // Public: site status
  if (a === "status") {
    return J((await settings.get("status", { type: "json" })) || { state: "online", message: "" });
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

  // Admin only
  if (!isAdmin) return J({ error: "forbidden" }, 403);

  if (a === "orders") {
    const { blobs } = await orders.list();
    const all = await Promise.all(blobs.map((x) => orders.get(x.key, { type: "json" })));
    return J(all.filter(Boolean).sort((x, y) => y.time - x.time).slice(0, 100));
  }

  if (a === "setstatus" && req.method === "POST") {
    const b = await req.json();
    if (!STATES.includes(b.state)) return J({ error: "invalid state" }, 400);
    await settings.setJSON("status", { state: b.state, message: String(b.message || "").slice(0, 120), time: Date.now() });
    return J({ ok: true });
  }

  return J({ error: "bad request" }, 400);
};

export const config = { path: "/api" };
