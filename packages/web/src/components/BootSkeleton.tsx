import { AppShell } from "./AppShell.jsx";

export function BootSkeleton(props: { readonly showSystemBanner?: boolean }) {
  return (
    <AppShell showSystemBanner={props.showSystemBanner}>
      <p className="console" style={{ padding: "40px 22px" }}>
        &gt; connecting<span className="blink">▊</span>
      </p>
    </AppShell>
  );
}
