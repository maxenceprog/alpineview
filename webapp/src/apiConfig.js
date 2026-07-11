// Origin serving /tiles, /buildings, /vegetation (alpineview_api). Empty
// string means same-origin (local dev, where vite.common.js proxies these
// paths itself). Set at build time via VITE_API_BASE_URL.
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";
