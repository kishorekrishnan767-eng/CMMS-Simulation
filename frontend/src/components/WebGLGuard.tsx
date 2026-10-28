import { Component, type ReactNode } from "react";

let probed: boolean | null = null;

/**
 * Whether this browser can create a WebGL context. Asked ONCE and the probe context is released at once:
 * browsers allow only ~16 live contexts and then silently kill the oldest, which is the real 3D scene. The
 * guard re-renders whenever the page does (every 0.7 s while the one-minute run is polled), so probing on
 * every render leaked a context each time and turned the office white after about ten seconds.
 */
function webglAvailable() {
  if (probed !== null) return probed;
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") || c.getContext("webgl")) as WebGLRenderingContext | WebGL2RenderingContext | null;
    probed = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    probed = false;
  }
  return probed;
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
