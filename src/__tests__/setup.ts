import { vi } from "vitest";

// Suppress console.error noise in tests
vi.spyOn(console, "error").mockImplementation(() => {});
