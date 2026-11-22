// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TvPrompt } from "./TvPrompt";

describe("TvPrompt", () => {
	it("shows its title, text and buttons, with the first button focused", () => {
		render(
			<TvPrompt
				title="Remove provider"
				text={<em>This can't be undone</em>}
				onClose={vi.fn()}
			>
				<button type="button">Remove</button>
				<button type="button">Keep</button>
			</TvPrompt>
		);
		expect(screen.getByRole("heading", { name: "Remove provider" })).toBeInTheDocument();
		expect(screen.getByText("This can't be undone")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Remove" })).toHaveFocus();
		expect(screen.getByRole("button", { name: "Keep" })).toBeInTheDocument();
	});

	it("is named by its title for a screen reader", () => {
		render(
			<TvPrompt title="Remove provider" text="Sure?" onClose={vi.fn()}>
				<button type="button">Remove</button>
			</TvPrompt>
		);
		expect(screen.getByRole("dialog", { name: "Remove provider" })).toBeInTheDocument();
	});

	it("goes by its label when it has one", () => {
		render(
			<TvPrompt title="Movie" label="Resume Movie" text="Sure?" onClose={vi.fn()}>
				<button type="button">Resume</button>
			</TvPrompt>
		);
		expect(screen.getByRole("dialog", { name: "Resume Movie" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Movie" })).toBeInTheDocument();
	});

	it("closes on Back", () => {
		const onClose = vi.fn();
		render(
			<TvPrompt title="Remove provider" text="Sure?" onClose={onClose}>
				<button type="button">Remove</button>
			</TvPrompt>
		);
		fireEvent.keyDown(screen.getByRole("button", { name: "Remove" }), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
