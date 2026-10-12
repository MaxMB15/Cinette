// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { StrictMode, useRef, type RefObject } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DownloadButton } from "@/components/downloads/DownloadButton";
import { useFocusTrap } from "./useFocusTrap";
import { usePlayerFocus } from "./usePlayerFocus";

/** A confirm or notice, which opens outside the player. */
const Confirm = ({ action }: { action: string }) => {
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref);
	return (
		<div ref={ref} role="dialog">
			<button>{action}</button>
		</div>
	);
};

const Player = ({
	url,
	confirm = false,
	notice = false,
	sidebar = true,
}: {
	url: string | null;
	confirm?: boolean;
	notice?: boolean;
	sidebar?: boolean;
}) => {
	const ref = useRef<HTMLDivElement>(null);
	usePlayerFocus(ref, url);
	return (
		<>
			{sidebar && <button>Sidebar</button>}
			<div ref={ref} tabIndex={-1} data-testid="player">
				<button>Resume</button>
			</div>
			{confirm && <Confirm action="Remove" />}
			{notice && <Confirm action="OK" />}
		</>
	);
};

/** Calls `usePlayerFocus` on an element its parent owns, so the element can outlive the hook. */
const Focuser = ({ target }: { target: RefObject<HTMLElement | null> }) => {
	usePlayerFocus(target, null);
	return null;
};

const player = () => screen.getByTestId("player");
const button = (name: string) => screen.getByRole("button", { name });

describe("usePlayerFocus", () => {
	it("focuses the player when it opens", () => {
		render(<Player url={null} />);
		expect(player()).toHaveFocus();
	});

	it("takes focus back when a new stream loads", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		button("Sidebar").focus();
		rerender(<Player url="http://example.test/2" />);
		expect(player()).toHaveFocus();
	});

	it("leaves focus where it is when the stream stops", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		button("Sidebar").focus();
		rerender(<Player url={null} />);
		expect(button("Sidebar")).toHaveFocus();
	});

	it("leaves focus that's already inside the player", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		button("Resume").focus();
		rerender(<Player url="http://example.test/2" />);
		expect(button("Resume")).toHaveFocus();
	});

	it("leaves focus on a confirm open over the player", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		rerender(<Player url="http://example.test/1" confirm />);
		expect(button("Remove")).toHaveFocus();
		rerender(<Player url="http://example.test/2" confirm />);
		expect(button("Remove")).toHaveFocus();
	});

	it("takes focus back when a confirm closes and its opener is gone", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		button("Sidebar").focus();
		rerender(<Player url="http://example.test/1" confirm />);
		rerender(<Player url="http://example.test/1" confirm sidebar={false} />);
		rerender(<Player url="http://example.test/1" sidebar={false} />);
		expect(player()).toHaveFocus();
	});

	it("takes focus back when a confirm closes and nothing had focus before it", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		player().blur();
		expect(document.body).toHaveFocus();
		rerender(<Player url="http://example.test/1" confirm />);
		rerender(<Player url="http://example.test/1" />);
		expect(player()).toHaveFocus();
	});

	it("doesn't take focus as a confirm opens under StrictMode", () => {
		const { rerender } = render(
			<StrictMode>
				<Player url="http://example.test/1" />
			</StrictMode>
		);
		player().blur();
		const focused = vi.fn();
		player().addEventListener("focus", focused);
		rerender(
			<StrictMode>
				<Player url="http://example.test/1" confirm />
			</StrictMode>
		);
		expect(button("Remove")).toHaveFocus();
		expect(focused).not.toHaveBeenCalled();
		rerender(
			<StrictMode>
				<Player url="http://example.test/1" />
			</StrictMode>
		);
		expect(player()).toHaveFocus();
	});

	it("stops taking focus back once it unmounts", () => {
		const Owner = ({ watching, confirm }: { watching: boolean; confirm: boolean }) => {
			const ref = useRef<HTMLDivElement>(null);
			return (
				<>
					<div ref={ref} tabIndex={-1} data-testid="player" />
					{watching && <Focuser target={ref} />}
					{confirm && <Confirm action="Remove" />}
				</>
			);
		};
		const { rerender } = render(<Owner watching confirm={false} />);
		rerender(<Owner watching={false} confirm={false} />);
		player().blur();
		rerender(<Owner watching={false} confirm />);
		rerender(<Owner watching={false} confirm={false} />);
		expect(document.body).toHaveFocus();
	});

	it("leaves focus to a notice that opens as the confirm closes", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		button("Sidebar").focus();
		rerender(<Player url="http://example.test/1" confirm />);
		rerender(<Player url="http://example.test/1" confirm sidebar={false} />);
		rerender(<Player url="http://example.test/1" notice sidebar={false} />);
		expect(button("OK")).toHaveFocus();
		rerender(<Player url="http://example.test/1" sidebar={false} />);
		expect(player()).toHaveFocus();
	});

	it("takes focus back after a failed removal on the episode before", async () => {
		let fail: (reason: string) => void = () => {};
		const onRemove = () =>
			new Promise((_resolve, reject) => {
				fail = reject;
			});
		const Episode = ({ id, url }: { id: string; url: string }) => {
			const ref = useRef<HTMLDivElement>(null);
			usePlayerFocus(ref, url);
			return (
				<div ref={ref} tabIndex={-1} data-testid="player">
					<DownloadButton
						itemId={id}
						state={id === "e1" ? "complete" : "idle"}
						onStart={vi.fn()}
						onStop={vi.fn()}
						onRemove={onRemove}
					/>
				</div>
			);
		};
		const { rerender } = render(<Episode id="e1" url="http://example.test/1" />);
		button("Downloaded").focus();
		fireEvent.click(button("Downloaded"));
		fireEvent.click(button("Remove"));
		// The next episode replaces the button before its stream loads.
		rerender(<Episode id="e2" url="http://example.test/1" />);
		expect(document.body).toHaveFocus();
		await act(async () => fail("denied"));
		const notice = screen.getByRole("dialog", { name: "Couldn't remove the download" });
		rerender(<Episode id="e2" url="http://example.test/2" />);
		fireEvent.click(within(notice).getByRole("button", { name: "OK" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(player()).toHaveFocus();
	});

	it("leaves focus with the opener when a confirm closes", () => {
		const { rerender } = render(<Player url="http://example.test/1" />);
		button("Sidebar").focus();
		rerender(<Player url="http://example.test/1" confirm />);
		rerender(<Player url="http://example.test/1" />);
		expect(button("Sidebar")).toHaveFocus();
	});
});
