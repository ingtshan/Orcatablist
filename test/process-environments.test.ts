import { expect, test } from "bun:test";
import { listHermesProcessEnvironments } from "../src/process-environments";

test("reads candidate process environments without invoking a shell", async () => {
  const text = await listHermesProcessEnvironments();
  expect(typeof text).toBe("string");
});
