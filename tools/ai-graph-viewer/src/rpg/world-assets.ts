import { Assets, type Texture, type Spritesheet } from 'pixi.js';

// A lease protects shared textures during StrictMode's overlapping async setup/cleanup.
let initialization: Promise<void> | null = null;
function initializeAssets() {
  // The authored manifest names PNG/WebP explicitly; no format probes or blob workers.
  initialization ??= Assets.init({ skipDetections: true, texturePreference: { format: ['png', 'webp'] },
    preferences: { preferWorkers: false, preferCreateImageBitmap: false } });
  return initialization;
}
const unloading = new Map<string, Promise<void>>();
const leases = new Map<string, { users: number; promise: Promise<Texture | Spritesheet> }>();
function acquire<T extends Texture | Spritesheet>(url: string) {
  let lease = leases.get(url);
  if (!lease) {
    lease = { users: 0, promise: Promise.all([initializeAssets(), unloading.get(url)]).then(() => Assets.load<Texture | Spritesheet>(url)) };
    leases.set(url, lease);
  }
  lease.users += 1;
  const owned = lease;
  let released = false;
  return {
    texture: owned.promise as Promise<T>,
    release() {
      if (released) return;
      released = true;
      owned.users -= 1;
      void owned.promise.then(() => {
        if (owned.users === 0 && leases.get(url) === owned) {
          leases.delete(url);
          // No remaining scene can reference this texture at this point.
          const release = Assets.unload(url).finally(() => { if (unloading.get(url) === release) unloading.delete(url); });
          unloading.set(url, release);
          return release;
        }
      }).catch(() => { if (owned.users === 0 && leases.get(url) === owned) leases.delete(url); });
    },
  };
}
export function acquireTexture(url: string) { return acquire<Texture>(url); }
export function acquireAtlas(url: string) { return acquire<Spritesheet>(url); }
