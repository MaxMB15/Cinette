// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { Cast } from "@/hooks/useCast";
import { CAST_NETWORK_DENIED } from "@/lib/cast";
import { makeMovie } from "@/test/detail-fixtures";
import { CastButton } from "./CastButton";

const film = makeMovie({ id: "mv1", name: "A Film" });

const cast = (patch: Partial<Cast> = {}): Cast => ({
	receivers: [
		{ id: "cast:tv", name: "Hotel TV", model: "Chromecast", status: null, available: true },
	],
	localNetworkDenied: false,
	vpnActive: false,
	statuses: new Map([["cast:tv", { via: "direct" as const }]]),
	check: vi.fn(),
	release: vi.fn(),
	destination: null,
	current: () => null,
	state: null,
	send: vi.fn(),
	stop: vi.fn(),
	...patch,
});

const button = () => screen.getByRole("button", { name: "Cast" });

describe("CastButton", () => {
	it("opens the picker with this device and the receivers, checking the item playing", () => {
		const c = cast();
		render(<CastButton cast={c} channel={film} onSend={vi.fn()} />);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(button()).toHaveAttribute("aria-haspopup", "dialog");
		fireEvent.click(button());
		const picker = screen.getByRole("dialog", { name: "Play on" });
		expect(within(picker).getByRole("button", { name: /This device/ })).toBeTruthy();
		expect(within(picker).getByRole("button", { name: /Hotel TV/ })).toBeTruthy();
		expect(c.check).toHaveBeenCalledWith(film);
		expect(within(picker).queryByRole("status")).toBeNull();
	});

	it("says why it can't look, above the rows", () => {
		render(
			<CastButton
				cast={cast({ receivers: [], localNetworkDenied: true })}
				channel={film}
				onSend={vi.fn()}
			/>
		);
		fireEvent.click(button());
		expect(screen.getByRole("status").textContent).toBe(CAST_NETWORK_DENIED);
	});

	it("closes, letting go of the rows, when this device is chosen, and casts nothing", () => {
		const c = cast();
		const onSend = vi.fn(async () => {});
		render(<CastButton cast={c} channel={film} onSend={onSend} />);
		fireEvent.click(button());
		fireEvent.click(screen.getByRole("button", { name: /This device/ }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(c.release).toHaveBeenCalled();
		expect(onSend).not.toHaveBeenCalled();
	});

	it("casts to the receiver chosen, busy until it's done", async () => {
		let done: () => void = () => {};
		const onSend = vi.fn(() => new Promise<void>((resolve) => (done = resolve)));
		render(<CastButton cast={cast()} channel={film} onSend={onSend} />);
		fireEvent.click(button());
		fireEvent.click(screen.getByRole("button", { name: /Hotel TV/ }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(onSend).toHaveBeenCalledWith("cast:tv");
		expect(button()).toBeDisabled();
		await act(async () => done());
		expect(button()).not.toBeDisabled();
		// A send that fails ends the wait too. The player says why.
		onSend.mockRejectedValueOnce(new Error("no"));
		fireEvent.click(button());
		fireEvent.click(screen.getByRole("button", { name: /Hotel TV/ }));
		await act(async () => {});
		expect(button()).not.toBeDisabled();
	});
});
