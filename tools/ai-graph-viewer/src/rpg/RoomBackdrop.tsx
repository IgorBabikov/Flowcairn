import type { LocationId, WorldAsset, WorldManifest } from './world-manifest';
import type { Point } from './world-navigation';
import { useViewportQuery } from '../use-viewport-query';

function CharacterImage({ asset, position, height }: { asset: WorldAsset; position: Point; height: number }) {
  const scale = height / asset.visibleHeight;
  return <image href={asset.url} x={position.x - asset.anchor.x * scale} y={position.y - asset.anchor.y * scale}
    width={asset.width * scale} height={asset.height * scale} />;
}

/** Authored interior art; all task content and interaction stay in the DOM book. */
export function RoomBackdrop({ manifest, location }: { manifest: WorldManifest; location: LocationId }) {
  const narrow = useViewportQuery('(max-width: 760px)');
  const room = manifest.rooms[location === 'mentor' ? 'workshop' : location];
  if (!room) return null;
  return <svg className="rpg-room-backdrop" aria-hidden="true" viewBox={`0 0 ${room.background.width} ${room.background.height}`} preserveAspectRatio={narrow ? 'xMidYMin meet' : 'xMidYMid meet'}>
    <image href={room.background.url} width={room.background.width} height={room.background.height} />
    <CharacterImage asset={room.hero} position={room.heroPosition} height={room.heroHeight} />
    {room.mentor && <CharacterImage asset={room.mentor.asset} position={room.mentor.position} height={room.mentor.height} />}
  </svg>;
}
