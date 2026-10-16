import { Component, type ReactNode } from "react";
import { useFleet } from "~/lib/fleet";
import { useI18n } from "~/lib/i18n";

/**
 * Keeps a rendering error inside one section: the rest of the dashboard stays usable. Fresh data from the server
 * tries again, so a passing oddity in a transcript does not hide the section for good.
 */
class Boundary extends Component<{ children: ReactNode; fallback: string; retry: unknown }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    console.error(error);
  }
  override componentDidUpdate(prev: { retry: unknown }) {
    if (this.state.failed && prev.retry !== this.props.retry) this.setState({ failed: false });
  }
  override render() {
    return this.state.failed ? (
      <p className="rest" data-crashed="">
        {this.props.fallback}
      </p>
    ) : (
      this.props.children
    );
  }
}

export function Safe({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const { data } = useFleet();
  return (
    <Boundary
      retry={data}
      fallback={t(
        "Dieser Teil ließ sich gerade nicht anzeigen; Fleet versucht es mit den nächsten Daten erneut.",
        "This part could not be shown just now; Fleet tries again with the next data.",
      )}
    >
      {children}
    </Boundary>
  );
}
