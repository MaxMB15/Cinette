// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TvResumePrompt } from "./TvResumePrompt";

const renderPrompt = (duration = 120) => {
	const handlers = { onResume: vi.fn(), onStartOver: vi.fn(), onCancel: vi.fn() };
	render(
		<TvResumePrompt
			title="The Lantern Keeper"
			position={65}
			duration={duration}
			{...handlers}
		/>
	);
	return handlers;
};

const button = (name: string) => screen.getByRole("button", { name });

describe("TvResumePrompt", () => {
	it("asks about the title by name, with where the viewer stopped", () => {
		renderPrompt();
		expect(
			screen.getByRole("dialog", { name: "Resume The Lantern Keeper" })
		).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "The Lantern Keeper" })).toBeInTheDocument();
		expect(screen.getByText("You stopped at 1:05 of 2:00")).toBeInTheDocument();
	});

	it("leaves out the length when it isn't known", () => {
		renderPrompt(0);
		expect(screen.getByText("You stopped at 1:05")).toBeInTheDocument();
	});

	it("opens on Resume, so OK goes on watching", () => {
		const { onResume, onStartOver } = renderPrompt();
		expect(button("Resume")).toHaveFocus();
		fireEvent.click(button("Resume"));
		expect(onResume).toHaveBeenCalledTimes(1);
		expect(onStartOver).not.toHaveBeenCalled();
	});

	it("starts over from its second button", () => {
		const { onResume, onStartOver } = renderPrompt();
		fireEvent.click(button("Start over"));
		expect(onStartOver).toHaveBeenCalledTimes(1);
		expect(onResume).not.toHaveBeenCalled();
	});

	it("cancels on Back", () => {
		const { onCancel, onResume, onStartOver } = renderPrompt();
		fireEvent.keyDown(button("Resume"), { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onResume).not.toHaveBeenCalled();
		expect(onStartOver).not.toHaveBeenCalled();
	});
});
