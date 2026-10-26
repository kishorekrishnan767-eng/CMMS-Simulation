import { floorLabel, hourOfDay, isWeekend } from "./constants";
import { EMPLOYEES, WALK_MINUTES, routeToDesk, type Employee } from "./office";
import { sampleAt, type Sample, type Waypoint } from "./techPath";

export type StaffPhase = "away" | "arriving" | "seated" | "leaving";

export interface StaffPose extends Sample {
  phase: StaffPhase;
  text: string;
  /** Floor-local seated yaw (valid when seated). */
  seatedYaw: number;
}

const routes = new Map<string, Waypoint[]>();
export function route(e: Employee) {
  let r = routes.get(e.id);
  if (!r) {
    r = routeToDesk(e);
    routes.set(e.id, r);
  }
  return r;
}

const away = (e: Employee): StaffPose => {
  const r = route(e);
  return { ...sampleAt(r, 0), phase: "away", text: "not at work", seatedYaw: e.seat.yaw };
};

/**
 * Where an employee is at sim time `ms`, derived only from the clock (no stored state):
 *   arrive … arrive + WALK_MINUTES   walking street → desk
 *   … leave                          seated at the desk
 *   leave … leave + WALK_MINUTES     walking desk → street
 * Weekends: nobody is in. Walk fraction f = (minutes since arrive) / WALK_MINUTES.
 */
export function staffPose(e: Employee, ms: number): StaffPose {
  if (isWeekend(ms)) return away(e);
  const h = hourOfDay(ms);
  const walk = WALK_MINUTES / 60;
  const r = route(e);
  const floor = floorLabel(e.seat.level);
  const task = e.team === "Building management" ? "monitoring the building (BMS)" : "working at the desk";
  if (h < e.arrive || h >= e.leave + walk) return away(e);
  if (h < e.arrive + walk) {
    const s = sampleAt(r, (h - e.arrive) / walk);
    return { ...s, phase: "arriving", text: s.inLift ? `in the lift to ${floor}` : s.level < 0.01 && s.z > 12 ? "arriving at work" : "walking to the desk", seatedYaw: e.seat.yaw };
  }
  if (h < e.leave) return { ...sampleAt(r, 1), phase: "seated", text: task, seatedYaw: e.seat.yaw };
  const s = sampleAt([...r].reverse(), (h - e.leave) / walk);
  return { ...s, phase: "leaving", text: s.inLift ? "in the lift going home" : "leaving for the day", seatedYaw: e.seat.yaw };
}

export const employeeById = (id: string) => EMPLOYEES.find((e) => e.id === id);
export const fmtHour = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
