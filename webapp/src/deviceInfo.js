// Coarse-pointer + small-viewport heuristic: a touch-capable laptop with a
// large screen shouldn't be treated as memory/GPU constrained, only devices
// that are actually likely to be phones/tablets.
export const IS_MOBILE =
  (navigator.maxTouchPoints > 0 || "ontouchstart" in window) &&
  matchMedia("(pointer: coarse)").matches &&
  Math.min(window.innerWidth, window.innerHeight) < 900;
