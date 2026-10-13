// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ResumePrompt } from "./ResumePrompt";

type Props = Parameters<typeof ResumePrompt>[0];

/** Renders the prompt with a half watched film unless the test says otherwise. */
const renderPrompt = (overrides: Partial<Props> = {}) => {
	const props: Props = {
		title: "The Lantern Keeper",
		position: 1800,
		duration: 3600,
		onResume: vi.fn(),
		onStartOver: vi.fn(),
		onCancel: vi.fn(),
		...overrides,
	};
	render(<ResumePrompt {...props} />);
	return props;
};

/** The filled part of the progress bar. */
const progressFill = () =>
	screen.getByText(/Stopped at/).previousElementSibling?.firstElementChild as HTMLElement;

describe("ResumePrompt", () => {
	it("names the dialog after its heading and shows the title in full on hover", () => {
		renderPrompt({ title: "A Very Long Title That Gets Cut Off" });
		expect(screen.getByRole("dialog", { name: "Resume watching?" })).toBeInTheDocument();
		expect(screen.getByText("A Very Long Title That Gets Cut Off")).toHaveAttribute(
			"title",
			"A Very Long Title That Gets Cut Off"
		);
	});

	it("shows where the viewer stopped out of the full length", () => {
		renderPrompt({ position: 4000, duration: 7300 });
		expect(screen.getByText("Stopped at 1:06:40 of 2:01:40")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Resume from 1:06:40" })).toBeInTheDocument();
		expect(progressFill().style.width).toBe(`${(4000 / 7300) * 100}%`);
	});

	it("leaves out the length and the progress when the length is unknown", () => {
		renderPrompt({ position: 95, duration: 0 });
		expect(screen.getByText("Stopped at 1:35")).toBeInTheDocument();
		expect(screen.queryByText(/ of /)).not.toBeInTheDocument();
		expect(progressFill().style.width).toBe("0%");
	});

	it("fills the bar no further than the end when the saved spot is past the length", () => {
		renderPrompt({ position: 700, duration: 600 });
		expect(progressFill().style.width).toBe("100%");
	});

	it("resumes when the viewer picks resume", () => {
		const props = renderPrompt();
		fireEvent.click(screen.getByRole("button", { name: "Resume from 30:00" }));
		expect(props.onResume).toHaveBeenCalledTimes(1);
		expect(props.onStartOver).not.toHaveBeenCalled();
		expect(props.onCancel).not.toHaveBeenCalled();
	});

	it("starts over when the viewer picks the beginning", () => {
		const props = renderPrompt();
		fireEvent.click(screen.getByRole("button", { name: "Start from the beginning" }));
		expect(props.onStartOver).toHaveBeenCalledTimes(1);
		expect(props.onResume).not.toHaveBeenCalled();
		expect(props.onCancel).not.toHaveBeenCalled();
	});

	it("cancels on Escape", () => {
		const props = renderPrompt();
		fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
		expect(props.onCancel).toHaveBeenCalledTimes(1);
		expect(props.onResume).not.toHaveBeenCalled();
	});

	it("cancels on a click outside the box but not on one inside it", () => {
		const props = renderPrompt();
		fireEvent.click(screen.getByRole("heading", { name: "Resume watching?" }));
		expect(props.onCancel).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("dialog").parentElement as HTMLElement);
		expect(props.onCancel).toHaveBeenCalledTimes(1);
	});
});
