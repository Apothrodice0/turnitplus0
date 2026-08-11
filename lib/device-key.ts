const STORAGE_KEY = "tp_device_key_v1";

/**
 * A random per-browser identifier used to let this browser find, update and
 * delete its own saved reports. This is soft scoping only, not
 * authentication — anyone who obtained this value could use it the same
 * way. It is stored separately from the (also client-only) account preview
 * in lib's sessionStorage-based account system.
 */
export function getDeviceKey(): string {
  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem(STORAGE_KEY, created);
  return created;
}
