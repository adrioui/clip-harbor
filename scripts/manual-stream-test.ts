/**
 * Manual test for the yt-dlp streaming fix.
 * Verifies that video downloads are not truncated and files are valid.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";

const TEST_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const OUTPUT_PATH = "/tmp/manual-test-video.webm";

async function streamToFile(sourceUrl: string, outputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "yt-dlp",
      [
        "--no-playlist",
        "--no-progress",
        "--no-warnings",
        "--retries",
        "3",
        "--fragment-retries",
        "3",
        "-o",
        "-",
        sourceUrl,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const output = createWriteStream(outputPath);
    child.stdout.pipe(output);

    output.on("error", (err) => {
      child.kill("SIGTERM");
      reject(err);
    });

    child.on("close", async (code) => {
      output.end();
      if (code !== 0) {
        const errorMsg = Buffer.concat(stderrChunks).toString("utf8").slice(0, 400);
        reject(new Error(`yt-dlp exited with code ${code}: ${errorMsg}`));
        return;
      }
      try {
        const info = await stat(outputPath);
        resolve(info.size);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function main(): Promise<void> {
  console.log(`Starting manual stream test for: ${TEST_URL}`);
  const startTime = Date.now();

  try {
    const size = await streamToFile(TEST_URL, OUTPUT_PATH);
    const duration = (Date.now() - startTime) / 1000;

    console.log(`\nDownload completed in ${duration.toFixed(1)}s`);
    console.log(`File size: ${size} bytes (${(size / 1024 / 1024).toFixed(2)} MB)`);

    if (size < 1024 * 1024) {
      console.error("ERROR: File is under 1MB — possible truncation!");
      process.exit(1);
    }

    if (size < 10 * 1024 * 1024) {
      console.warn("WARNING: File seems smaller than expected for this video (< 10MB)");
    }

    console.log("SUCCESS: Video stream test passed.");
  } catch (error) {
    console.error("FAILED:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
