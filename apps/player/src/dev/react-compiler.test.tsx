// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Compiled components get their memo cache from react/compiler-runtime. If
// the compiler stopped running, as when its Vite plugin is set up wrong,
// everything would still pass, only slower, so this counts the calls.
const runtime = vi.hoisted(() => ({ caches: 0 }));
vi.mock("react/compiler-runtime", async (importOriginal) => {
	const real = await importOriginal<{ c: (size: number) => unknown[] }>();
	return {
		...real,
		c: (size: number) => {
			runtime.caches += 1;
			return real.c(size);
		},
	};
});

import { Badge } from "@/components/ui/badge";

describe("the React Compiler", () => {
	it("compiles the app's components in the tests, as in the build", () => {
		render(<Badge>Live</Badge>);
		expect(screen.getByText("Live")).toBeInTheDocument();
		expect(runtime.caches).toBeGreaterThan(0);
	});
});
