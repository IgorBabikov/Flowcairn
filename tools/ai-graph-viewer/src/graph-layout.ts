import { Position } from '@xyflow/react';
import type { GraphNodeSnapshot } from './contracts';

/** Presentation only: dependencies determine positions; execution state never does. */
export function graphLayout(nodes: ReadonlyArray<Pick<GraphNodeSnapshot, 'id' | 'needs'>>) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const levels = new Map<string, number>();
  const levelOf = (id: string, visiting = new Set<string>()): number => {
    if (levels.has(id)) return levels.get(id)!;
    if (visiting.has(id)) return 0;
    const node = byId.get(id);
    if (!node || node.needs.length === 0) return 0;
    visiting.add(id);
    const level = Math.max(...node.needs.map((need) => levelOf(need, visiting))) + 1;
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  nodes.forEach((node) => levels.set(node.id, levelOf(node.id)));
  const ordered = [...nodes].sort((a, b) => levels.get(a.id)! - levels.get(b.id)!);
  const chain = ordered.every((node, index) =>
    index === 0
      ? node.needs.length === 0
      : node.needs.length === 1 && node.needs[0] === ordered[index - 1]?.id,
  );
  const columns = Math.min(3, nodes.length);
  const positionAt = (index: number) => {
    const row = Math.floor(index / columns);
    const column = row % 2 === 0 ? index % columns : columns - 1 - (index % columns);
    return { x: column * 316, y: row * 240 };
  };
  const ranks = new Map<number, string[]>();
  nodes.forEach((node) => {
    const rank = levels.get(node.id)!;
    ranks.set(rank, [...(ranks.get(rank) ?? []), node.id]);
  });
  return new Map(
    ordered.map((node, index) => {
      if (chain) {
        const position = positionAt(index);
        const previous = index ? positionAt(index - 1) : null;
        const next = index < ordered.length - 1 ? positionAt(index + 1) : null;
        return [
          node.id,
          {
            position,
            targetPosition:
              !previous || previous.y !== position.y
                ? Position.Top
                : previous.x < position.x
                  ? Position.Left
                  : Position.Right,
            sourcePosition:
              !next || next.y !== position.y
                ? Position.Bottom
                : next.x > position.x
                  ? Position.Right
                  : Position.Left,
          },
        ];
      }
      const rank = levels.get(node.id)!;
      const peers = ranks.get(rank)!;
      return [
        node.id,
        {
          position: {
            x: (peers.indexOf(node.id) - (peers.length - 1) / 2) * 316,
            y: rank * 240,
          },
          targetPosition: Position.Top,
          sourcePosition: Position.Bottom,
        },
      ];
    }),
  );
}
