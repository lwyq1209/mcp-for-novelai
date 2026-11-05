import { plainErrorMessage, stripHostErrorSuffixes } from "../host-errors/bridge";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { uiLangOf, uiText } from "../ui/i18n";

interface AppErrorBoundaryProps {
  children: ReactNode;
  scope: string;
  resetKey?: unknown;
  root?: boolean;
  /** Wraps the error card (an overlay boundary places it over the window). */
  fallbackWrap?: (card: ReactNode) => ReactNode;
  /** Replaces the default card (its own text and ways out); retry clears the error, copy copies the details. */
  renderFallback?: (failure: { error: Error; retry: () => void; copy: () => void }) => ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { error: asError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[render:${this.props.scope}]`, error, info.componentStack);
  }

  componentDidUpdate(previous: AppErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private retry = () => this.setState({ error: null });

  private copyDetails = () => {
    // Copied text has no host error suffix (host-errors/bridge.ts); a stack repeats the message.
    const details = stripHostErrorSuffixes(this.state.error?.stack || this.state.error?.message || "Unknown render error");
    void navigator.clipboard?.writeText(details).catch((error) => {
      console.error(`[render:${this.props.scope}:copy]`, error);
    });
  };

  render() {
    if (!this.state.error) return this.props.children;
    // Read only for the default card: a custom fallback (renderFallback) may render without a document (tests).
    const t = (key: Parameters<typeof uiText>[1]) => uiText(uiLangOf(document.documentElement.lang), key);
    const card = this.props.renderFallback ? this.props.renderFallback({ error: this.state.error, retry: this.retry, copy: this.copyDetails }) : (
      <section className={this.props.root ? "app-error-boundary is-root" : "app-error-boundary"} role="alert">
        <strong>{t("eb.title")}</strong>
        <p>{t(this.props.root ? "eb.root" : "eb.page")}</p>
        <code>{plainErrorMessage(this.state.error)}</code>
        <div>
          <button type="button" onClick={this.retry}>{t("c.retry")}</button>
          <button type="button" onClick={this.copyDetails}>{t("eb.copy")}</button>
          {this.props.root && <button type="button" onClick={() => window.location.reload()}>{t("eb.reload")}</button>}
        </div>
      </section>
    );
    return this.props.fallbackWrap ? this.props.fallbackWrap(card) : card;
  }
}
