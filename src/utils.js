export function ensureLoggedIn(req, res, next) {
  if (req.session?.user) return next();
  return res.redirect("/");
}
export function ensureAdmin(req, res, next) {
  if (req.session?.user?.role === "admin") return next();
  return res.status(403).send("Admins only");
}

export const ssePool = new Set();
export function pushSse(message) {
  for (const res of ssePool) {
    res.write(`data: ${message}\n\n`);
  }
}

export function parseTweetId(url) {
  if (!url) return null;
  try {
    // contoh: https://x.com/elonmusk/status/1848539495849937921
    const m = url.match(/status\/(\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
