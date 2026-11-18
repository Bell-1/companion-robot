/** 浏览器上报的定位，按会话保存在进程内；重启或换会话需要前端重新上报。 */
export interface UserLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
  label?: string;
  updatedAt: number;
}

const store = new Map<string, UserLocation>();

export function isValidCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export function setUserLocation(
  sessionId: string,
  location: Omit<UserLocation, "updatedAt">,
): void {
  if (!isValidCoordinate(location.latitude, location.longitude)) return;
  store.set(sessionId, { ...location, updatedAt: Date.now() });
}

export function getUserLocation(sessionId: string): UserLocation | undefined {
  return store.get(sessionId);
}

export function clearUserLocation(sessionId: string): void {
  store.delete(sessionId);
}

/** 给模型看的定位描述，保留一位小数即可，不必暴露过高的精度。 */
export function describeLocation(location: UserLocation): string {
  const lat = location.latitude.toFixed(4);
  const lon = location.longitude.toFixed(4);
  const parts = [`纬度 ${lat}`, `经度 ${lon}`];
  if (location.label) parts.push(`大致位置 ${location.label}`);
  if (location.accuracy) parts.push(`精度约 ${Math.round(location.accuracy)} 米`);
  return parts.join("，");
}
