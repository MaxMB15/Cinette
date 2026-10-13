// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Field } from "./field";

describe("Field", () => {
	afterEach(() => {
		cleanup();
	});

	it("names its control with the label", () => {
		render(
			<>
				<Field label="Name">{(id) => <input id={id} defaultValue="My IPTV" />}</Field>
				<Field label="EPG URL">{(id) => <input id={id} defaultValue="" />}</Field>
			</>
		);
		expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("My IPTV");
		expect(screen.getByLabelText("EPG URL")).not.toBe(screen.getByLabelText("Name"));
	});

	it("can keep the label for screen readers only", () => {
		render(
			<Field label="Username" hideLabel>
				{(id) => <input id={id} placeholder="Username" />}
			</Field>
		);
		expect(screen.getByText("Username").className).toBe("sr-only");
		expect(screen.getByLabelText("Username")).toBe(screen.getByPlaceholderText("Username"));
	});
});
