import React from "react";

/**
 * The difference between a bug and a blank screen.
 *
 * Without this, any error thrown while rendering unmounts the whole
 * application and leaves white. That is what a teacher reports as "the meeting
 * is blank", and it says nothing at all about which of forty components was at
 * fault -- the last one cost a `ReferenceError` in a dependency array and a
 * round of guessing to find.
 *
 * So: keep the message, show it, and give a way out of it. A class is waiting,
 * so the first thing offered is the one that usually works.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The console is where this gets diagnosed from, so the component stack
    // goes there whole rather than being summarised on screen.
    console.error("[ErrorBoundary] render failed", error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="boundary">
        <div className="boundary-card">
          <h2>Something in the meeting stopped working</h2>
          <p>
            The meeting itself is still running. Reloading this page rejoins it — nothing you
            have drawn or recorded is lost.
          </p>
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>
            Reload and rejoin
          </button>
          {/* Named, not hidden: whoever is on the phone to support needs to be
              able to read this out, and it is the first thing anybody fixing
              it will ask for. */}
          <pre className="boundary-detail">{String(error?.message || error)}</pre>
        </div>
      </div>
    );
  }
}
