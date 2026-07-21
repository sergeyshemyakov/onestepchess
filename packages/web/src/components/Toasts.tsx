import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

export type ToastAction = {
  readonly label: string;
  readonly onClick?: () => void;
  readonly href?: string;
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
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((current) => current.filter((toast) => toast.id !== id));
    },
    [clearTimer],
  );

  const armTimer = useCallback(
    (id: number) => {
      clearTimer(id);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_TTL_MS),
      );
    },
    [clearTimer, dismiss],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const push = useCallback(
    (text: string, kind: Toast["kind"] = "info", action?: ToastAction) => {
      const id = nextId.current;
      nextId.current += 1;
      setToasts((current) => {
        const next = [
          ...current,
          { id, kind, text, ...(action === undefined ? {} : { action }) },
        ].slice(-TOAST_CAP);
        const kept = new Set(next.map((toast) => toast.id));
        for (const toast of current) {
          if (!kept.has(toast.id)) clearTimer(toast.id);
        }
        return next;
      });
      armTimer(id);
    },
    [armTimer, clearTimer],
  );

  return (
    <ToastContext.Provider value={{ push }}>
      {props.children}
      <div id="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <fieldset
            key={toast.id}
            className={toast.kind === "lose" ? "toast lose" : "toast"}
            onMouseEnter={() => clearTimer(toast.id)}
            onMouseLeave={() => armTimer(toast.id)}
            onFocus={() => clearTimer(toast.id)}
            onBlur={(event) => {
              const next = event.relatedTarget;
              if (
                !(next instanceof Node) ||
                !event.currentTarget.contains(next)
              ) {
                armTimer(toast.id);
              }
            }}
          >
            {toast.text}
            {toast.action !== undefined ? (
              toast.action.href === undefined ? (
                <button
                  type="button"
                  className="btn mini"
                  onClick={toast.action.onClick}
                >
                  {toast.action.label}
                </button>
              ) : (
                <a
                  className="btn mini"
                  href={toast.action.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {toast.action.label}
                </a>
              )
            ) : null}
          </fieldset>
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
