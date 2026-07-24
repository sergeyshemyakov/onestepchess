import type { ReactNode } from "react";

export function GamePane(props: {
  readonly children: ReactNode;
  readonly label: string;
  readonly onClose: () => void;
  readonly testId: string;
}) {
  return (
    <div className="modalback game-pane-backdrop">
      <div
        className="modal game-pane"
        role="dialog"
        aria-modal="true"
        aria-label={props.label}
        data-testid={props.testId}
      >
        <button
          type="button"
          className="game-pane-close"
          aria-label="Close game pane"
          onClick={props.onClose}
        >
          ×
        </button>
        {props.children}
      </div>
    </div>
  );
}
