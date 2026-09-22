import React, { useEffect } from 'react';
import { Handle, useUpdateNodeInternals, NodeToolbar, Position, type Node, type NodeProps } from '@xyflow/react';
import type { CapabilityName, GraphNodeSnapshot, Snapshot } from './contracts';
import { graphLayout } from './graph-layout';
import { nodeTitle, statusHint, StatusIcon } from './presentation';
import { COPY, statusLabel, formatDuration, type Locale } from './ui-copy';
import { getCapability } from './ui-controls';

type GraphNodeData = GraphNodeSnapshot &
  Record<string, unknown> & {
    locale: Locale;
    sourcePosition: Position;
    targetPosition: Position;
    selected: boolean;
    onOpen: () => void;
    onAction: (name: 'run' | 'retry' | 'rerun-check' | 'recover') => void;
  };

function GraphNodeCard({ data }: NodeProps<Node<GraphNodeData, 'operator'>>) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    updateNodeInternals(data.id);
  }, [data.id, data.sourcePosition, data.targetPosition, updateNodeInternals]);
  const labels = COPY[data.locale];
  const actions: Array<['run' | 'retry' | 'rerun-check' | 'recover', CapabilityName, string]> = [
    ['run', 'run', labels.run],
    ['retry', 'retry', labels.retry],
    ['rerun-check', 'rerunCheck', labels.rerunCheck],
    ['recover', 'recover', labels.recover],
  ];
  return (
    <article
      aria-current={data.selected ? 'step' : undefined}
      className={`graph-node status-${data.status}${data.selected ? ' selected' : ''}`}
      onClick={data.onOpen}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          data.onOpen();
        }
      }}
      aria-label={`${nodeTitle(data, data.locale)}: ${statusLabel(data.status, data.locale, data.resolutionKind)}`}
      role="button"
      tabIndex={0}
    >
      {data.status === 'running' && (
        <svg
          className="execution-border"
          aria-hidden="true"
          focusable="false"
          height="100%"
          preserveAspectRatio="none"
          viewBox="0 0 100 100"
          width="100%"
        >
          <rect height="98" pathLength="100" vectorEffect="non-scaling-stroke" width="98" x="1" y="1" />
        </svg>
      )}
      <NodeToolbar
        className="node-toolbar"
        isVisible={
          data.selected &&
          actions.some(([, name]) => getCapability(data.capabilities, name).allowed)
        }
        position={Position.Top}
      >
        {actions.map(([action, capabilityName, label]) => {
          const capability = getCapability(data.capabilities, capabilityName);
          return capability.allowed ? (
            <button
              className="toolbar-action"
              key={action}
              onClick={(event) => {
                event.stopPropagation();
                data.onAction(action);
              }}
              type="button"
            >
              {label}
            </button>
          ) : null;
        })}
      </NodeToolbar>
      <Handle type="target" position={data.targetPosition} isConnectable={false} />
      <div className="node-heading">
        <StatusIcon status={data.status} />
        <span className="node-mode">{data.mode === 'write' ? labels.write : labels.read}</span>
      </div>
      <strong>{nodeTitle(data, data.locale)}</strong>
      <span className="node-status">{statusLabel(data.status, data.locale, data.resolutionKind)}</span>
      <span className="node-hint">{data.status === 'uncertain' && data.resolutionKind === 'semantic'
        ? data.locale === 'ru' ? 'Уточните задачу перед продолжением' : 'Clarify the task before continuing'
        : statusHint(data.status, data.locale)}</span>
      {!data.sourceRunId && <div className="node-meta">
        <span>
          {labels.attempt}: {data.attempt}
        </span>
        <span>{formatDuration(data.durationMs, data.locale)}</span>
        <span>
          {data.receiptIds.length} {data.locale === 'ru' ? 'отчетов' : 'receipts'}
        </span>
      </div>}
      <Handle type="source" position={data.sourcePosition} isConnectable={false} />
    </article>
  );
}

export const NODE_TYPES = { operator: GraphNodeCard };

export function layoutNodes(
  snapshot: Snapshot,
  locale: Locale,
  selectedNodeId: string | null,
  onOpen: (id: string) => void,
  onAction: (name: Parameters<GraphNodeData['onAction']>[0], nodeId: string) => void,
): Array<Node<GraphNodeData, 'operator'>> {
  const placements = graphLayout(snapshot.nodes);
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return Array.from(placements, ([id, placement]) => {
    const item = byId.get(id)!;
    return {
      id: item.id,
      type: 'operator',
      className: `execution-node status-${item.status}`,
      style: { '--node-status-color': `var(--status-${item.status})` } as React.CSSProperties,
      ...placement,
      draggable: false,
      selectable: true,
      data: {
        ...item,
        sourcePosition: placement.sourcePosition,
        targetPosition: placement.targetPosition,
        locale,
        selected: selectedNodeId === item.id,
        onOpen: () => onOpen(item.id),
        onAction: (name) => onAction(name, item.id),
      },
    };
  });
}
