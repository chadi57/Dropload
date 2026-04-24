import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import cors from "cors";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import dotenv from "dotenv";

dotenv.config();

const execAsync = promisify(exec);
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ───────────────────────────────────────────────────────────────────
const SECRET_KEY      = process.env.JWT_SECRET || (() => { throw new Error("JWT_SECRET manquant dans .env"); })();
const MAX_FILE_MB     = parseInt(process.env.MAX_FILE_MB || "500");
const PORT            = process.env.PORT || 3000;

// ─── Middlewares ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: "Trop de requêtes. Réessayez dans 15 min." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", limiter);

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Max 5 téléchargements par minute." },
});
app.use("/api/download", downloadLimiter);

// ─── Tmp dir ──────────────────────────────────────────────────────────────────
const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// Nettoyage auto toutes les 5 min (fichiers > 10 min)
setInterval(() => {
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(TMP_DIR)) {
      const fp = path.join(TMP_DIR, f);
      try { if (now - fs.statSync(fp).mtimeMs > 600_000) fs.unlinkSync(fp); } catch {}
    }
  } catch {}
}, 300_000);

// ─── Format map ───────────────────────────────────────────────────────────────
const FORMAT_MAP = {
  "mp3":   { ytdlp: "bestaudio/b",                                              ext: "mp3", audioOnly: true,  locked: false },
  "360p":  { ytdlp: "bestvideo[height<=360]+bestaudio/b[height<=360]/b",        ext: "mp4", audioOnly: false, locked: false },
  "480p":  { ytdlp: "bestvideo[height<=480]+bestaudio/b[height<=480]/b",        ext: "mp4", audioOnly: false, locked: false },
  "720p":  { ytdlp: "bestvideo[height<=720]+bestaudio/b[height<=720]/b",        ext: "mp4", audioOnly: false, locked: false },
  "1080p": { ytdlp: "bestvideo[height<=1080]+bestaudio/b[height<=1080]/b",      ext: "mp4", audioOnly: false, locked: true  },
  "1440p": { ytdlp: "bestvideo[height<=1440]+bestaudio/b[height<=1440]/b",      ext: "mp4", audioOnly: false, locked: true  },
  "4K":    { ytdlp: "bestvideo[height<=2160]+bestaudio/b[height<=2160]/b",      ext: "mp4", audioOnly: false, locked: true  },
};

// ─── Allowed domains ──────────────────────────────────────────────────────────
const ALLOWED_DOMAINS = [
  "youtube.com", "youtu.be",
  "tiktok.com",
  "twitter.com", "x.com",
  "instagram.com",
  "twitch.tv",
  "reddit.com", "v.redd.it",
];

function isUrlAllowed(url) {
  try {
    const { hostname } = new URL(url);
    return ALLOWED_DOMAINS.some(d => hostname === d || hostname.endsWith("." + d));
  } catch { return false; }
}

function sanitizeUrl(url) {
  if (!url || typeof url !== "string") return null;
  // Keep only the first URL-like token (users often paste "URL : error msg")
  let cleaned = url.trim().split(/\s+/)[0] || "";
  // Strip trailing punctuation that can break video IDs (":", ".", ",", "!" etc.)
  cleaned = cleaned.replace(/[)\]}>,.?!:;]+$/g, "");
  try { new URL(cleaned); } catch { return null; }
  return cleaned.replace(/[`$\\|;&<>(){}[\]!#'"]/g, "");
}

// ─── POST /api/fetch-info ─────────────────────────────────────────────────────
app.post("/api/fetch-info", async (req, res) => {
  const { url } = req.body;
  if (!url || !isUrlAllowed(url)) {
    return res.status(400).json({ error: "URL non supportée ou invalide." });
  }

  const safeUrl = sanitizeUrl(url);
  if (!safeUrl) return res.status(400).json({ error: "URL invalide." });

  try {
    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-playlist --quiet "${safeUrl}"`,
      { timeout: 25_000 }
    );
    const info = JSON.parse(stdout);

    // Calcul qualités disponibles
    const heights = new Set((info.formats || []).map(f => f.height).filter(Boolean));
    const maxH = heights.size > 0 ? Math.max(...heights) : 720;
    const qualities = ["mp3"];
    if (maxH >= 1)    qualities.push("360p");
    if (maxH >= 480)  qualities.push("480p");
    if (maxH >= 720)  qualities.push("720p");
    if (maxH >= 1080) qualities.push("1080p");
    if (maxH >= 1440) qualities.push("1440p");
    if (maxH >= 2160) qualities.push("4K");

    const title = info.title || (info.description || "").slice(0, 80) || info.uploader || "Unknown";

    res.json({
      title,
      thumbnail: info.thumbnail || null,
      duration:  info.duration  || 0,
      platform:  info.extractor_key || "Unknown",
      availableQualities: qualities,
    });
  } catch (err) {
    console.error("fetch-info:", err.message);
    res.status(500).json({ error: "Impossible d'analyser la vidéo. Vérifiez le lien." });
  }
});

// ─── POST /api/unlock-hd ──────────────────────────────────────────────────────
app.post("/api/unlock-hd", (req, res) => {
  const token = jwt.sign({ unlocked: true }, SECRET_KEY, { expiresIn: "15m" });
  res.json({ token });
});

// ─── POST /api/download ───────────────────────────────────────────────────────
// Utilise SSE pour streamer la progression, puis envoie le fichier en base64
app.get("/api/download", async (req, res) => {
  const { url, quality, hdToken } = req.query;

  // Validation
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl || !isUrlAllowed(safeUrl)) {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ type: "error", msg: "URL invalide ou non supportée." })}\n\n`);
    return res.end();
  }

  const fmt = FORMAT_MAP[quality];
  if (!fmt) {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ type: "error", msg: "Qualité invalide." })}\n\n`);
    return res.end();
  }

  // Vérif token HD (JWT)
  if (fmt.locked) {
    try { jwt.verify(hdToken, SECRET_KEY); }
    catch {
      res.setHeader("Content-Type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ type: "error", msg: "HD bloquée ou token expiré." })}\n\n`);
      return res.end();
    }
  }

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const tmpFile = path.join(TMP_DIR, `dl_${tmpId}.${fmt.ext}`);

  try {
    send({ type: "progress", pct: 5, msg: "Démarrage…" });

    // Commande yt-dlp
    const cmd = fmt.audioOnly
      ? `yt-dlp -f "${fmt.ytdlp}" --extract-audio --audio-format mp3 --audio-quality 0 --no-playlist -o "${tmpFile}" "${safeUrl}"`
      : `yt-dlp -f "${fmt.ytdlp}" --merge-output-format mp4 --no-playlist -o "${tmpFile}" "${safeUrl}"`;

    await new Promise((resolve, reject) => {
      const proc = exec(cmd, { timeout: 5 * 60 * 1000 });
      let lastPct = 5;

      const onData = (chunk) => {
        const match = chunk.toString().match(/(\d+\.?\d*)%/);
        if (match) {
          const pct = Math.min(Math.round(parseFloat(match[1])), 95);
          if (pct > lastPct) { lastPct = pct; send({ type: "progress", pct, msg: `Téléchargement… ${pct}%` }); }
        }
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("close", code => code === 0 ? resolve() : reject(new Error(`yt-dlp code ${code}`)));
      proc.on("error", reject);
    });

    // Résolution du fichier final (mp3 peut changer d'extension)
    let actualFile = tmpFile;
    if (fmt.audioOnly && !fs.existsSync(tmpFile)) {
      const alt = tmpFile.replace(/\.\w+$/, ".mp3");
      if (fs.existsSync(alt)) actualFile = alt;
    }

    if (!fs.existsSync(actualFile)) {
      send({ type: "error", msg: "Fichier introuvable après traitement." });
      return res.end();
    }

    // Vérif taille
    const sizeMB = fs.statSync(actualFile).size / 1_048_576;
    if (sizeMB > MAX_FILE_MB) {
      fs.unlink(actualFile, () => {});
      send({ type: "error", msg: `Fichier trop volumineux (${Math.round(sizeMB)}MB). Max: ${MAX_FILE_MB}MB.` });
      return res.end();
    }

    send({ type: "progress", pct: 98, msg: "Préparation…" });

    const b64      = fs.readFileSync(actualFile).toString("base64");
    const mime     = fmt.audioOnly ? "audio/mpeg" : "video/mp4";
    const filename = `dropload_${quality}.${fmt.ext}`;

    send({ type: "done", b64, mime, filename });
    fs.unlink(actualFile, () => {});

  } catch (err) {
    console.error("download:", err.message);
    if (fs.existsSync(tmpFile)) fs.unlink(tmpFile, () => {});
    send({ type: "error", msg: err.message.split("\n")[0] });
  }

  res.end();
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`dropload running → http://localhost:${PORT}`));
