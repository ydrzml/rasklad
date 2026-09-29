import { useEffect, useRef, type ReactNode } from "react";

/* Панель сбоку поверх страницы: сравнение решений и все, что смотрят, не уходя из списка.
   Встроенное модальное окно <dialog>: фокус внутри, Esc и щелчок мимо закрывают. */
export function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={box}
      className="u-drawer"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="u-drawer-head">
        <h2>{title}</h2>
        <button className="u-btn u-btn-ghost" type="button" onClick={onClose}>
          Закрыть
        </button>
      </div>
      <div className="u-drawer-body">{children}</div>
    </dialog>
  );
}
