import { useWalkthrough } from "../api/queries";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { jumpToDesk } from "../three/player";

/** Shown while Kishore is under keyboard control: the keys, the floor or the speed, and a hint when something is within reach. */
export default function PlayerHud() {
  const active = usePlayer((s) => s.active);
  const prompt = usePlayer((s) => s.prompt);
  const level = usePlayer((s) => s.level);
  const seated = usePlayer((s) => s.seated);
  const speed = usePlayer((s) => s.speed);
  const { data: wt } = useWalkthrough();
  if (!active) return null;
  const driving = prompt?.startsWith("W gas") ?? false;
  const waiting = !!wt?.started && wt.stage === 3 && !wt.busy;
  const note = driving ? null : seated ? (waiting ? "Approving the work order…" : wt?.started ? "Nothing to approve right now." : null) : prompt;
  return (
    <>
      <div className="glass fade-in pointer-events-auto absolute bottom-[6.6rem] left-1/2 z-30 flex max-w-[94vw] -translate-x-1/2 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line px-3 py-2 text-[12.5px]" data-testid="player-hud">
        <b>{driving ? `Driving · ${speed} km/h` : `Kishore · ${level === 0 ? "Ground" : `Floor ${level}`}`}</b>
        <span className="text-muted">
          {driving ? (
            <><kbd>W</kbd> gas · <kbd>S</kbd> brake · <kbd>A</kbd><kbd>D</kbd> steer · <kbd>Space</kbd> handbrake · <kbd>Shift</kbd> boost · <kbd>E</kbd> park</>
          ) : (
            <><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk · <kbd>Shift</kbd> run · <kbd>E</kbd> desk / car · drag to look · <kbd>Esc</kbd> stop</>
          )}
        </span>
        <button className="btn btn-sm" onClick={() => { jumpToDesk(); useUi.getState().fly({ preset: "player" }); }}>Jump to desk</button>
        <button className="btn btn-sm" onClick={() => usePlayer.getState().set({ active: false })}>Stop</button>
      </div>
      {note && (
        <div className="glass fade-in pointer-events-none absolute bottom-[10rem] left-1/2 z-30 -translate-x-1/2 rounded-md border border-accent/50 px-4 py-2 text-[13.5px] font-semibold" role="status" data-testid="player-prompt">
          {note}
        </div>
      )}
    </>
  );
}
