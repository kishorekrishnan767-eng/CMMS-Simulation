import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { useUi } from "../store/ui";
import { BUILD_D, BUILD_W, FLOOR_H, LEVELS, explodeOffset, floorY } from "./constants";

/**
 * While the floors above the inspected one are lifted off, their outline stays: a thin wire frame of each
 * missing storey (floor edges and corner posts). The tower is still recognisable as a building, and,
 * being lines, it can never hide the machine you are looking at.
 */
export function CutawayOutline() {
  const group = useRef<THREE.Group>(null);
  const edges = useMemo(() => new THREE.EdgesGeometry(new THREE.BoxGeometry(BUILD_W, FLOOR_H, BUILD_D)), []);
  const mat = useMemo(() => new THREE.LineBasicMaterial({ color: "#7d93ad", transparent: true, opacity: 0.55, fog: false }), []);
  const levels = LEVELS.filter((l) => l >= 0);

  useFrame(() => {
    const ui = useUi.getState();
    const g = group.current;
    if (!g) return;
    g.visible = ui.cutaway !== null;
    g.children.forEach((c, i) => {
      const level = levels[i];
      c.visible = ui.cutaway !== null && level > ui.cutaway;
      c.position.y = floorY(level) + FLOOR_H / 2 - 0.2 + explodeOffset(level, ui.explode);
    });
  });

  return (
    <group ref={group} visible={false}>
      {levels.map((l) => (
        <lineSegments key={l} geometry={edges} material={mat} />
      ))}
    </group>
  );
}
