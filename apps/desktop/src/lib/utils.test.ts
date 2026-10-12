// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { cn, isFromInnerButton } from "./utils";

describe("cn", () => {
	it("merges class names", () => {
		expect(cn("a", "b")).toBe("a b");
	});

	it("handles tailwind conflicts", () => {
		expect(cn("px-2 py-1", "px-4")).toBe("py-1 px-4");
	});

	it("handles conditional classes", () => {
		expect(cn("base", false && "hidden", "visible")).toBe("base visible");
	});

	it("returns empty string with no arguments", () => {
		expect(cn()).toBe("");
	});

	it("filters out falsy values", () => {
		expect(cn("a", undefined, null as never, false && "b", "c")).toBe("a c");
	});

	it("resolves duplicate class to single instance", () => {
		expect(cn("p-2", "p-2")).toBe("p-2");
	});

	it("resolves last tailwind color wins", () => {
		expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
	});

	it("resolves last tailwind font-size wins", () => {
		expect(cn("text-sm", "text-lg")).toBe("text-lg");
	});

	it("keeps non-conflicting tailwind classes", () => {
		const result = cn("flex", "items-center", "justify-between");
		expect(result).toContain("flex");
		expect(result).toContain("items-center");
		expect(result).toContain("justify-between");
	});

	it("handles responsive prefix conflicts", () => {
		// md:px-2 and md:px-6 conflict, so the last one wins
		expect(cn("md:px-2", "md:px-6")).toBe("md:px-6");
	});

	it("handles object syntax with boolean conditions", () => {
		expect(cn({ "opacity-50": true, "cursor-not-allowed": false })).toBe("opacity-50");
	});

	it("merges arrays of classes", () => {
		expect(cn(["flex", "gap-2"], "mt-4")).toBe("flex gap-2 mt-4");
	});
});

describe("isFromInnerButton", () => {
	const row = document.createElement("div");
	row.innerHTML = "<span>Name</span><button><svg><path></path></svg></button>";
	const click = (target: Element) => ({ target, currentTarget: row });

	it("is true for a click on a button in the row or on its icon", () => {
		expect(isFromInnerButton(click(row.querySelector("button")!))).toBe(true);
		expect(isFromInnerButton(click(row.querySelector("path")!))).toBe(true);
	});

	it("is false for a click on the row itself", () => {
		expect(isFromInnerButton(click(row.querySelector("span")!))).toBe(false);
		expect(isFromInnerButton(click(row))).toBe(false);
	});

	it("ignores a button around the row", () => {
		const outer = document.createElement("button");
		outer.appendChild(row);
		expect(isFromInnerButton(click(row.querySelector("span")!))).toBe(false);
	});
});
