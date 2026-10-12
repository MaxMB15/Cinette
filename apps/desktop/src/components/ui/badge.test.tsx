// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Badge, badgeVariants } from "./badge";

afterEach(cleanup);

describe("Badge", () => {
	it("uses the primary colors when no variant is given", () => {
		render(<Badge>New</Badge>);
		expect(screen.getByText("New")).toHaveClass("rounded-full", "bg-primary");
	});

	it.each([
		["default", "bg-primary"],
		["secondary", "bg-secondary"],
		["destructive", "bg-destructive"],
		["outline", "text-foreground"],
	] as const)("styles the %s variant", (variant, expected) => {
		render(<Badge variant={variant}>Label</Badge>);
		expect(screen.getByText("Label")).toHaveClass(expected);
	});

	it("leaves the fill off the outline variant", () => {
		render(<Badge variant="outline">Label</Badge>);
		expect(screen.getByText("Label").className).not.toMatch(/\bbg-/);
	});

	it("lets a caller's class replace the default shape and passes other props through", () => {
		render(
			<Badge className="rounded-md" title="Live now">
				LIVE
			</Badge>
		);
		const badge = screen.getByTitle("Live now");
		expect(badge).toHaveTextContent("LIVE");
		expect(badge).toHaveClass("rounded-md");
		expect(badge).not.toHaveClass("rounded-full");
	});

	it("gives other elements the same classes through badgeVariants", () => {
		expect(badgeVariants({ variant: "destructive" })).toContain("bg-destructive");
		expect(badgeVariants()).toContain("bg-primary");
	});
});
