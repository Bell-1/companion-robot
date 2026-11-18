import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearUserLocation,
  describeLocation,
  getUserLocation,
  isValidCoordinate,
  setUserLocation,
} from "./location";

test("定位：合法坐标可存取，非法坐标直接忽略", () => {
  setUserLocation("loc-test", { latitude: 31.2304, longitude: 121.4737, accuracy: 35 });
  const stored = getUserLocation("loc-test");
  assert.equal(stored?.latitude, 31.2304);
  assert.ok(stored && stored.updatedAt > 0);
  assert.match(describeLocation(stored!), /纬度 31\.2304/);

  setUserLocation("loc-test", { latitude: 100, longitude: 0 });
  assert.equal(getUserLocation("loc-test")?.latitude, 31.2304);

  clearUserLocation("loc-test");
  assert.equal(getUserLocation("loc-test"), undefined);
});

test("定位：坐标范围校验", () => {
  assert.equal(isValidCoordinate(31.2, 121.5), true);
  assert.equal(isValidCoordinate(91, 0), false);
  assert.equal(isValidCoordinate(0, 181), false);
  assert.equal(isValidCoordinate(Number.NaN, 0), false);
});
