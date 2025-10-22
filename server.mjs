import express from "express";
import session from "express-session";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import expressLayouts from "express-ejs-layouts";
import { fileURLToPath } from "url";
import { sequelize, User, Log, Setting, initDb } from "./src/db.js";
import { ensureAdmin, ensureLoggedIn, ssePool, pushSse, parseTweetId, sleep } from "./src/utils.js";

dotenv.config();
const {
  PORT = 3000,
  BASE_URL = "http://localhost:3000",
  X_CLIENT_ID,
  X_REDIRECT_URI = `${BASE_URL}/callback`,
  X_SCOPES = "tweet.read tweet.write users.read offline.access",
  SESSION_SECRET = "change-this-super-secret"
} = process.env;

if (!X_CLIENT_ID) {
  console.error("❌ Missing X_CLIENT_ID in .env");
  process.exit(1);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // set true jika HTTPS + proxy trust
}));
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(expressLayouts);
app.set("layout", "layout");
app.use(express.static(path.join(__dirname, "public")));

// ===== Helpers PKCE =====
function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function generatePKCE() {
  const code_verifier = base64url(crypto.randomBytes(32));
  const challenge = crypto.createHash('sha256').update(code_verifier).digest();
  const code_challenge = base64url(challenge);
  return { code_verifier, code_challenge };
}

// ===== OAuth Routes =====
app.get("/", async (req, res) => {
  const me = req.session.user || null;
  res.render("index", { me });
});

app.get("/login", async (req, res) => {
  const { code_verifier, code_challenge } = generatePKCE();
  req.session.code_verifier = code_verifier;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: X_CLIENT_ID,
    redirect_uri: X_REDIRECT_URI,
    scope: X_SCOPES,
    state: "st_"+crypto.randomBytes(6).toString("hex"),
    code_challenge,
    code_challenge_method: "S256"
  }).toString();

  res.redirect(`https://twitter.com/i/oauth2/authorize?${params}`);
});

app.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing code");

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: X_CLIENT_ID,
      redirect_uri: X_REDIRECT_URI,
      code: String(code),
      code_verifier: req.session.code_verifier
    }).toString();

    const tok = await axios.post("https://api.twitter.com/2/oauth2/token", body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    const { access_token, refresh_token, expires_in, token_type, scope } = tok.data;

    // who am i
    const meRes = await axios.get("https://api.twitter.com/2/users/me", {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const me = meRes.data?.data;

    // upsert user into DB
    const [user, created] = await User.findOrCreate({
      where: { x_user_id: me.id },
      defaults: {
        username: me.username,
        name: me.name || null,
        access_token,
        refresh_token,
        token_type,
        scope,
        expires_at: new Date(Date.now() + (expires_in * 1000)),
        role: "user"
      }
    });

    if (!created) {
      // update tokens
      user.username = me.username;
      user.name = me.name || null;
      user.access_token = access_token;
      user.refresh_token = refresh_token || user.refresh_token;
      user.token_type = token_type;
      user.scope = scope;
      user.expires_at = new Date(Date.now() + (expires_in * 1000));
      await user.save();
    }

    // Promote first user to admin if none exists
    const adminExists = await User.findOne({ where: { role: "admin" } });
    if (!adminExists) {
      user.role = "admin";
      await user.save();
    }

    req.session.user = { id: user.id, x_user_id: user.x_user_id, username: user.username, role: user.role };
    res.redirect("/admin");
  } catch (e) {
    console.error("Callback error:", e.response?.data || e.message);
    res.status(500).send("OAuth token exchange failed");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ===== Admin Pages =====
app.get("/admin", ensureLoggedIn, ensureAdmin, async (req, res) => {
  const users = await User.findAll({ order: [["createdAt", "ASC"]] });
  const delaySetting = await Setting.findByPk("broadcast_delay_sec");
  const delay = delaySetting ? delaySetting.value : "30";
  res.render("admin", { users, me: req.session.user, delayDefault: delay });
});

// Live logs via SSE
app.get("/admin/logs/stream", ensureLoggedIn, ensureAdmin, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  res.write(`retry: 2000\n\n`);
  ssePool.add(res);
  req.on("close", () => ssePool.delete(res));
});

// Settings (update delay)
app.post("/admin/settings", ensureLoggedIn, ensureAdmin, async (req, res) => {
  const { broadcast_delay_sec } = req.body;
  await Setting.upsert({ key: "broadcast_delay_sec", value: String(broadcast_delay_sec || "30") });
  res.redirect("/admin");
});

// ===== API helpers (refresh token) =====
async function refreshAccessToken(user) {
  if (!user.refresh_token) return user;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: X_CLIENT_ID,
      refresh_token: user.refresh_token
    }).toString();
    const r = await axios.post("https://api.twitter.com/2/oauth2/token", body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" }
    });
    user.access_token = r.data.access_token;
    if (r.data.refresh_token) user.refresh_token = r.data.refresh_token;
    user.expires_at = new Date(Date.now() + (r.data.expires_in * 1000));
    await user.save();
    return user;
  } catch (e) {
    await Log.create({ username: user.username, action: "refresh", tweet_id: null, status: "fail", note: e.response?.data?.error || e.message });
    pushSse(`[${user.username}] refresh ❌`);
    return user; // keep old token; opsional: tandai disabled
  }
}

function isExpired(user) {
  return !user.expires_at || new Date(user.expires_at).getTime() < Date.now() + 60_000;
}

// ===== X API Actions =====
async function doLike(user, tweet_id) {
  const url = `https://api.twitter.com/2/users/${user.x_user_id}/likes`;
  const r = await axios.post(url, { tweet_id }, {
    headers: { Authorization: `Bearer ${user.access_token}` }
  });
  return r.data;
}
async function doRetweet(user, tweet_id) {
  const url = `https://api.twitter.com/2/users/${user.x_user_id}/retweets`;
  const r = await axios.post(url, { tweet_id }, {
    headers: { Authorization: `Bearer ${user.access_token}` }
  });
  return r.data;
}
async function doReply(user, tweet_id, text) {
  const url = `https://api.twitter.com/2/tweets`;
  const body = { text, reply: { in_reply_to_tweet_id: tweet_id } };
  const r = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${user.access_token}`, "Content-Type": "application/json" }
  });
  return r.data;
}

// ===== Broadcast (Bulk) =====
let broadcasting = false;

app.post("/admin/broadcast", ensureLoggedIn, ensureAdmin, async (req, res) => {
  const { tweet_url, comment, delay_sec } = req.body;
  const id = parseTweetId(tweet_url);
  if (!id) return res.status(400).send("Tweet URL tidak valid");

  if (broadcasting) return res.status(409).send("Broadcast sedang berjalan");

  const delaySetting = await Setting.findByPk("broadcast_delay_sec");
  const delay = Number(delay_sec || (delaySetting?.value ?? 30));

  broadcasting = true;
  pushSse(`🚀 Broadcast start: tweet ${id}, delay ${delay}s`);
  res.redirect("/admin"); // segera kembali, proses lanjut di background (dalam request ini)

  ;(async () => {
    try {
      const users = await User.findAll({ order: [["createdAt","ASC"]] });
      for (const user of users) {
        try {
          // refresh if expired
          if (isExpired(user)) await refreshAccessToken(user);

          // Like
          try {
            await doLike(user, id);
            await Log.create({ username: user.username, action: "like", tweet_id: id, status: "ok" });
            pushSse(`[${user.username}] like ✅`);
          } catch (e) {
            await Log.create({ username: user.username, action: "like", tweet_id: id, status: "fail", note: e.response?.data?.title || e.message });
            pushSse(`[${user.username}] like ❌`);
          }

          await sleep(3000);

          // Retweet
          try {
            await doRetweet(user, id);
            await Log.create({ username: user.username, action: "retweet", tweet_id: id, status: "ok" });
            pushSse(`[${user.username}] retweet ✅`);
          } catch (e) {
            await Log.create({ username: user.username, action: "retweet", tweet_id: id, status: "fail", note: e.response?.data?.title || e.message });
            pushSse(`[${user.username}] retweet ❌`);
          }

          await sleep(3000);

          // Reply
          if (comment && comment.trim().length > 0) {
            try {
              await doReply(user, id, comment);
              await Log.create({ username: user.username, action: "reply", tweet_id: id, status: "ok" });
              pushSse(`[${user.username}] reply ✅`);
            } catch (e) {
              await Log.create({ username: user.username, action: "reply", tweet_id: id, status: "fail", note: e.response?.data?.title || e.message });
              pushSse(`[${user.username}] reply ❌`);
            }
          }

          // Delay antar user
          await sleep(delay * 1000);

        } catch (e) {
          pushSse(`[${user.username}] error: ${e.message}`);
          await Log.create({ username: user.username, action: "error", tweet_id: id, status: "fail", note: e.message });
        }
      }
      pushSse(`✅ Broadcast finished`);
    } catch (e) {
      pushSse(`❌ Broadcast failed: ${e.message}`);
    } finally {
      broadcasting = false;
    }
  })();
});

// ===== Logs page (JSON) =====
app.get("/admin/logs", ensureLoggedIn, ensureAdmin, async (req, res) => {
  const logs = await Log.findAll({ order: [["createdAt","DESC"]], limit: 200 });
  res.json(logs);
});

// ===== Start =====
await initDb();
app.listen(PORT, () => console.log(`✅ Server running at ${BASE_URL} (PORT ${PORT})`));
