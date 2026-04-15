import { html, render } from "lit-html";
import { classMap } from "lit-html/directives/class-map.js";
import { live } from "lit-html/directives/live.js";
import { map } from "lit-html/directives/map.js";
import { ref, createRef } from "lit-html/directives/ref.js";
import { unsafeSVG } from "lit-html/directives/unsafe-svg.js";

import {
  DEFAULT_RESOLVE_OPTIONS,
  VIDEO_QUALITIES,
  type DownloadItem,
  type HealthResponseBody,
  type ResolveOptions,
  type ResolveResponseBody,
  type ResolveResult,
} from "../shared/contracts.ts";
import { parseUrlList } from "../shared/sources.ts";
import catSvg from "./cat-mascot.svg?raw";
import "./styles.css";

// ─── Types ──────────────────────────────────────────────────────────────────

type DownloadPhase = "idle" | "queued" | "downloading" | "done" | "error";
type MascotState = "idle" | "loading" | "success" | "error" | "waiting";

interface DownloadState {
  message?: string;
  phase: DownloadPhase;
}

interface AppState {
  downloadStates: Map<string, DownloadState>;
  health: HealthResponseBody | null;
  isBusy: boolean;
  isInputFocused: boolean;
  mascotState: MascotState;
  options: ResolveOptions;
  results: ResolveResult[];
  urls: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const storageKey = "unduh-unduh.draft";
const downloadConcurrency = 3;

const mascotMessages: Record<MascotState, string> = {
  idle: "Ready to download",
  loading: "Finding your video...",
  success: "Ready!",
  error: "Something went wrong",
  waiting: "Paste a link to get started",
};

// ─── State ──────────────────────────────────────────────────────────────────

const state: AppState = {
  downloadStates: new Map(),
  health: null,
  isBusy: false,
  isInputFocused: false,
  mascotState: "waiting",
  options: { ...DEFAULT_RESOLVE_OPTIONS },
  results: [],
  urls: "",
};

function setState(updates: Partial<AppState>): void {
  Object.assign(state, updates);
  renderApp();
}

// ─── Refs ───────────────────────────────────────────────────────────────────

const urlInputRef = createRef<HTMLTextAreaElement>();

// ─── Utility helpers ────────────────────────────────────────────────────────

function countLinks(text: string): number {
  return parseUrlList(text).length;
}

function getDownloadState(id: string): DownloadState {
  return state.downloadStates.get(id) ?? { phase: "idle" };
}

function setDownloadState(id: string, ds: DownloadState): void {
  state.downloadStates.set(id, ds);
}

function downloadPhaseLabel(phase: DownloadPhase): string {
  switch (phase) {
    case "queued":
      return "Waiting";
    case "downloading":
      return "Downloading";
    case "done":
      return "Done";
    case "error":
      return "Retry";
    default:
      return "Ready";
  }
}

function downloadButtonLabel(phase: DownloadPhase): string {
  switch (phase) {
    case "queued":
      return "Waiting...";
    case "downloading":
      return "Downloading...";
    case "done":
      return "Download";
    case "error":
      return "Retry";
    default:
      return "Download";
  }
}

function isChipActive(option: "quality" | "audio" | "speed", opts: ResolveOptions): boolean {
  if (option === "audio" && opts.tiktokFullAudio) return true;
  if (option === "quality" && opts.videoQuality === "max" && opts.allowH265) return true;
  if (option === "speed" && !opts.allowH265 && opts.videoQuality === "720") return true;
  return false;
}

// ─── Auto-grow textarea ─────────────────────────────────────────────────────

function autoGrowTextarea(): void {
  const el = urlInputRef.value;
  if (!el) return;
  el.style.height = "auto";
  const lineHeight = parseInt(getComputedStyle(el).lineHeight, 10) || 22;
  const maxRows = 8;
  const maxHeight = lineHeight * maxRows;
  const scrollHeight = el.scrollHeight;
  el.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
  el.style.overflowY = scrollHeight > maxHeight ? "auto" : "hidden";
}

// ─── Templates ──────────────────────────────────────────────────────────────

function switcherChipTemplate(
  option: "quality" | "audio" | "speed",
  label: string,
): ReturnType<typeof html> {
  return html`
    <button
      class="switcher-chip ${classMap({ active: isChipActive(option, state.options) })}"
      data-option=${option}
      type="button"
      @click=${() => handleChipClick(option)}
    >
      ${label}
    </button>
  `;
}

function downloadRowTemplate(item: DownloadItem): ReturnType<typeof html> {
  const ds = getDownloadState(item.id);
  const isBusy = ds.phase === "queued" || ds.phase === "downloading";

  return html`
    <div class="download-row">
      <span class="download-row-label">${item.label}</span>
      <div class="download-row-actions">
        <span class="state-pill" data-phase=${ds.phase}>${downloadPhaseLabel(ds.phase)}</span>
        <button
          class="primary"
          type="button"
          ?disabled=${isBusy}
          @click=${() => void queueDownloads([item])}
        >
          ${downloadButtonLabel(ds.phase)}
        </button>
      </div>
    </div>
  `;
}

function resultGroupTemplate(result: ResolveResult): ReturnType<typeof html> {
  return html`
    <div class="result-group" data-state=${result.status}>
      ${result.caption
        ? html`
            <div class="result-group-header">
              <div class="result-group-title">${result.title}</div>
              <button
                class="ghost copy-caption-btn"
                type="button"
                @click=${(e: Event) => handleCopyCaption(e, result.caption!)}
              >
                Copy caption
              </button>
            </div>
          `
        : html`<div class="result-group-title">${result.title}</div>`}
      ${result.message ? html`<p class="result-group-message">${result.message}</p>` : ""}
      ${result.items.length > 1
        ? html`
            <div class="download-row">
              <button class="ghost" type="button" @click=${() => void queueDownloads(result.items)}>
                Download all (${result.items.length})
              </button>
            </div>
          `
        : ""}
      ${map(result.items, (item) => downloadRowTemplate(item))}
    </div>
  `;
}

function resultsSummaryText(): string {
  if (!state.results.length) return "";
  const items = state.results.flatMap((r) => r.items);
  const completed = items.filter((i) => getDownloadState(i.id).phase === "done").length;
  const failed = items.filter((i) => getDownloadState(i.id).phase === "error").length;
  const progressParts = [
    completed ? `${completed} saved` : null,
    failed ? `${failed} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${items.length} ${items.length === 1 ? "video" : "videos"} found${progressParts ? ` — ${progressParts}` : ""}`;
}

function resultsAreaTemplate(): ReturnType<typeof html> {
  const items = state.results.flatMap((r) => r.items);
  const hasActive = items.some(
    (i) =>
      getDownloadState(i.id).phase === "queued" || getDownloadState(i.id).phase === "downloading",
  );

  return html`
    <div class="results-area" id="results-area">
      <div class="results-head">
        <div class="results-summary" id="results-summary">${resultsSummaryText()}</div>
        <button
          class="ghost results-download-all"
          id="download-all"
          type="button"
          ?hidden=${items.length === 0}
          ?disabled=${hasActive}
          @click=${() => void queueDownloads(state.results.flatMap((r) => r.items))}
        >
          ${hasActive ? "Downloading..." : `Download all (${items.length})`}
        </button>
      </div>
      <div class="results-list" id="results">
        ${map(state.results, (result) => resultGroupTemplate(result))}
      </div>
    </div>
  `;
}

function footerTemplate(): ReturnType<typeof html> {
  const baseText = "Paste links from Instagram or TikTok. No accounts needed.";
  const isError = state.health && !state.health.ok;

  return html`
    <footer class="stage-footer">
      <p style=${isError ? "color: var(--danger)" : ""}>
        ${isError ? `${baseText} (Server unreachable)` : baseText}
      </p>
    </footer>
  `;
}

function appTemplate(): ReturnType<typeof html> {
  const linkCount = countLinks(state.urls);
  const hasContent = state.urls.trim().length > 0;
  const isExpanded = hasContent || linkCount > 1 || state.isInputFocused;

  return html`
    <main class="stage">
      <!-- Utility nav -->
      <nav class="utility-nav">
        <a href="#how-it-works">How it works</a>
        <a href="#settings">Settings</a>
        <a href="#about">About</a>
      </nav>

      <!-- Cat mascot -->
      <div class="mascot-wrap">
        <div
          class="cat-mascot"
          id="cat-mascot"
          data-state=${state.mascotState}
          aria-hidden="true"
          aria-label=${mascotMessages[state.mascotState]}
        >
          ${unsafeSVG(catSvg)}
        </div>
      </div>
      <div class="mascot-message" aria-live="polite">${mascotMessages[state.mascotState]}</div>

      <!-- Input stage -->
      <div class="input-stage">
        <form id="resolve-form" @submit=${handleSubmit}>
          <div
            class="omnibox ${classMap({ expanded: isExpanded, focused: state.isInputFocused })}"
            id="omnibox"
          >
            <div class="omnibox-top">
              <span class="omnibox-icon" aria-hidden="true">🔗</span>
              <textarea
                id="url-input"
                placeholder="Paste links here..."
                autocomplete="off"
                aria-label="Video URLs"
                rows="2"
                .value=${live(state.urls)}
                ${ref(urlInputRef)}
                @input=${handleUrlInput}
                @focus=${() => setState({ isInputFocused: true })}
                @blur=${() => setState({ isInputFocused: false })}
                @paste=${handlePaste}
              ></textarea>
              <button
                class="omnibox-clear ${classMap({ visible: hasContent })}"
                id="clear-input"
                type="button"
                aria-label="Clear"
                @click=${handleClearInput}
              >
                ×
              </button>
            </div>
            <div class="omnibox-bottom">
              <span class="link-count" ?hidden=${linkCount <= 1}> ${linkCount} links </span>
              <button
                class="omnibox-submit"
                id="resolve-button"
                type="submit"
                ?disabled=${state.isBusy}
              >
                ${state.isBusy ? "Loading..." : "Download"}
              </button>
            </div>
          </div>

          <!-- Hidden form controls -->
          <select
            id="video-quality"
            name="videoQuality"
            class="hidden"
            .value=${state.options.videoQuality}
          >
            ${map(
              VIDEO_QUALITIES,
              (v) => html`<option value=${v}>${v === "max" ? "max available" : `${v}p`}</option>`,
            )}
          </select>
          <input
            id="allow-h265"
            name="allowH265"
            type="checkbox"
            class="hidden"
            ?checked=${state.options.allowH265}
          />
          <input
            id="tiktok-full-audio"
            name="tiktokFullAudio"
            type="checkbox"
            class="hidden"
            ?checked=${state.options.tiktokFullAudio}
          />
        </form>
      </div>

      <!-- Switcher chips -->
      <div class="switcher" role="group" aria-label="Download options">
        ${switcherChipTemplate("quality", "Best quality")}
        ${switcherChipTemplate("audio", "Original audio")}
        ${switcherChipTemplate("speed", "Fast mode")}
      </div>

      <!-- Quick actions -->
      <div class="quick-actions">
        <button
          class="paste-button"
          id="paste-button"
          type="button"
          @click=${handlePasteFromClipboard}
        >
          Paste from clipboard
        </button>
      </div>

      <!-- Inline results -->
      ${resultsAreaTemplate()}
    </main>

    ${footerTemplate()}
  `;
}

// ─── Event handlers ─────────────────────────────────────────────────────────

function handleSubmit(event: Event): void {
  event.preventDefault();
  void resolveBatch();
}

function handleUrlInput(event: InputEvent): void {
  const value = (event.target as HTMLTextAreaElement).value;
  state.urls = value;
  renderApp();
  persistDraft();
  autoGrowTextarea();
}

function handlePaste(): void {
  setTimeout(() => {
    const el = urlInputRef.value;
    if (el) {
      state.urls = el.value;
      renderApp();
      persistDraft();
      autoGrowTextarea();
    }
  }, 0);
}

function handleClearInput(): void {
  state.downloadStates.clear();
  setState({
    urls: "",
    results: [],
    mascotState: "waiting",
  });
  persistDraft();
  setTimeout(() => urlInputRef.value?.focus(), 0);
}

async function handlePasteFromClipboard(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      setState({ urls: text });
      persistDraft();
      setTimeout(() => urlInputRef.value?.focus(), 0);
    }
  } catch {
    urlInputRef.value?.focus();
  }
}

function handleChipClick(option: "quality" | "audio" | "speed"): void {
  const newOptions = { ...state.options };

  if (option === "quality") {
    newOptions.videoQuality = "max";
    newOptions.allowH265 = true;
    newOptions.tiktokFullAudio = false;
  } else if (option === "audio") {
    newOptions.videoQuality = DEFAULT_RESOLVE_OPTIONS.videoQuality;
    newOptions.allowH265 = false;
    newOptions.tiktokFullAudio = true;
  } else if (option === "speed") {
    newOptions.videoQuality = "720";
    newOptions.allowH265 = false;
    newOptions.tiktokFullAudio = false;
  }

  setState({ options: newOptions });
  persistDraft();
}

async function handleCopyCaption(event: Event, caption: string): Promise<void> {
  const button = event.target as HTMLButtonElement;
  try {
    await navigator.clipboard.writeText(caption);
    button.textContent = "Copied!";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = "Copy caption";
      button.classList.remove("copied");
    }, 1500);
  } catch {
    button.textContent = "Failed";
    setTimeout(() => {
      button.textContent = "Copy caption";
    }, 1500);
  }
}

// ─── Core logic ─────────────────────────────────────────────────────────────

async function resolveBatch(): Promise<void> {
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

    state.downloadStates.clear();
    setState({
      results: data.results,
      mascotState: "success",
    });
  } catch (error) {
    state.downloadStates.clear();
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

async function refreshHealth(): Promise<void> {
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

async function queueDownloads(items: DownloadItem[]): Promise<void> {
  const queue = items.filter((item) => {
    const phase = getDownloadState(item.id).phase;
    return phase !== "queued" && phase !== "downloading";
  });

  if (!queue.length) return;

  for (const item of queue) {
    setDownloadState(item.id, { phase: "queued" });
  }
  renderApp();

  let cursor = 0;
  const workers = Array.from({ length: Math.min(downloadConcurrency, queue.length) }, async () => {
    while (cursor < queue.length) {
      const nextIndex = cursor;
      cursor += 1;
      await performDownload(queue[nextIndex]!);
    }
  });

  await Promise.all(workers);
}

async function performDownload(item: DownloadItem): Promise<void> {
  setDownloadState(item.id, { phase: "downloading" });
  renderApp();

  try {
    const response = await fetch(item.downloadPath);
    if (!response.ok) {
      throw new Error(await readDownloadError(response));
    }

    const blob = await response.blob();
    triggerDownload(item, blob);
    setDownloadState(item.id, { phase: "done" });
  } catch (error) {
    setDownloadState(item.id, {
      message: error instanceof Error ? error.message : "Download failed.",
      phase: "error",
    });
  }

  renderApp();
}

function triggerDownload(item: DownloadItem, blob: Blob): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.rel = "noreferrer";
  anchor.download = item.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

async function readDownloadError(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await response.json()) as { error?: string };
    return body.error ?? `Download failed with status ${response.status}.`;
  }
  const text = await response.text();
  return text || `Download failed with status ${response.status}.`;
}

// ─── Persistence ────────────────────────────────────────────────────────────

function persistDraft(): void {
  localStorage.setItem(storageKey, JSON.stringify({ options: state.options, urls: state.urls }));
}

function restoreDraft(): void {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    setState({ options: { ...DEFAULT_RESOLVE_OPTIONS }, urls: "" });
    return;
  }

  try {
    const parsed = JSON.parse(raw) as { options?: Partial<ResolveOptions>; urls?: string };
    setState({
      options: { ...DEFAULT_RESOLVE_OPTIONS, ...parsed.options },
      urls: parsed.urls ?? "",
    });
  } catch {
    localStorage.removeItem(storageKey);
  }
}

// ─── Render & Init ─────────────────────────────────────────────────────────

function getOrThrowAppRoot(): HTMLDivElement {
  const el = document.querySelector<HTMLDivElement>("#app");
  if (!el) throw new Error("Missing app root.");
  return el;
}

function renderApp(): void {
  render(appTemplate(), getOrThrowAppRoot());
  requestAnimationFrame(autoGrowTextarea);
}

function init(): void {
  restoreDraft();
  renderApp();
  refreshHealth();
}

init();
