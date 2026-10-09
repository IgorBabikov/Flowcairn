import { MissingSession } from './ui-controls';
import { WorkflowDialogs } from './WorkflowDialogs';
import { useWorkflowController } from './use-workflow-controller';
import { RpgShell } from './rpg/RpgShell';
export { AppErrorBoundary } from './ui-controls';

export function App() {
  const controller = useWorkflowController();
  if (!controller.authenticated) return <MissingSession labels={controller.labels} />;
  return <div className="rpg-app">
    <RpgShell controller={controller} />
    <WorkflowDialogs controller={controller} />
  </div>;
}
