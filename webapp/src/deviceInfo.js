export const IS_MOBILE =
  (navigator.maxTouchPoints > 0 || "ontouchstart" in window) &&
  matchMedia("(pointer: coarse)").matches &&
  Math.min(window.innerWidth, window.innerHeight) < 900;
