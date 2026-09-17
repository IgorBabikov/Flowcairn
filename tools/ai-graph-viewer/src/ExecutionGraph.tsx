import { Background, Controls, MiniMap, ReactFlow, type Edge, type Node, type NodeTypes, type ReactFlowInstance } from '@xyflow/react';

/** The graph displays runtime state. It never changes dependencies or permissions. */
export function ExecutionGraph({ runId, edges, nodes, currentNodeId, locale, nodeTypes, onInit }: {
  runId: string;
  edges: Edge[];
  nodes: Node[];
  currentNodeId: string | null;
  locale: 'ru' | 'en';
  nodeTypes: NodeTypes;
  onInit: (instance: ReactFlowInstance) => void;
}) {
  return <ReactFlow key={runId} edges={edges} nodes={nodes} nodeTypes={nodeTypes} elementsSelectable fitView
    fitViewOptions={{ ...(window.matchMedia('(max-width: 720px)').matches && currentNodeId
      ? { nodes: [{ id: currentNodeId }], minZoom: .9, padding: .32 }
      : { minZoom: .08, padding: .2 }), maxZoom: 1 }}
    maxZoom={1.35} minZoom={.08} onlyRenderVisibleElements nodesConnectable={false} nodesDraggable={false}
    ariaLabelConfig={locale === 'ru' ? {
      'node.a11yDescription.default': 'Нажмите Enter или пробел, чтобы выбрать этап. Escape снимает выбор.',
      'controls.zoomIn.ariaLabel': 'Приблизить', 'controls.zoomOut.ariaLabel': 'Отдалить',
      'controls.fitView.ariaLabel': 'Показать весь граф', 'minimap.ariaLabel': 'Мини-карта графа',
    } : {}}
    onInit={onInit} panOnScroll proOptions={{ hideAttribution: false }}>
    <Background color="var(--flow-grid)" gap={24} size={1} />
    {nodes.length > 12 && <MiniMap ariaLabel={locale === 'ru' ? 'Мини-карта графа' : 'Graph minimap'} pannable zoomable nodeColor={node => `var(--status-${String(node.data.status)})`} />}
    <Controls position="top-left" showInteractive={false} />
  </ReactFlow>;
}
