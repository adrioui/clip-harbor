/**
 * Rendering module - handles DOM updates.
 * Subscribes to state changes and re-renders automatically.
 */

import { render } from "lit-html";
import { appTemplate } from "./templates/index.ts";
import { autoGrowTextarea } from "./handlers/index.ts";
import { subscribe } from "./state.ts";

const maybeAppRoot = document.querySelector<HTMLDivElement>("#app");
if (!maybeAppRoot) throw new Error("Missing app root.");
const appRoot = maybeAppRoot;

let lastTextareaLayoutKey = "";

export function renderApp(): void {
  const template = appTemplate();
  render(template.result, appRoot);

  if (template.textareaLayoutKey !== lastTextareaLayoutKey) {
    lastTextareaLayoutKey = template.textareaLayoutKey;
    requestAnimationFrame(autoGrowTextarea);
  }
}

/** Initialize the render loop - subscribes to state changes */
export function initRenderer(): void {
  // Subscribe to state changes and re-render
  subscribe(() => {
    renderApp();
  });
}
