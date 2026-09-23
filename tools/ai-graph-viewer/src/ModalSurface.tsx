import type { ReactNode } from 'react';
import { useModalLifecycle } from './use-modal';

export function ModalSurface({ title, children, onClose, className = '' }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const { dialogRef, onCancel } = useModalLifecycle(onClose);
  return <dialog ref={dialogRef} onCancel={onCancel} aria-label={title}
    className={`surface-dialog ${className}`}>
    {children}
  </dialog>;
}
