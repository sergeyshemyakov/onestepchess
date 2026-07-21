import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";

export type ToastAction = {
  readonly label: string;
  readonly onClick: () => void;
};

type Toast = {
  readonly id: number;
  readonly kind: "info" | "lose";
  readonly text: string;
  readonly action?: ToastAction;
};

type ToastState = {
  readonly push: (
    text: string,
    kind?: Toast["kind"],
    action?: ToastAction,
  ) => void;
};

const ToastContext = createContext<ToastState | null>(null);

const TOAST_CAP = 3;
const TOAST_TTL_MS = 5_200;

/** Capped stack of 3 (oldest drops), aria-live polite (F-W7). A toast may
 * carry one action — the win toast's `share ▸` entry point (F-W12). */
export function ToastProvider(props: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback(
    (text: string, kind: Toast["kind"] = "info", action?: ToastAction) => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) =>
        [
          ...current,
          { id, kind, text, ...(action === undefined ? {} : { action }) },
        ].slice(-TOAST_CAP),
      );
      setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, TOAST_TTL_MS);
    },
    [],
  );

  return (
    <ToastContext.Provider value={{ push }}>
      {props.children}
      <div id="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={toast.kind === "lose" ? "toast lose" : "toast"}
          >
            {toast.text}
            {toast.action !== undefined ? (
              <button
                type="button"
                className="btn mini"
                onClick={toast.action.onClick}
              >
                {toast.action.label}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastState {
  const value = useContext(ToastContext);
  if (value === null) throw new Error("useToasts outside ToastProvider");
  return value;
}
