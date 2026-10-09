import type { Navigation, Point } from './world-navigation';

export const LOCATION_LABELS = { guild: 'Гильдия', workshop: 'Мастерская', archive: 'Архив', mentor: 'Наставник' } as const;
export type LocationId = keyof typeof LOCATION_LABELS;
export type WorldAsset = { id: string; url: string; width: number; height: number; anchor: Point; visibleHeight: number; displayHeight: number };
export type Hotspot = { id: LocationId; label: string; pointId: string; polygon: Point[]; labelPosition: Point; interactionRadius: number };
export type WorldManifest = {
  bounds: { x: number; y: number; width: number; height: number };
  background: WorldAsset; hero: WorldAsset; mentor: { asset: WorldAsset; position: Point } | null;
  rooms: Partial<Record<LocationId, { background: WorldAsset; hero: WorldAsset; heroPosition: Point; heroHeight: number; mentor: { asset: WorldAsset; position: Point; height: number } | null }>>;
  navigation: Navigation; spawn: Point; hotspots: Hotspot[]; matte: string;
};

// Designer-owned image-space manifest is validated before constructing the scene.
export { loadWorldManifest } from './world-manifest-loader';
