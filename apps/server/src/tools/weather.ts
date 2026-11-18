/**
 * 天气查询：和风天气（QWeather）。
 * 免费订阅必须使用控制台分配的专属 API Host（形如 xxx.re.qweatherapi.com），
 * 老的 devapi.qweather.com 只对历史账号生效。
 */

const TIMEOUT_MS = 8000;

export interface WeatherConfig {
  key: string;
  host: string;
}

interface QWeatherNowResponse {
  code?: string;
  now?: {
    temp?: string;
    feelsLike?: string;
    text?: string;
    windDir?: string;
    windScale?: string;
    humidity?: string;
  };
}

interface QWeatherDailyResponse {
  code?: string;
  daily?: Array<{
    fxDate?: string;
    tempMax?: string;
    tempMin?: string;
    textDay?: string;
    textNight?: string;
    windDirDay?: string;
    windScaleDay?: string;
    precip?: string;
  }>;
}

interface QWeatherGeoResponse {
  code?: string;
  location?: Array<{ name?: string; lat?: string; lon?: string; adm2?: string; type?: string }>;
}

function hostIsDedicated(host: string): boolean {
  return host.includes("qweatherapi.com");
}

function buildUrl(config: WeatherConfig, path: string): string {
  const url = new URL(`https://${config.host}${path}`);
  // 专属 Host 用请求头鉴权，老的 devapi/geoapi 用 key 查询参数。
  if (!hostIsDedicated(config.host)) url.searchParams.set("key", config.key);
  url.searchParams.set("lang", "zh");
  return url.toString();
}

function describeError(code: string | undefined): string {
  switch (code) {
    case "401":
      return "和风天气鉴权失败：检查 API Key 是否填在 QWEATHER_API_KEY";
    case "403":
      return "和风天气拒绝访问：API Key 与 API Host 不匹配，或没有开通该接口";
    case "404":
      return "和风天气没有找到这个位置";
    case "429":
      return "和风天气请求过于频繁，稍后再试";
    default:
      return `和风天气返回错误码 ${code ?? "未知"}`;
  }
}

async function getJson<T>(config: WeatherConfig, path: string): Promise<T> {
  if (!config.key) throw new Error("没有配置和风天气 API Key");

  const headers: Record<string, string> = { "User-Agent": "companion-bot/1.0" };
  if (hostIsDedicated(config.host)) headers["X-QW-Api-Key"] = config.key;

  const response = await fetch(buildUrl(config, path), {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`和风天气 HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** 坐标 → 城市名，失败不影响天气结果。 */
async function lookupPlace(config: WeatherConfig, location: string): Promise<string | undefined> {
  try {
    const data = await getJson<QWeatherGeoResponse>(
      config,
      `/geo/v2/city/lookup?location=${encodeURIComponent(location)}&number=1`,
    );
    if (data.code !== "200") return undefined;
    const first = data.location?.[0];
    if (!first) return undefined;
    // 坐标反查常返回区县，播报用上级城市名更自然。
    return first.type === "district" && first.adm2 ? first.adm2 : first.name;
  } catch {
    return undefined;
  }
}

async function buildWeatherText(
  config: WeatherConfig,
  location: string,
  label?: string,
): Promise<string> {
  const [now, daily, placeName] = await Promise.all([
    getJson<QWeatherNowResponse>(
      config,
      `/v7/weather/now?location=${encodeURIComponent(location)}`,
    ),
    getJson<QWeatherDailyResponse>(
      config,
      `/v7/weather/3d?location=${encodeURIComponent(location)}`,
    ).catch(() => undefined),
    label ? Promise.resolve(label) : lookupPlace(config, location),
  ]);

  if (now.code !== "200" || !now.now) throw new Error(describeError(now.code));

  const current = now.now;
  const parts = [`${placeName ?? "你那边"}现在 ${current.temp} 度`];
  if (current.text) parts.push(current.text);
  if (current.feelsLike) parts.push(`体感 ${current.feelsLike} 度`);
  if (current.windDir) parts.push(`${current.windDir} ${current.windScale ?? ""} 级`.trim());
  if (current.humidity) parts.push(`湿度 ${current.humidity}%`);

  const today = daily?.daily?.[0];
  if (daily?.code === "200" && today?.tempMin && today?.tempMax) {
    parts.push(`今天 ${today.tempMin} 到 ${today.tempMax} 度`);
  }
  const forecast = formatUpcomingForecast(daily);
  const suffix = forecast.length ? ` 未来两天：${forecast.join("；")}。` : "";
  return `天气：${parts.join("，")}。${suffix}`;
}

/** 明后两天的预报，供模型回答「明天/后天要不要带伞」这类问题。 */
function formatUpcomingForecast(data: QWeatherDailyResponse | undefined): string[] {
  if (data?.code !== "200" || !data.daily?.length) return [];
  const lines: string[] = [];
  data.daily.slice(1, 3).forEach((day, offset) => {
    const label = offset === 0 ? "明天" : "后天";
    const date = day.fxDate ? `（${day.fxDate.slice(5).replace("-", "/")}）` : "";
    const range = day.tempMin && day.tempMax ? `${day.tempMin} 到 ${day.tempMax} 度` : "";
    const weather = [day.textDay, range].filter(Boolean).join("，");
    if (!weather && !date) return;
    lines.push(`${label}${date} ${weather}`.trim());
  });
  return lines;
}

/** 按坐标查天气（浏览器定位或模型传入的坐标）。 */
export async function fetchWeather(
  config: WeatherConfig,
  latitude: number,
  longitude: number,
): Promise<string> {
  // 和风天气的 location 是「经度,纬度」。
  return buildWeatherText(config, `${longitude.toFixed(4)},${latitude.toFixed(4)}`);
}

/** 用户明确提到城市时按城市名查天气。 */
export async function fetchWeatherByCity(config: WeatherConfig, city: string): Promise<string> {
  const data = await getJson<QWeatherGeoResponse>(
    config,
    `/geo/v2/city/lookup?location=${encodeURIComponent(city)}&number=1`,
  );
  if (data.code !== "200") throw new Error(describeError(data.code));
  const first = data.location?.[0];
  if (!first?.lon || !first?.lat) throw new Error(`没有找到城市「${city}」`);
  return buildWeatherText(config, `${first.lon},${first.lat}`, first.name ?? city);
}
