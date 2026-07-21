import { describe, expect, it } from "vitest";
import { imageProvenanceLockPath } from "../src/cli/main.ts";

describe("image provenance lock runtime selection", () => {
	it("uses the original immutable lock path when Compose does not select a version", () => {
		expect(imageProvenanceLockPath({})).toBe("locks/bootstrap-image-provenance-lock.v1.json");
	});

	it("accepts a bounded versioned lock path selected by Compose", () => {
		expect(
			imageProvenanceLockPath({
				REPOFIX_IMAGE_PROVENANCE_LOCK_PATH: "locks/bootstrap-image-provenance-lock.v1-20260719.json",
			}),
		).toBe("locks/bootstrap-image-provenance-lock.v1-20260719.json");
	});

	it("rejects an unbounded provenance lock location", () => {
		expect(() => imageProvenanceLockPath({ REPOFIX_IMAGE_PROVENANCE_LOCK_PATH: "../lock.json" })).toThrow(
			"must name a versioned lock",
		);
	});
});
