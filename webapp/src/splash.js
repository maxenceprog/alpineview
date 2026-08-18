import { ALPINIST_QUOTES } from "./alpinistQuotes.js";
import { itownsPlacement } from "./utils.js";

const RECENTER_TIMEOUT_MS = 6000;
const POLL_MS = 300;

export function initSplash(view, tilesLayer, fallbackX, fallbackY) {
  const splash = document.getElementById("splash");
  const quote = ALPINIST_QUOTES[Math.floor(Math.random() * ALPINIST_QUOTES.length)];
  document.getElementById("splash-quote").textContent = `« ${quote.text} »`;
  document.getElementById("splash-author").textContent = `— ${quote.author}`;

  let everVisible = false;
  const recenterTimer = setTimeout(() => {
    if (!everVisible) itownsPlacement(view, fallbackX, fallbackY);
  }, RECENTER_TIMEOUT_MS);

  const interval = setInterval(() => {
    const stats = tilesLayer.tilesRenderer.stats;
    const queueLength = stats.queued + stats.downloading + stats.parsing;
    if (stats.visible > 0) everVisible = true;
    splash.classList.toggle("hidden", queueLength === 0);
    if (everVisible && queueLength === 0) {
      clearTimeout(recenterTimer);
      clearInterval(interval);
    }
  }, POLL_MS);
}
