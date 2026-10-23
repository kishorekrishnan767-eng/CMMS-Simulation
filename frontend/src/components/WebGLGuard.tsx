import { Component, type ReactNode } from "react";

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) return <Fallback reason={this.state.error.message} />;
    return this.props.children;
  }
}

function Fallback({ reason }: { reason: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center" role="alert">
      <div className="max-w-md">
        <div className="text-lg font-semibold">The 3D view needs WebGL</div>
        <p className="mt-1 text-sm text-muted">Your browser could not start WebGL ({reason}). All data, work orders and analytics still work in the other pages.</p>
      </div>
    </div>
  );
}

/** Falls back gracefully when WebGL is unavailable or the scene throws. */
export default function WebGLGuard({ children }: { children: ReactNode }) {
  if (!webglAvailable()) return <Fallback reason="no WebGL context" />;
  return <Boundary>{children}</Boundary>;
}
