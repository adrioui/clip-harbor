import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { promisify } from "node:util";

// This local bridge exposes a clean yt-dlp-native API for the Worker to consume.
// The Worker sends extraction requests here; this process shells out to yt-dlp.

const execFileAsync = promisify(execFile);

const port = Number(process.env.LOCAL_ORIGIN_PORT ?? "9010");
const publicUrl = requiredEnv("LOCAL_ORIGIN_PUBLIC_URL");
const apiKey = requiredEnv("LOCAL_ORIGIN_API_KEY");
const services = ["instagram", "tiktok"] as const;
const cache = new Map<string, CachedDownload>();
const ttlMs = 1000 * 60 * 20;

const server = createServer(async (request, response) => {
  try {
    if (!request.url) {
      writeJson(response, 400, { error: "Request URL missing." });
      return;
    }

    const url = new URL(request.url, `http://127.0.0.1:${port}`);

    // GET / — health/info
    if (request.method === "GET" && url.pathname === "/") {
      writeJson(response, 200, {
        ok: true,
        supportedPlatforms: [...services],
        version: await ytDlpVersion(),
      });
      return;
    }

    // POST /extract — resolve a URL
    if (request.method === "POST" && url.pathname === "/extract") {
      if (!isAuthorized(request.headers.authorization)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      let body: { url?: string };
      try {
        body = JSON.parse(await readBody(request)) as { url?: string };
      } catch {
        writeJson(response, 400, { error: "Request body must be valid JSON." });
        return;
      }

      if (typeof body.url !== "string" || !body.url.trim()) {
        writeJson(response, 400, { error: "Provide a valid URL." });
        return;
      }

      try {
        const resolved = await resolveSource(body.url);
        const id = randomUUID();
        cache.set(id, resolved);

        writeJson(response, 200, {
          ...(resolved.caption ? { caption: resolved.caption } : {}),
          ...(resolved.thumbnailUrl ? { thumbnailUrl: resolved.thumbnailUrl } : {}),
          ...(resolved.type ? { type: resolved.type } : {}),
          filename: resolved.filename,
          url: `${publicUrl.replace(/\/+$/u, "")}/download?id=${encodeURIComponent(id)}`,
        });
      } catch (error) {
        writeJson(response, 422, {
          error: error instanceof Error ? error.message : "Unsupported URL or extraction failed",
        });
      }
      return;
    }

    // GET /download?id=xxx — stream cached media
    if (request.method === "GET" && url.pathname === "/download") {
      if (!isAuthorized(request.headers.authorization)) {
        writeJson(response, 401, { error: "Unauthorized" });
        return;
      }

      const id = url.searchParams.get("id");
      if (!id) {
        writeJson(response, 400, { error: "Missing download id." });
        return;
      }

      const cached = cache.get(id);
      if (!cached || cached.expiresAt < Date.now()) {
        cache.delete(id);
        writeJson(response, 410, { error: "Download id expired." });
        return;
      }

      await streamDownload(response, cached);
      return;
    }

    writeJson(response, 404, { error: "Not found." });
  } catch (error) {
    writeJson(response, 500, {
      error: error instanceof Error ? error.message : "Unknown failure",
    });
  }
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (value.expiresAt < now) {
      cache.delete(key);
    }
  }
}, 60_000);

cleanup.unref();

server.listen(port, "127.0.0.1", () => {
  console.log(`[local-origin] listening on http://127.0.0.1:${port}`);
  console.log(`[local-origin] public url ${publicUrl}`);
});

interface CachedDownload {
  caption?: string;
  expiresAt: number;
  filename: string;
  sourceUrl: string;
  thumbnailUrl?: string;
  type?: string;
}

interface YtDlpRequestedDownload {
  ext?: string;
  filename?: string;
  url: string;
}

interface YtDlpResult {
  description?: string;
  ext?: string;
  id?: string;
  requested_downloads?: YtDlpRequestedDownload[];
  thumbnail?: string;
}

function inferMediaType(ext: string | undefined): string | undefined {
  if (!ext) return undefined;
  const lower = ext.toLowerCase();
  if (["mp4", "webm", "mkv", "avi", "mov", "flv"].includes(lower)) return "video";
  if (["mp3", "m4a", "ogg", "wav", "flac", "aac", "opus"].includes(lower)) return "audio";
  if (["jpg", "jpeg", "png", "webp", "gif"].includes(lower)) return "photo";
  return undefined;
}

async function resolveSource(sourceUrl: string): Promise<CachedDownload> {
  const { stdout } = await execFileAsync(
    "yt-dlp",
    ["--skip-download", "--no-playlist", "--no-warnings", "--dump-single-json", sourceUrl],
    { maxBuffer: 1024 * 1024 * 10 },
  );

  const parsed = JSON.parse(stdout) as YtDlpResult;
  const requested = parsed.requested_downloads?.[0];
  if (!requested?.url) {
    throw new Error("Unsupported URL or extraction failed");
  }

  const type = inferMediaType(requested.ext) ?? inferMediaType(parsed.ext) ?? "video";

  const result: CachedDownload = {
    expiresAt: Date.now() + ttlMs,
    filename: requested.filename ?? `${parsed.id ?? "download"}.${requested.ext ?? "mp4"}`,
    sourceUrl,
    type,
  };

  const caption = parsed.description?.trim();
  if (caption) result.caption = caption;
  if (parsed.thumbnail) result.thumbnailUrl = parsed.thumbnail;

  return result;
}

async function ytDlpVersion(): Promise<string> {
  const { stdout } = await execFileAsync("yt-dlp", ["--version"]);
  return stdout.trim();
}

function isAuthorized(authorization: string | undefined): boolean {
  return authorization === `Api-Key ${apiKey}`;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

async function streamDownload(response: ServerResponse, cached: CachedDownload): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(
      "yt-dlp",
      ["--no-playlist", "--no-progress", "--no-warnings", "-o", "-", cached.sourceUrl],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let started = false;
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      if (!started) {
        started = true;
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": inferContentType(cached.filename),
        });
      }

      response.write(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("close", (code) => {
      if (!started && code !== 0) {
        writeJson(response, 502, {
          error: Buffer.concat(stderrChunks).toString("utf8").slice(0, 400),
        });
        resolve();
        return;
      }

      response.end();
      resolve();
    });

    response.on("close", () => {
      child.kill("SIGTERM");
    });
  });
}

function inferContentType(filename: string): string {
  if (filename.endsWith(".mp4")) {
    return "video/mp4";
  }

  if (filename.endsWith(".mp3")) {
    return "audio/mpeg";
  }

  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  return "application/octet-stream";
}
