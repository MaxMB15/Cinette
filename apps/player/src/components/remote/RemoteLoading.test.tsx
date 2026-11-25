// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { EventCallback } from "@tauri-apps/api/event";

const handlers = vi.hoisted(() => new Map<string, EventCallback<unknown>>());
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((event: string, handler: EventCallback<unknown>) => {
		handlers.set(event, handler);
		return Promise.resolve(() => handlers.delete(event));
	}),
}));

import { RemoteLoading } from "./RemoteLoading";
import type { Link } from "@/lib/remote-control";

const link = (phase: Link["phase"]["phase"] = "connected", deviceType = "iphone") =>
	({ id: 9, name: "Max's iPhone", deviceType, phase: { phase } }) as unknown as Link;

const leave = vi.fn();

/** The backend says how much of link `id`'s library came. */
const progress = async (received: number, total: number | null, id = 9) => {
	await act(async () => {});
	act(() =>
		handlers.get("remote://library-progress")!({
			event: "remote://library-progress",
			id: 0,
			payload: { link: id, received, total },
		})
	);
};

/** Each step's text, with the one the load is at marked. */
const steps = () =>
	within(screen.getByRole("list"))
		.getAllByRole("listitem")
		.map((step) => {
			const text = step.querySelector("p")!.textContent;
			return step.getAttribute("aria-current") === "step" ? `> ${text}` : text;
		});

beforeEach(() => {
	handlers.clear();
	leave.mockClear();
});

describe("RemoteLoading", () => {
	it("names the device and gets its library once connected", () => {
		render(<RemoteLoading link={link()} onLeave={leave} />);
		expect(screen.getByRole("heading", { name: "Max's iPhone" })).toBeInTheDocument();
		expect(steps()).toEqual(["Connected, done", "> Getting its library", "Opening it"]);
		// Nothing came yet, so there's nothing to measure.
		const bar = screen.getByRole("progressbar", { name: "Library from Max's iPhone" });
		expect(bar).not.toHaveAttribute("aria-valuenow");
		expect(bar.firstElementChild).toHaveClass("animate-pulse");
		expect(bar.firstElementChild).toHaveStyle({ width: "100%" });
		expect(screen.queryByText(/ MB$/)).not.toBeInTheDocument();
	});

	it("shows how much of the library came", async () => {
		render(<RemoteLoading link={link()} onLeave={leave} />);
		await progress(3_100_000, 8_000_000);
		const bar = screen.getByRole("progressbar");
		expect(bar).toHaveAttribute("aria-valuenow", "39");
		expect(bar.firstElementChild).not.toHaveClass("animate-pulse");
		expect(bar.firstElementChild).toHaveStyle({ width: "39%" });
		expect(screen.getByText("3.1 of 8.0 MB")).toBeInTheDocument();
	});

	it("leaves out another link's library", async () => {
		render(<RemoteLoading link={link()} onLeave={leave} />);
		await progress(3_100_000, 8_000_000, 8);
		expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
		expect(screen.queryByText(/ MB$/)).not.toBeInTheDocument();
	});

	it("measures nothing for a device that doesn't give the size", async () => {
		render(<RemoteLoading link={link()} onLeave={leave} />);
		await progress(3_100_000, null);
		expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
		expect(screen.queryByText(/ MB$/)).not.toBeInTheDocument();
	});

	it("opens the library once all of it came", async () => {
		render(<RemoteLoading link={link()} onLeave={leave} />);
		await progress(8_000_000, 8_000_000);
		expect(steps()).toEqual(["Connected, done", "Getting its library, done", "> Opening it"]);
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
	});

	it("waits for the link while it reconnects", () => {
		render(<RemoteLoading link={link("reconnecting")} onLeave={leave} />);
		expect(steps()).toEqual(["> Reconnecting", "Getting its library", "Opening it"]);
		expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
	});

	it("shows a TV as one", () => {
		const { container, rerender } = render(<RemoteLoading link={link()} onLeave={leave} />);
		expect(container.querySelector("h2")!.previousElementSibling!.innerHTML).not.toMatch(
			/lucide-tv/
		);
		rerender(<RemoteLoading link={link("connected", "fire-tv")} onLeave={leave} />);
		expect(container.querySelector("h2")!.previousElementSibling!.innerHTML).toMatch(
			/lucide-tv/
		);
	});

	it("disconnects", () => {
		render(<RemoteLoading link={link()} onLeave={leave} />);
		fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
		expect(leave).toHaveBeenCalledOnce();
	});
});
