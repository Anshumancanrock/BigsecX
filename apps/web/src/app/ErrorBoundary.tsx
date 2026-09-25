/**
 * Replaces a crashed tree with an error screen instead of a blank page, which
 * would look the same as a network failure. A class component because there
 * is no hook equivalent.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("render failed:", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="app" style={{ display: "block", padding: 40 }}>
        <div style={{ maxWidth: 560, margin: "10vh auto" }}>
          <h2 style={{ fontSize: 28, marginBottom: 12 }}>Something broke on this screen.</h2>
          <p className="note" style={{ marginBottom: 18 }}>
            No transaction is affected by this: it is a display fault, and anything already signed and
            submitted is on chain regardless of what this page shows. Reloading is safe.
          </p>
          <div className="banner bad" style={{ marginBottom: 18 }}>
            <span className="num" style={{ fontSize: 12 }}>
              {error.message}
            </span>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn-mint" onClick={() => location.reload()}>
              Reload
            </button>
            <button className="btn-ghost" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
