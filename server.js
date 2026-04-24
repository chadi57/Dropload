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

// ─── Video quality (height cap + HD lock) ────────────────────────────────────
const VIDEO_QUALITY = {
  "360p":  { height: 360,  locked: false },
  "480p":  { height: 480,  locked: false },
  "720p":  { height: 720,  locked: false },
  "1080p": { height: 1080, locked: true },
  "1440p": { height: 1440, locked: true },
  "4K":    { height: 2160, locked: true },
};

const AUDIO_MP3 = {
  ytdlp: "bestaudio/b",
  ext: "mp3",
  audioOnly: true,
  locked: false,
};

/** @param {number} h @param {'mp4'|'webm'} container @param {'both'|'video'} audioMode */
function buildVideoFormatSelector(h, container, audioMode) {
  if (audioMode === "video") {
    if (container === "webm") {
      return `bestvideo[height<=${h}][ext=webm]/bestvideo[height<=${h}]/bv*[height<=${h}]/b`;
    }
    return `bestvideo[height<=${h}][ext=mp4]/bestvideo[height<=${h}]/bv*[height<=${h}]/b`;
  }
  if (container === "webm") {
    // VP9 + Opus in webm first; then generic webm; then any + audio (may need mkv merge fallback in download).
    return `(bv*[height<=${h}][vcodec^=vp9]+ba[acodec^=opus])/(bv*[height<=${h}][ext=webm]+ba[ext=webm])/bv*[height<=${h}]+ba/b`;
  }
  return `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${h}]+bestaudio/b`;
}

function resolveYtDlpOutputPath(tmpDir, tmpId) {
  const prefix = `dl_${tmpId}.`;
  try {
    const names = fs.readdirSync(tmpDir).filter(
      (f) => f.startsWith(prefix) && !f.endsWith(".part") && !f.endsWith(".ytdl")
    );
    if (names.length === 0) return null;
    names.sort();
    return path.join(tmpDir, names[names.length - 1]);
  } catch {
    return null;
  }
}

function cleanupYtDlpArtifacts(tmpDir, tmpId) {
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (f.startsWith(`dl_${tmpId}.`)) {
        try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
      }
    }
  } catch {}
}


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
  let container = String(req.query.container || "mp4").toLowerCase();
  if (container !== "mp4" && container !== "webm") container = "mp4";
  let audioMode = String(req.query.audioMode || "both").toLowerCase();
  if (!["both", "video", "audio"].includes(audioMode)) audioMode = "both";

  // Validation
  const safeUrl = sanitizeUrl(url);
  if (!safeUrl || !isUrlAllowed(safeUrl)) {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ type: "error", msg: "URL invalide ou non supportée." })}\n\n`);
    return res.end();
  }

  const isMp3 = quality === "mp3";
  const vq = !isMp3 ? VIDEO_QUALITY[quality] : null;
  if (!isMp3 && !vq) {
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ type: "error", msg: "Qualité invalide." })}\n\n`);
    return res.end();
  }

  const locked = isMp3 ? AUDIO_MP3.locked : vq.locked;

  // Vérif token HD (JWT)
  if (locked) {
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
  const tmpFileMp3 = path.join(TMP_DIR, `dl_${tmpId}.mp3`);
  const outTemplate = path.join(TMP_DIR, `dl_${tmpId}.%(ext)s`);

  const runYtDlp = (cmd) =>
    new Promise((resolve, reject) => {
      const proc = exec(cmd, { timeout: 5 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
      let lastPct = 5;
      let stderrBuf = "";

      const onData = (chunk) => {
        const s = chunk.toString();
        stderrBuf += s;
        const match = s.match(/(\d+\.?\d*)%/);
        if (match) {
          const pct = Math.min(Math.round(parseFloat(match[1])), 95);
          if (pct > lastPct) { lastPct = pct; send({ type: "progress", pct, msg: `Téléchargement… ${pct}%` }); }
        }
      };

      proc.stdout.on("data", onData);
      proc.stderr.on("data", onData);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else {
          const tail = stderrBuf.split(/\r?\n/).filter(Boolean).slice(-5).join(" — ");
          reject(new Error(tail || `yt-dlp code ${code}`));
        }
      });
      proc.on("error", reject);
    });

  try {
    send({ type: "progress", pct: 5, msg: "Démarrage…" });

    if (isMp3) {
      const cmd = `yt-dlp -f "${AUDIO_MP3.ytdlp}" --extract-audio --audio-format mp3 --audio-quality 0 --no-playlist -o "${tmpFileMp3}" "${safeUrl}"`;
      await runYtDlp(cmd);
    } else {
      const videoAudioMode = audioMode === "video" ? "video" : "both";
      const formatStr = buildVideoFormatSelector(vq.height, container, videoAudioMode);
      const mergeOutput = videoAudioMode === "video" ? "" : (container === "webm" ? " --merge-output-format webm" : " --merge-output-format mp4");
      let cmd = `yt-dlp -f "${formatStr}"${mergeOutput} --no-playlist -o "${outTemplate}" "${safeUrl}"`;

      try {
        await runYtDlp(cmd);
      } catch (e1) {
        if (container === "webm" && videoAudioMode === "both") {
          cmd = `yt-dlp -f "${formatStr}" --merge-output-format mkv --no-playlist -o "${outTemplate}" "${safeUrl}"`;
          await runYtDlp(cmd);
        } else {
          throw e1;
        }
      }
    }

    let actualFile = isMp3 ? tmpFileMp3 : resolveYtDlpOutputPath(TMP_DIR, tmpId);
    if (isMp3 && (!actualFile || !fs.existsSync(actualFile))) {
      const alt = tmpFileMp3.replace(/\.\w+$/, ".mp3");
      if (fs.existsSync(alt)) actualFile = alt;
    }

    let outExt = "mp4";
    let mime = "video/mp4";
    if (isMp3) {
      outExt = "mp3";
      mime = "audio/mpeg";
    } else if (actualFile && fs.existsSync(actualFile)) {
      const ext = path.extname(actualFile).slice(1).toLowerCase();
      if (ext === "webm") { outExt = "webm"; mime = "video/webm"; }
      else if (ext === "mkv") { outExt = "mkv"; mime = "video/x-matroska"; }
      else { outExt = "mp4"; mime = "video/mp4"; }
    }

    if (!actualFile || !fs.existsSync(actualFile)) {
      send({ type: "error", msg: "Fichier introuvable après traitement." });
      cleanupYtDlpArtifacts(TMP_DIR, tmpId);
      return res.end();
    }

    // Vérif taille
    const sizeMB = fs.statSync(actualFile).size / 1_048_576;
    if (sizeMB > MAX_FILE_MB) {
      fs.unlink(actualFile, () => {});
      cleanupYtDlpArtifacts(TMP_DIR, tmpId);
      send({ type: "error", msg: `Fichier trop volumineux (${Math.round(sizeMB)}MB). Max: ${MAX_FILE_MB}MB.` });
      return res.end();
    }

    send({ type: "progress", pct: 98, msg: "Préparation…" });

    const b64 = fs.readFileSync(actualFile).toString("base64");
    const filename = `dropload_${quality}.${isMp3 ? "mp3" : outExt}`;

    send({ type: "done", b64, mime, filename });
    fs.unlink(actualFile, () => {});

  } catch (err) {
    console.error("download:", err.message);
    cleanupYtDlpArtifacts(TMP_DIR, tmpId);
    send({ type: "error", msg: err.message.split("\n")[0].slice(0, 500) });
  }

  res.end();
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`dropload running → http://localhost:${PORT}`));
