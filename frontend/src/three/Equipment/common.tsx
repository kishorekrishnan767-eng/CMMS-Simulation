import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { Asset, Health } from "../../api/types";
import { useLive } from "../../store/live";
import { useUi } from "../../store/ui";
import { ASSET_LAYOUT, HEALTH_COLOR, PALETTE } from "../constants";

/** Mutable per-asset visual state, refreshed every frame from the live store (no React re-render). */
export interface Visual {
  color: THREE.Color;
  pulse: number;
  health: Health;
  repair: boolean;
  offline: boolean;
  speedPct: number;
  omega: number;
  vib: number;
  wobble: number;
  temp: number;
  tempNorm: number;
  current: number;
  selected: boolean;
  hovered: boolean;
}

export const VisualCtx = createContext<{ current: Visual } | null>(null);
export const useVisual = () => {
  const v = useContext(VisualCtx);
  if (!v) throw new Error("useVisual outside AssetFrame");
  return v;
};

const haloTexture = (() => {
  let tex: THREE.CanvasTexture | null = null;
  return () => {
    if (tex) return tex;
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 2, 64, 64, 62);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.35)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    tex = new THREE.CanvasTexture(c);
    return tex;
  };
})();

const tmp = new THREE.Color();

/** Frame around one asset: interaction, selection ring, health halo, label and live visual state. */
export function AssetFrame({ asset, radius = 3, children, sensors }: { asset: Asset; radius?: number; children: ReactNode; sensors?: [number, number, number][] }) {
  const vis = useRef<Visual>({
    color: new THREE.Color(PALETTE.ok), pulse: 0, health: asset.health_state, repair: false, offline: false, speedPct: 80, omega: 0,
    vib: 1.6, wobble: 0, temp: 50, tempNorm: 0, current: 8, selected: false, hovered: false,
  });
  const halo = useRef<THREE.Sprite>(null);
  const disc = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const selected = useUi((s) => s.selectedAssetId === asset.id);
  const showLabels = useUi((s) => s.showLabels);
  const layout = ASSET_LAYOUT[asset.asset_type] ?? ASSET_LAYOUT.PUMP;
  const haloTex = useMemo(() => haloTexture(), []);

  useFrame((state, delta) => {
    const v = vis.current;
    const live = useLive.getState();
    const ui = useUi.getState();
    const health = live.health[asset.id] ?? asset.health_state;
    const vals = live.values[asset.id] ?? {};
    v.health = health;
    v.repair = asset.status === "UNDER_MAINTENANCE";
    v.offline = asset.status === "OFFLINE";
    v.speedPct = vals.speed_command ?? v.speedPct;
    v.vib = vals.vibration_velocity ?? v.vib;
    v.temp = vals.bearing_temperature ?? v.temp;
    v.current = vals.motor_current ?? v.current;
    const clockRunning = live.clock.running;
    v.omega = v.offline || v.repair ? THREE.MathUtils.damp(v.omega, 0, 3, delta) : THREE.MathUtils.damp(v.omega, (v.speedPct / 100) * 13 * (clockRunning ? 1 : 0.15), 2.5, delta);
    // exaggerated, clamped wobble: healthy vibration (≈1.3–2.0 mm/s) is calm, faults shake visibly
    const target = v.repair ? 0 : Math.min(0.2, Math.max(0, v.vib - 1.9) * 0.028) * (clockRunning ? 1 : 0.5);
    v.wobble = THREE.MathUtils.damp(v.wobble, target, 4, delta);
    v.tempNorm = THREE.MathUtils.clamp((v.temp - 52) / 12, 0, 1);
    const targetColor = v.offline ? PALETTE.offline : v.repair ? PALETTE.repair : HEALTH_COLOR[health];
    v.color.lerp(tmp.set(targetColor), 1 - Math.exp(-delta * 4));
    const freq = health === "ANOMALY" ? 2.6 : health === "WATCH" ? 1.2 : 0;
    const amp = health === "ANOMALY" ? 0.35 : health === "WATCH" ? 0.18 : 0;
    v.pulse = ui.reducedMotion || !freq ? 0 : (0.5 + 0.5 * Math.sin(state.clock.elapsedTime * freq * Math.PI * 2)) * amp;
    v.selected = ui.selectedAssetId === asset.id;
    v.hovered = hovered;

    if (halo.current) {
      const m = halo.current.material as THREE.SpriteMaterial;
      m.color.copy(v.color);
      m.opacity = (health === "NORMAL" || health === "CLEARED" ? 0.28 : 0.55) + v.pulse * 0.8 + (v.selected ? 0.15 : 0);
      const s = radius * 2.4 * (1 + v.pulse * 0.35);
      halo.current.scale.set(s, s, 1);
    }
    if (disc.current) {
      const m = disc.current.material as THREE.MeshBasicMaterial;
      m.color.copy(v.color);
      m.opacity = 0.16 + v.pulse * 0.5;
    }
    if (ring.current) {
      ring.current.visible = v.selected || hovered;
      (ring.current.material as THREE.MeshBasicMaterial).color.set(v.selected ? PALETTE.teal : "#ffffff");
      ring.current.rotation.z += delta * 0.6;
    }
  });

  return (
    <VisualCtx.Provider value={vis}>
      <group
        position={[asset.position.x, 0, asset.position.z]}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "";
        }}
        onClick={(e) => {
          e.stopPropagation();
          useUi.getState().selectAsset(asset.id);
        }}
        userData={{ assetId: asset.id }}
      >
        {children}
        <mesh ref={disc} rotation-x={-Math.PI / 2} position={[0, 0.03, 0]}>
          <circleGeometry args={[radius * 1.05, 40]} />
          <meshBasicMaterial transparent opacity={0.2} depthWrite={false} />
        </mesh>
        <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.06, 0]}>
          <ringGeometry args={[radius * 1.1, radius * 1.18, 48, 1, 0, Math.PI * 1.6]} />
          <meshBasicMaterial transparent opacity={0.95} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
        <sprite ref={halo} position={[0, layout.pinY * 0.35, 0]}>
          <spriteMaterial map={haloTex} transparent depthWrite={false} blending={THREE.AdditiveBlending} />
        </sprite>
        {sensors && <SensorMarkers asset={asset} positions={sensors} active={selected || hovered} />}
        {showLabels && (
          <Html position={[0, layout.pinY + 0.9, 0]} center distanceFactor={26} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
            <div className={`asset-chip ${selected ? "is-selected" : ""}`} data-testid={`chip-${asset.id}`}>
              <HealthDot id={asset.id} fallback={asset.health_state} />
              <span>{asset.id}</span>
            </div>
          </Html>
        )}
      </group>
    </VisualCtx.Provider>
  );
}

function HealthDot({ id, fallback }: { id: string; fallback: Health }) {
  const health = useLive((s) => s.health[id] ?? fallback);
  return <i className={`dot dot-${health.toLowerCase()}`} />;
}

const SENSOR_ORDER = ["vibration_velocity", "bearing_temperature", "motor_current", "speed_command"];

/** Small glowing sensor markers with billboard labels (labels shown when the asset is active). */
function SensorMarkers({ asset, positions, active }: { asset: Asset; positions: [number, number, number][]; active: boolean }) {
  const showSensors = useUi((s) => s.showSensors);
  const sensors = useMemo(() => [...asset.sensors].sort((a, b) => SENSOR_ORDER.indexOf(a.metric) - SENSOR_ORDER.indexOf(b.metric)), [asset.sensors]);
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  useFrame((state) => {
    refs.current.forEach((m, i) => {
      if (!m) return;
      const s = 1 + 0.18 * Math.sin(state.clock.elapsedTime * 3 + i);
      m.scale.setScalar(s);
    });
  });
  if (!showSensors) return null;
  return (
    <>
      {sensors.map((s, i) => {
        const p = positions[i % positions.length];
        const stale = s.quality !== "GOOD";
        return (
          <group key={s.id} position={p}>
            <mesh ref={(m) => (refs.current[i] = m)}>
              <octahedronGeometry args={[0.14, 0]} />
              <meshBasicMaterial color={stale ? PALETTE.watch : PALETTE.teal} />
            </mesh>
            {active && (
              <Html center distanceFactor={14} position={[0, 0.34, 0]} zIndexRange={[19, 0]} style={{ pointerEvents: "none" }}>
                <SensorTag id={s.id} metric={s.metric} unit={s.unit} assetId={asset.id} />
              </Html>
            )}
          </group>
        );
      })}
    </>
  );
}

function SensorTag({ id, metric, unit, assetId }: { id: string; metric: string; unit: string; assetId: string }) {
  const v = useLive((s) => s.values[assetId]?.[metric]);
  return (
    <div className="sensor-tag">
      <b>{id}</b> {v === undefined ? "—" : v.toFixed(metric === "speed_command" ? 0 : 2)} {unit}
    </div>
  );
}

export const mat = {
  steel: new THREE.MeshStandardMaterial({ color: "#c3ced6", metalness: 0.7, roughness: 0.38 }),
  steelDark: new THREE.MeshStandardMaterial({ color: "#55636d", metalness: 0.6, roughness: 0.5 }),
  housing: new THREE.MeshStandardMaterial({ color: "#d5dde2", metalness: 0.35, roughness: 0.55 }),
  plinth: new THREE.MeshStandardMaterial({ color: "#2f3b44", roughness: 0.8 }),
  rubber: new THREE.MeshStandardMaterial({ color: "#161c20", roughness: 0.9 }),
  blade: new THREE.MeshStandardMaterial({ color: "#aebbc4", metalness: 0.5, roughness: 0.35 }),
  motor: new THREE.MeshStandardMaterial({ color: "#2c6f8f", metalness: 0.5, roughness: 0.45 }),
  cold: new THREE.MeshStandardMaterial({ color: PALETTE.pipeCold, metalness: 0.4, roughness: 0.4 }),
  hot: new THREE.MeshStandardMaterial({ color: PALETTE.pipeHot, metalness: 0.4, roughness: 0.4 }),
};

/** Status light bar whose colour follows the asset's smoothed health colour. */
export function StatusBar({ position, size }: { position: [number, number, number]; size: [number, number, number] }) {
  const v = useVisual();
  const m = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    if (!m.current) return;
    m.current.color.copy(v.current.color);
    m.current.emissive.copy(v.current.color);
    m.current.emissiveIntensity = 0.9 + v.current.pulse * 2.4;
  });
  return (
    <mesh position={position}>
      <boxGeometry args={size} />
      <meshStandardMaterial ref={m} color="#2fe0a0" emissive="#2fe0a0" emissiveIntensity={1} />
    </mesh>
  );
}

/** Hot-spot glow at a bearing: colour and size scale with bearing temperature; rising haze when hot. */
export function BearingHotspot({ position, radius = 0.2 }: { position: [number, number, number]; radius?: number }) {
  const v = useVisual();
  const m = useRef<THREE.MeshStandardMaterial>(null);
  const sprite = useRef<THREE.Sprite>(null);
  const haze = useRef<THREE.Points>(null);
  const q = useUi((s) => s.quality);
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(24 * 3), 3));
    return g;
  }, []);
  const seeds = useMemo(() => Array.from({ length: 24 }, (_, i) => ({ p: (i * 0.173) % 1, a: i * 2.399, r: 0.05 + ((i * 37) % 10) / 80 })), []);
  const haloTex = useMemo(() => haloTexture(), []);
  useFrame((state) => {
    const t = v.current.tempNorm;
    if (m.current) {
      m.current.color.setRGB(0.35 + 0.65 * t, 0.2 + 0.1 * (1 - t), 0.15);
      m.current.emissive.setRGB(1, 0.35 + 0.4 * (1 - t), 0.1);
      m.current.emissiveIntensity = 0.1 + t * 3.2;
    }
    if (sprite.current) {
      const s = 0.4 + t * 1.5;
      sprite.current.scale.set(s, s, 1);
      (sprite.current.material as THREE.SpriteMaterial).opacity = t * 0.9;
    }
    if (haze.current) {
      haze.current.visible = t > 0.35 && q !== "low";
      if (haze.current.visible) {
        const arr = geo.attributes.position.array as Float32Array;
        seeds.forEach((s, i) => {
          const ph = (s.p + state.clock.elapsedTime * 0.35) % 1;
          arr[i * 3] = Math.cos(s.a + ph * 2) * s.r * (1 + ph * 2);
          arr[i * 3 + 1] = ph * 1.8;
          arr[i * 3 + 2] = Math.sin(s.a + ph * 2) * s.r * (1 + ph * 2);
        });
        geo.attributes.position.needsUpdate = true;
        (haze.current.material as THREE.PointsMaterial).opacity = (t - 0.3) * 0.7;
      }
    }
  });
  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[radius, 16, 12]} />
        <meshStandardMaterial ref={m} color="#555" emissive="#ff6a2a" emissiveIntensity={0.1} />
      </mesh>
      <sprite ref={sprite}>
        <spriteMaterial map={haloTex} color="#ff7a3a" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <points ref={haze} geometry={geo}>
        <pointsMaterial color="#ffb08a" size={0.16} transparent opacity={0} depthWrite={false} sizeAttenuation />
      </points>
    </group>
  );
}
