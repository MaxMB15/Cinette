// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach, onTestFinished } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { FullscreenProvider, useFullscreen } from "./fullscreen-context";
import { fakeWindow, resetFakeWindow, settle } from "@/test/fake-window";

vi.mock("@tauri-apps/api/window", () => import("@/test/fake-window"));

const Toggle = () => {
	const { isFullscreen, setFullscreen } = useFullscreen();
	return (
		<button onClick={() => setFullscreen(!isFullscreen)}>
			fullscreen={String(isFullscreen)}
		</button>
	);
};

const renderToggle = async () => {
	render(
		<FullscreenProvider>
			<Toggle />
		</FullscreenProvider>
	);
	await act(settle);
};

/** Changes the window the way the green button on macOS would. */
const changeWindow = (on: boolean) =>
	act(async () => {
		fakeWindow.changeFullscreen(on);
		await settle();
	});

describe("FullscreenProvider", () => {
	afterEach(() => {
		cleanup();
		resetFakeWindow();
	});

	it("sets the window along with the state", async () => {
		await renderToggle();
		fireEvent.click(screen.getByText("fullscreen=false"));
		expect(screen.getByText("fullscreen=true")).toBeTruthy();
		fireEvent.click(screen.getByText("fullscreen=true"));
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
		expect(fakeWindow.setFullscreen.mock.calls).toEqual([[true], [false]]);
	});

	it("still leaves full screen in the app when the window call fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		onTestFinished(() => error.mockRestore());
		fakeWindow.setFullscreen
			.mockRejectedValueOnce(new Error("no window"))
			.mockRejectedValueOnce(new Error("no window"));
		await renderToggle();
		fireEvent.click(screen.getByText("fullscreen=false"));
		fireEvent.click(screen.getByText("fullscreen=true"));
		await act(settle);
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
		expect(error).toHaveBeenCalledWith(
			"[fullscreen] setFullscreen(false) failed:",
			expect.any(Error)
		);
	});

	it("follows the window when it changes without the app", async () => {
		await renderToggle();
		await changeWindow(true);
		expect(screen.getByText("fullscreen=true")).toBeTruthy();
		await changeWindow(false);
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
	});

	it("starts from the window's state", async () => {
		fakeWindow.changeFullscreen(true);
		await renderToggle();
		expect(screen.getByText("fullscreen=true")).toBeTruthy();
	});

	it("keeps its own change over a read sent before it", async () => {
		let answer: (on: boolean) => void = () => {};
		fakeWindow.isFullscreen.mockImplementationOnce(
			() => new Promise<boolean>((resolve) => (answer = resolve))
		);
		render(
			<FullscreenProvider>
				<Toggle />
			</FullscreenProvider>
		);
		fireEvent.click(screen.getByText("fullscreen=false"));
		await act(async () => {
			answer(false);
			await settle();
		});
		expect(screen.getByText("fullscreen=true")).toBeTruthy();
	});

	it("shows the window's real state at the next resize after a change that failed", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		onTestFinished(() => error.mockRestore());
		fakeWindow.setFullscreen.mockRejectedValueOnce(new Error("in a transition"));
		await renderToggle();
		fireEvent.click(screen.getByText("fullscreen=false"));
		await act(settle);
		expect(screen.getByText("fullscreen=true")).toBeTruthy();

		await changeWindow(false);
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
	});

	it("stops following the window when it closes", async () => {
		await renderToggle();
		expect(fakeWindow.resizeListeners()).toBe(1);
		cleanup();
		await settle();
		expect(fakeWindow.resizeListeners()).toBe(0);
	});
});
