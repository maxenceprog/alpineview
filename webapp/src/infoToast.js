// Small self-dismissing info popup, styled to match index.html's dark panels.
// No action required from the user — it just fades out on its own.

const DURATION_MS = 3000;

let el = null;
let hideTimer = null;

function ensureEl() {
  if (el) {
    return el;
  }
  el = document.createElement("div");
  el.id = "info-toast";
  Object.assign(el.style, {
    position: "fixed",
    left: "50%",
    bottom: "10px",
    transform: "translateX(-50%)",
    zIndex: "20",
    background: "rgba(10, 20, 35, 0.88)",
    backdropFilter: "blur(6px)",
    color: "#dde6f0",
    font: "13px/1.4 system-ui, sans-serif",
    padding: "8px 14px",
    borderRadius: "8px",
    boxShadow: "0 6px 24px rgba(0, 0, 0, 0.35)",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 0.3s",
  });
  document.body.appendChild(el);
  return el;
}

export function showInfoToast(message) {
  const node = ensureEl();
  node.textContent = message;
  node.style.opacity = "1";
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    node.style.opacity = "0";
  }, DURATION_MS);
}
