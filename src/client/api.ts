/**
 * API calls for the application.
 * Handles resolution, downloads, and health checks.
 */

import { parseUrlList } from "../shared/sources.ts";
import type { DownloadItem, ResolveResponseBody, HealthResponseBody } from "../shared/contracts.ts";
import {
  getState,
  setState,
  setDownloadState,
  getDownloadState,
  clearDownloadStates,
} from "./state.ts";

// ─── Core API functions ─────────────────────────────────────────────────────

export async function resolveBatch(): Promise<void> {
  const state = getState();
  const urls = parseUrlList(state.urls);

  if (!urls.length) {
    setState({ mascotState: "waiting", results: [] });
    return;
  }

  setState({ isBusy: true, mascotState: "loading" });

  try {
    const payload = { options: state.options, urls };
    const response = await fetch("/api/resolve", {
      body: JSON.stringify(payload),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    const data = (await response.json()) as ResolveResponseBody | { error?: string };
    if (!response.ok || !("results" in data)) {
      throw new Error(
        "error" in data && typeof data.error === "string"
          ? data.error
          : "Something went wrong. Please try again.",
      );
    }

    clearDownloadStates();
    setState({
      results: data.results,
      mascotState: "success",
    });
  } catch (error) {
    clearDownloadStates();
    setState({
      results: [],
      mascotState: "error",
    });
    // Re-render with error in summary
    const summaryEl = document.querySelector<HTMLElement>("#results-summary");
    if (summaryEl) {
      summaryEl.textContent = error instanceof Error ? error.message : "Something went wrong.";
    }
  } finally {
    setState({ isBusy: false });
  }
}

export async function refreshHealth(): Promise<void> {
  try {
    const response = await fetch("/api/health");
    const health = (await response.json()) as HealthResponseBody;
    setState({ health });
  } catch (error) {
    setState({
      health: {
        authenticated: false,
        message: error instanceof Error ? error.message : "Unknown connectivity failure.",
        ok: false,
        services: [],
        upstreamUrl: "Unavailable",
      },
    });
  }
}

// Active downloads keyed by item id to prevent duplicates.
const activeDownloads = new Map<string, Promise<void>>();

export async function queueDownloads(items: DownloadItem[]): Promise<void> {
  for (const item of items) {
    const phase = getDownloadState(item.id).phase;
    if (phase === "downloading") continue;

    // If a previous download for this item is still running, don't restart.
    if (activeDownloads.has(item.id)) continue;

    setDownloadState(item.id, { phase: "downloading" });
    const promise = downloadItem(item);
    activeDownloads.set(item.id, promise);
    try {
      await promise;
    } catch {
      // Error state is already set inside downloadItem.
    } finally {
      activeDownloads.delete(item.id);
    }
  }
}

async function downloadItem(item: DownloadItem): Promise<void> {
  let response: Response;

  try {
    response = await fetch(item.downloadPath);
  } catch {
    setDownloadState(item.id, {
      message: "Network error — check your connection and try again.",
      phase: "error",
    });
    return;
  }

  if (!response.ok) {
    setDownloadState(item.id, {
      message: await readDownloadError(response),
      phase: "error",
    });
    return;
  }

  const blob = await response.blob();

  // Revoke any previous object URL for this item to free memory.
  const existingUrl = objectUrlMap.get(item.id);
  if (existingUrl) {
    URL.revokeObjectURL(existingUrl);
    objectUrlMap.delete(item.id);
  }

  const objectUrl = URL.createObjectURL(blob);
  objectUrlMap.set(item.id, objectUrl);

  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = item.filename;
  anchor.rel = "noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  // Revoke after a generous delay so the browser can finish reading the blob.
  setTimeout(() => {
    const current = objectUrlMap.get(item.id);
    if (current === objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrlMap.delete(item.id);
    }
  }, 60_000);

  setDownloadState(item.id, { phase: "done" });
}

const objectUrlMap = new Map<string, string>();

async function readDownloadError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body = (await response.json()) as { error?: string };
      return body.error ?? `Download failed (status ${response.status}).`;
    } catch {
      // Fall through to text extraction.
    }
  }
  const text = await response.text();
  return text ? text.slice(0, 200) : `Download failed (status ${response.status}).`;
}
