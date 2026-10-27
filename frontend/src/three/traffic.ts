/** The AI traffic cars as the player's car sees them (written by the city's traffic simulation each frame). */
export interface TrafficCar {
  x: number;
  z: number;
  /** Heading: forward = (sin yaw, cos yaw). */
  yaw: number;
  /** Speed along the heading, m/s. */
  v: number;
  /** Body length, m. */
  len: number;
  /** False while the car is hidden (thinned out at night): it neither blocks nor is hit. */
  on: boolean;
}

export const trafficCars: TrafficCar[] = [];
