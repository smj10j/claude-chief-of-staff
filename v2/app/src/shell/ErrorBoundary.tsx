import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Optional label included in the fallback to help the user identify
   *  what crashed (e.g. "the Tasks surface"). */
  label?: string;
};

type State = { error: Error | null };

/**
 * Surface-level error boundary. Without this, an exception during a
 * surface render unmounts the whole React tree and blanks the app —
 * which is what historically masked hooks-order regressions and
 * subtle null derefs from being noticed during development.
 *
 * The fallback explicitly invites a reload + offers an in-app reset
 * (the parent can reset by changing key on this boundary).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface errors to the console with enough context for the dev
    // tools tab. We deliberately don't swallow them silently.
    console.error("[ErrorBoundary]", this.props.label ?? "", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="cos-empty cos-empty-error" role="alert">
          <p>
            <strong>Something broke{this.props.label ? ` in ${this.props.label}` : ""}.</strong>
          </p>
          <p>
            <code>{this.state.error.message}</code>
          </p>
          <p>
            Try navigating to a different surface, or reload the window
            (<kbd>⌘R</kbd>). The error has been logged to the console.
          </p>
          <button
            type="button"
            className="cos-btn cos-btn-ghost"
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: "var(--cos-space-md)" }}
          >
            Dismiss
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
