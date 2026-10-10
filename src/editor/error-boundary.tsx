import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from '../net/telemetry';
import './error-boundary.css';

/** The app's last resort: a render error anywhere below is reported and the page offers a reload instead of going blank.
 * The report names where the error was thrown, or, with no stack, the component that threw. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // The component stack's first line names the component: `at Name (url)`, or `Name@url` outside Chromium.
    const name = /^\s*(?:at\s+)?([^\s@(]+)/m.exec((info.componentStack ?? '').trimStart())?.[1];
    reportError(error, name);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="error-boundary" role="alert">
      <h1>Something went wrong</h1>
      <p>Plateway hit an error it could not recover from. Reload the page to carry on.</p>
      <button type="button" className="primary-button" onClick={() => window.location.reload()}>Reload</button>
    </main>;
  }
}
