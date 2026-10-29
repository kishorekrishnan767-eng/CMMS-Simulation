import { useAsset, useWalkthrough } from "../api/queries";
import { usePlayer } from "../store/player";
import { useUi } from "../store/ui";
import { beatFor } from "./walkStory";

/**
 * The film dressing over the 3D view while the run plays: letterbox bars, a soft vignette and a chapter title that
 * changes with each step. It sits under the side panels and never takes a click (any mouse input on the 3D view still
 * ends the film, as before).
 */
export default function CinematicOverlay() {
  const { data: wt } = useWalkthrough();
  const cinematic = useUi((s) => s.cinematic);
  const controlling = usePlayer((s) => s.active);
  const { data: asset } = useAsset(wt?.asset_id ?? null);
  const on = !!wt?.busy && cinematic && !controlling && wt.phase !== "idle";
  const beat = on && wt && asset ? beatFor(wt, asset) : null;
  return (
    <div className="cine" data-on={on} aria-hidden data-testid="cine">
      <div className="cine-bar cine-bar-top" />
      <div className="cine-vignette" />
      <div className="cine-bar cine-bar-bottom" />
      {beat && (
        <div key={beat.title} className="cine-caption" data-testid="cine-caption">
          <div className="cine-kicker">{beat.kicker}</div>
          <div className="cine-title">
            <span aria-hidden>{beat.icon}</span> {beat.title}
          </div>
        </div>
      )}
    </div>
  );
}
