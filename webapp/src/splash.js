import { ALPINIST_QUOTES } from "./alpinistQuotes.js";

const TIMEOUT_MS = 10000;

export function initSplash(tilesLayer) {
  const splash = document.getElementById("splash");
  const quote = ALPINIST_QUOTES[Math.floor(Math.random() * ALPINIST_QUOTES.length)];
  document.getElementById("splash-quote").textContent = `« ${quote.text} »`;
  document.getElementById("splash-author").textContent = `— ${quote.author}`;

  const hide = () => splash.classList.add("hidden");
  const checkProgress = () => {
    if (tilesLayer.tilesRenderer.stats.visible > 0) hide();
  };
  tilesLayer.tilesRenderer.addEventListener("needs-update", checkProgress);
  setTimeout(hide, TIMEOUT_MS);
}
