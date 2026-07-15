import { describe, expect, it } from "vitest";
import { apiUrl } from "./index.js";

describe("e2e placeholder", () => {
  it("joins base and path into an absolute URL", () => {
    expect(apiUrl("http://localhost:3000", "/api/v1/health")).toBe(
      "http://localhost:3000/api/v1/health",
    );
  });
});
