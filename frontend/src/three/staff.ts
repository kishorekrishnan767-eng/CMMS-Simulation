import { EMPLOYEES, routeToDesk, type Employee } from "./office";
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

/**
 * Where an employee is: at their desk, always. Nobody arrives, leaves or goes home; the product has no
 * working day, so everyone works at every moment (the walk-in route is kept only for the preview camera).
 */
export function staffPose(e: Employee, _ms: number): StaffPose {
  const r = route(e);
  const task = e.team === "Building management" ? "monitoring the building (BMS)" : "working at the desk";
  return { ...sampleAt(r, 1), phase: "seated", text: task, seatedYaw: e.seat.yaw };
}

export const employeeById = (id: string) => EMPLOYEES.find((e) => e.id === id);
export const fmtHour = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
