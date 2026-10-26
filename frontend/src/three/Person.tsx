import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Appearance of one person: colours only; proportions are shared. */
export interface Look {
  chest: string; // shirt, or hi-vis vest for technicians
  sleeve: string;
  pants: string;
  skin: string;
  boots: string;
  hair?: string; // office staff
  hat?: string; // hard hat (technicians)
  stripes?: boolean; // reflective bands on the vest
  lanyard?: string; // ID badge colour (office staff)
}

/** Joint groups of a rig: every animated rotation in the app happens on these. */
export interface Joints {
  root: THREE.Group;
  body: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  hipL: THREE.Group;
  hipR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  elbowL: THREE.Group;
  elbowR: THREE.Group;
}

type V3 = [number, number, number];

/** A geometry part baked into a vertex-coloured, pre-transformed, non-indexed buffer. */
export function part(geo: THREE.BufferGeometry, color: string, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...scale)));
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(arr, 3));
  return g;
}
export const merge = (parts: THREE.BufferGeometry[]) => mergeGeometries(parts, false)!;
export const cap = (r: number, len: number) => new THREE.CapsuleGeometry(r, Math.max(0.001, len - 2 * r), 4, 10);

interface Segments {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  forearm: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
}
const cache = new Map<string, Segments>();

/** One merged geometry per body segment (cached per look): 6 geometries instead of ~35 meshes. */
function segments(look: Look): Segments {
  const key = JSON.stringify(look);
  const hit = cache.get(key);
  if (hit) return hit;
  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const torso = [
    part(box(0.34, 0.16, 0.2), look.pants, [0, 0.06, 0]),
    part(cap(0.19, 0.6), look.chest, [0, 0.34, 0]),
    part(new THREE.SphereGeometry(0.075, 10, 8), look.chest, [-0.2, 0.55, 0]),
    part(new THREE.SphereGeometry(0.075, 10, 8), look.chest, [0.2, 0.55, 0]),
  ];
  if (look.stripes) for (const h of [0.26, 0.42]) torso.push(part(new THREE.CylinderGeometry(0.197, 0.197, 0.035, 16, 1, true), "#dfe3e6", [0, h, 0]));
  if (look.lanyard) {
    torso.push(part(box(0.02, 0.3, 0.012), look.lanyard, [0, 0.4, 0.19]), part(box(0.07, 0.1, 0.01), "#f4f6f8", [0, 0.24, 0.195]));
  }
  const head = [
    part(new THREE.CylinderGeometry(0.055, 0.06, 0.08, 10), look.skin, [0, 0.02, 0]),
    part(new THREE.SphereGeometry(0.12, 16, 12), look.skin, [0, 0.15, 0], [0, 0, 0], [0.95, 1.06, 1]),
  ];
  if (look.hat) {
    head.push(part(new THREE.SphereGeometry(0.138, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), look.hat, [0, 0.215, 0]));
    head.push(part(new THREE.CylinderGeometry(0.16, 0.16, 0.018, 18, 1, false, -Math.PI / 2, Math.PI), look.hat, [0, 0.215, 0.06], [0.08, 0, 0]));
  } else if (look.hair) {
    head.push(part(new THREE.SphereGeometry(0.128, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62), look.hair, [0, 0.17, -0.012], [-0.15, 0, 0]));
  }
  const upperArm = [part(cap(0.062, 0.3), look.sleeve, [0, -0.15, 0])];
  const forearm = [
    part(cap(0.05, 0.28), look.skin, [0, -0.14, 0]),
    part(new THREE.SphereGeometry(0.05, 10, 8), look.skin, [0, -0.29, 0]),
  ];
  const thigh = [part(cap(0.085, 0.46), look.pants, [0, -0.23, 0])];
  const shin = [part(cap(0.075, 0.44), look.pants, [0, -0.22, 0]), part(box(0.13, 0.09, 0.27), look.boots, [0, -0.44, 0.05])];
  const out = { torso: merge(torso), head: merge(head), upperArm: merge(upperArm), forearm: merge(forearm), thigh: merge(thigh), shin: merge(shin) };
  cache.set(key, out);
  return out;
}

const bodyMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.02 });

export const SKINS = ["#c99a78", "#8d6248", "#e0b896", "#a87556", "#6f4a37"];
export const HAIRS = ["#1c1815", "#2b2118", "#4a3322", "#101010", "#6b5a45"];

/**
 * A jointed human figure (≈1.75 m). The parent animates the returned joint groups every frame;
 * `handL` / `handR` mount props (wrench, tablet…) at the hands and `children` attach to the root.
 */
export function Person({ look, onReady, handL, handR, children, castShadow = true }: {
  look: Look;
  onReady: (j: Joints) => void;
  handL?: ReactNode;
  handR?: ReactNode;
  children?: ReactNode;
  castShadow?: boolean;
}) {
  const seg = useMemo(() => segments(look), [look]);
  const j = {
    root: useRef<THREE.Group>(null), body: useRef<THREE.Group>(null), torso: useRef<THREE.Group>(null), head: useRef<THREE.Group>(null),
    hipL: useRef<THREE.Group>(null), hipR: useRef<THREE.Group>(null), kneeL: useRef<THREE.Group>(null), kneeR: useRef<THREE.Group>(null),
    armL: useRef<THREE.Group>(null), armR: useRef<THREE.Group>(null), elbowL: useRef<THREE.Group>(null), elbowR: useRef<THREE.Group>(null),
  };
  useLayoutEffect(() => {
    const out = {} as Joints;
    for (const k of Object.keys(j) as (keyof Joints)[]) out[k] = j[k].current as THREE.Group;
    onReady(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const m = (geometry: THREE.BufferGeometry, shadow = false) => <mesh geometry={geometry} material={bodyMaterial} castShadow={shadow && castShadow} />;
  return (
    <group ref={j.root}>
      <group ref={j.body}>
        <group ref={j.hipL} position={[-0.11, 0.92, 0]}>
          {m(seg.thigh, true)}
          <group ref={j.kneeL} position={[0, -0.44, 0]}>{m(seg.shin)}</group>
        </group>
        <group ref={j.hipR} position={[0.11, 0.92, 0]}>
          {m(seg.thigh, true)}
          <group ref={j.kneeR} position={[0, -0.44, 0]}>{m(seg.shin)}</group>
        </group>
        <group ref={j.torso} position={[0, 0.92, 0]}>
          {m(seg.torso, true)}
          <group ref={j.head} position={[0, 0.66, 0]}>{m(seg.head, true)}</group>
          <group ref={j.armL} position={[-0.25, 0.5, 0]}>
            {m(seg.upperArm)}
            <group ref={j.elbowL} position={[0, -0.28, 0]}>
              {m(seg.forearm)}
              <group position={[0, -0.3, 0]}>{handL}</group>
            </group>
          </group>
          <group ref={j.armR} position={[0.25, 0.5, 0]}>
            {m(seg.upperArm)}
            <group ref={j.elbowR} position={[0, -0.28, 0]}>
              {m(seg.forearm)}
              <group position={[0, -0.3, 0]}>{handR}</group>
            </group>
          </group>
        </group>
      </group>
      {children}
    </group>
  );
}
