import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEVELOPER_SURFACES_CHANGED_EVENT,
  readShowDeveloperSurfaces,
  writeShowDeveloperSurfaces,
} from "./developerSurfaces";

describe("developerSurfaces", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults to false when nothing is stored", () => {
    expect(readShowDeveloperSurfaces()).toBe(false);
  });

  it("round-trips a true value through localStorage", () => {
    writeShowDeveloperSurfaces(true);
    expect(readShowDeveloperSurfaces()).toBe(true);
    writeShowDeveloperSurfaces(false);
    expect(readShowDeveloperSurfaces()).toBe(false);
  });

  it("emits a CustomEvent when the value changes", () => {
    const listener = vi.fn();
    window.addEventListener(DEVELOPER_SURFACES_CHANGED_EVENT, listener);
    writeShowDeveloperSurfaces(true);
    expect(listener).toHaveBeenCalledTimes(1);
    writeShowDeveloperSurfaces(false);
    expect(listener).toHaveBeenCalledTimes(2);
    window.removeEventListener(DEVELOPER_SURFACES_CHANGED_EVENT, listener);
  });

  it("treats any non-'true' string as false", () => {
    window.localStorage.setItem("cos.show-developer-surfaces.v1", "yes");
    expect(readShowDeveloperSurfaces()).toBe(false);
  });
});
