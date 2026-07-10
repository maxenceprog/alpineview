/**
 * Pure utility functions for the mesh registry — no Three.js dependency.
 */

/** Extract a display name from a PLY URL. */
export function meshNameFromUrl(url) {
  return url.split("/").pop().replace(/\.ply$/i, "");
}

/**
 * Create an in-memory mesh registry entry.
 * @param {object} mesh  - Three.js Mesh (or any object with a .name)
 * @param {string} name  - Display name
 * @returns {{ mesh: object, name: string, visible: boolean }}
 */
export function createEntry(mesh, name) {
  return { mesh, name, visible: true };
}

/**
 * Toggle the visible flag on an entry and mirror it onto mesh.visible.
 * Returns the updated entry (mutates in place).
 */
export function toggleEntry(entry) {
  entry.visible = !entry.visible;
  entry.mesh.visible = entry.visible;
  return entry;
}
