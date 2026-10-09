import { useState } from 'react';

/** Transparent package asset; plain-paper failure is explicit and keeps controls usable. */
export function WorkingObjectArt({ kind, onFailure }: { kind: 'scroll' | 'codex'; onFailure: () => void }) {
  const [failed, setFailed] = useState(false);
  return failed ? <p className="object-art-error" role="status">Оформление не загрузилось</p>
    : <img className="working-object-art" src={`/assets/rpg/${kind === 'scroll' ? 'ui-quest-scroll' : 'ui-codex'}.png`}
      alt="" aria-hidden="true" draggable={false} onError={() => { setFailed(true); onFailure(); }} />;
}
