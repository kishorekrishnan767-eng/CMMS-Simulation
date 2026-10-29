export interface HelicopterInput {
  throttle: number;
  pitch: number;
  roll: number;
  yaw: number;
  brake: boolean;
}

export const helicopter = {
  x: 30.5,
  y: 2.2,
  z: 17,
  yaw: 0,
  pitch: 0,
  roll: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  rotor: 0,
};

export function resetHelicopter() {
  Object.assign(helicopter, {
    x: 30.5,
    y: 2.2,
    z: 17,
    yaw: 0,
    pitch: 0,
    roll: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    rotor: 0,
  });
}

export function stepHelicopter(inp: HelicopterInput, dt: number): void {
  const c = helicopter;
  const targetRotor = 22 + Math.max(0, inp.throttle) * 18;
  c.rotor += (targetRotor - c.rotor) * Math.min(1, dt * 4.5);

  const yawRate = inp.yaw * 1.8;
  const pitchRate = inp.pitch * 1.4;
  const rollRate = inp.roll * 1.9;
  c.yaw += yawRate * dt;
  c.pitch += pitchRate * dt;
  c.roll += rollRate * dt;

  const forward = [Math.sin(c.yaw), Math.cos(c.yaw)] as const;
  const right = [-Math.cos(c.yaw), Math.sin(c.yaw)] as const;

  const speedLimit = 24 + inp.throttle * 10;
  const targetVx = (forward[0] * inp.pitch * 13 + right[0] * inp.roll * 11) * (1 + inp.throttle * 0.35);
  const targetVz = (forward[1] * inp.pitch * 13 + right[1] * inp.roll * 11) * (1 + inp.throttle * 0.35);

  c.vx += (targetVx - c.vx) * (1 - Math.exp(-9 * dt));
  c.vz += (targetVz - c.vz) * (1 - Math.exp(-9 * dt));

  const speed = Math.hypot(c.vx, c.vz);
  if (speed > speedLimit) {
    const scale = speedLimit / speed;
    c.vx *= scale;
    c.vz *= scale;
  }

  const lift = Math.max(0, c.rotor - 18) * 1.35 + inp.throttle * 9.2;
  c.vy += ((lift - 9.8) + Math.cos(c.pitch) * -1.5) * dt;
  c.vy *= 1 - Math.min(0.8, dt * 1.5);

  if (inp.brake) {
    c.vx *= 1 - Math.min(0.9, dt * 7);
    c.vz *= 1 - Math.min(0.9, dt * 7);
    c.vy *= 1 - Math.min(0.9, dt * 5);
  }

  c.x += c.vx * dt;
  c.z += c.vz * dt;
  c.y += c.vy * dt;

  if (c.y < 1.8) {
    c.y = 1.8;
    c.vy = Math.max(0, c.vy) * 0.2;
  }

  if (c.y > 70) c.y = 70;
  if (c.x < -85) c.x = -85;
  if (c.x > 85) c.x = 85;
  if (c.z < -85) c.z = -85;
  if (c.z > 85) c.z = 85;

  c.pitch = Math.max(-1.2, Math.min(1.2, c.pitch));
  c.roll = Math.max(-1.3, Math.min(1.3, c.roll));
}

export default helicopter;
