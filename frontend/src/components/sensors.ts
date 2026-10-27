/** Short names and units for the sensors, shared by the panels that list them. */
export const SENSOR_NAME: Record<string, string> = {
  vibration_velocity: "Vibration",
  bearing_temperature: "Temperature",
  motor_current: "Current",
  speed_command: "Speed",
};
export const SENSOR_UNIT: Record<string, string> = { vibration_velocity: "mm/s", bearing_temperature: "°C", motor_current: "A", speed_command: "%" };

export const sensorName = (metric: string) => SENSOR_NAME[metric] ?? metric.replaceAll("_", " ");
export const fmtSensor = (metric: string, v: number | undefined) =>
  v === undefined ? "—" : `${v.toFixed(metric === "speed_command" ? 0 : 2)} ${SENSOR_UNIT[metric] ?? ""}`.trim();
