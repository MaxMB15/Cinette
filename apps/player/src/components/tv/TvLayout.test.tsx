// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { Dialog } from "@/components/ui/dialog";
import { TV_LIST_ATTRIBUTE, TV_START_ATTRIBUTE } from "@/lib/tv-focus";
import { mpvSetVisible } from "@/lib/tauri";
import { TvLayout } from "./TvLayout";
import { useRemembered, useTvNav } from "./tv-nav";

const mounts = vi.hoisted(() => ({ providers: 0, history: 0 }));

vi.mock("@/lib/tauri", () => ({ mpvSetVisible: vi.fn() }));
vi.mock("@/components/remote/RemoteControls", async () => {
	const { useEffect: effect } = await import("react");
	return {
		ControllersBar: () => <p>What another device sent</p>,
		ProvidersAddedNotice: () => {
			effect(() => {
				mounts.providers++;
			}, []);
			return <p>Providers notice</p>;
		},
	};
});
vi.mock("@/components/remote/HistoryImportedNotice", async () => {
	const { useEffect: effect } = await import("react");
	return {
		HistoryImportedNotice: () => {
			effect(() => {
				mounts.history++;
			}, []);
			return <p>History notice</p>;
		},
	};
});

/** Whatever a page's own nav shows, with a way to press everything the layout gives it. */
const Page = () => {
	const { pathname } = useLocation();
	const { section, openSection } = useTvNav();
	const navigate = useNavigate();
	const [count, setCount] = useRemembered("count", 0);
	return (
		<div>
			<p>
				Page {pathname} of {section}
			</p>
			<p>Counted {count}</p>
			<button type="button">Before the start</button>
			<button type="button" {...{ [TV_START_ATTRIBUTE]: "" }}>
				The start
			</button>
			<button type="button" onClick={() => setCount(count + 1)}>
				Count
			</button>
			<button type="button" onClick={() => openSection("movie")}>
				Open movies
			</button>
			<button type="button" onClick={() => openSection("settings")}>
				Open settings
			</button>
			<button type="button" onClick={() => void navigate("/player")}>
				Open player
			</button>
			<button type="button" onClick={() => void navigate(-1)}>
				Leave
			</button>
		</div>
	);
};

const layoutAt = (path: string, page = <Page />) => (
	<MemoryRouter initialEntries={[path]}>
		<Routes>
			<Route element={<TvLayout />}>
				<Route path="*" element={page} />
			</Route>
		</Routes>
	</MemoryRouter>
);

const button = (name: string) => screen.getByRole("button", { name });
const open = (name: string) => fireEvent.click(button(name));
const railRow = (name: string) => screen.getByRole("option", { name });
const cursor = () =>
	within(screen.getByRole("navigation", { name: "Sections" })).getByRole("option", {
		selected: true,
	});

const box = (el: Element, left: number) =>
	vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
		left,
		right: left + 100,
		top: 0,
		bottom: 100,
		width: 100,
		height: 100,
		x: left,
		y: 0,
		toJSON: () => ({}),
	});

describe("TvLayout", () => {
	beforeEach(() => {
		vi.mocked(mpvSetVisible).mockResolvedValue(undefined);
		mounts.providers = 0;
		mounts.history = 0;
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.mocked(mpvSetVisible).mockReset();
	});

	describe("the frame", () => {
		it("gives the page the TV sizes while it shows, and takes them away after", () => {
			const { unmount } = render(layoutAt("/"));
			expect(document.documentElement).toHaveClass("tv");
			unmount();
			expect(document.documentElement).not.toHaveClass("tv");
		});

		it("shows the rail beside the page, with what another device sent", () => {
			render(layoutAt("/"));
			const main = screen.getByRole("main");
			expect(screen.getByRole("navigation", { name: "Sections" })).toBeInTheDocument();
			expect(within(main).getByText("Page / of live")).toBeInTheDocument();
			const bar = within(main).getByText("What another device sent");
			expect(bar).toBeInTheDocument();
			// A page with no marked row takes the focus on its own first control.
			expect(within(main).getByRole("button", { name: "The start" })).toSatisfy(
				(start: Element) =>
					(start.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
			);
		});

		it("gives the player the whole screen, with no rail or bar", () => {
			render(layoutAt("/player"));
			expect(screen.getByText("Page /player of live")).toBeInTheDocument();
			expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
			expect(screen.queryByRole("main")).not.toBeInTheDocument();
			expect(screen.queryByText("What another device sent")).not.toBeInTheDocument();
		});
	});

	describe("the rail", () => {
		it.each([
			["/", "Live TV"],
			["/settings", "Settings"],
		])("marks the open page at %s", (path, row) => {
			render(layoutAt(path));
			expect(cursor()).toBe(railRow(row));
		});

		it("moves the mark to the page it opens, and keeps the page mounted", () => {
			render(layoutAt("/"));
			const page = button("Count");
			fireEvent.click(railRow("Settings"));
			expect(screen.getByText("Page /settings of live")).toBeInTheDocument();
			expect(cursor()).toBe(railRow("Settings"));

			fireEvent.click(railRow("Movies"));
			expect(screen.getByText("Page / of movie")).toBeInTheDocument();
			expect(cursor()).toBe(railRow("Movies"));
			expect(button("Count")).toBe(page);
		});

		it("keeps the section for after Settings", () => {
			render(layoutAt("/"));
			open("Open movies");
			open("Open settings");
			expect(screen.getByText("Page /settings of movie")).toBeInTheDocument();
		});
	});

	describe("under a route of its own", () => {
		/** The paths to Live TV are absolute. An empty one would only reach it from the root. */
		const held = () => (
			<MemoryRouter initialEntries={["/settings"]}>
				<Routes>
					<Route path="/" element={<p>The root page</p>} />
					<Route path="/settings" element={<TvLayout />}>
						<Route index element={<Page />} />
					</Route>
				</Routes>
			</MemoryRouter>
		);

		it("opens a section at the root", () => {
			render(held());
			open("Open movies");
			expect(screen.getByText("The root page")).toBeInTheDocument();
		});

		it("goes to the root for Back on the rail", () => {
			render(held());
			act(() => railRow("Settings").focus());
			act(() => {
				window.__cinetteBack?.();
			});
			expect(screen.getByText("The root page")).toBeInTheDocument();
		});
	});

	describe("the notices", () => {
		it("shows each notice once, with the page and with the player", () => {
			render(layoutAt("/"));
			expect(screen.getAllByText("Providers notice")).toHaveLength(1);
			expect(screen.getAllByText("History notice")).toHaveLength(1);
			open("Open player");
			expect(screen.getByText("Page /player of live")).toBeInTheDocument();
			expect(screen.getAllByText("Providers notice")).toHaveLength(1);
			expect(screen.getAllByText("History notice")).toHaveLength(1);
		});

		it("doesn't start a notice over when moving to and from the player", () => {
			render(layoutAt("/"));
			const providers = screen.getByText("Providers notice");
			const history = screen.getByText("History notice");
			open("Open player");
			open("Leave");
			expect(screen.getByText("Page / of live")).toBeInTheDocument();
			expect(screen.getByText("Providers notice")).toBe(providers);
			expect(screen.getByText("History notice")).toBe(history);
			expect(mounts.providers).toBe(1);
			expect(mounts.history).toBe(1);
		});
	});

	describe("the video", () => {
		it("shows it on the player page", () => {
			render(layoutAt("/player"));
			expect(mpvSetVisible).toHaveBeenCalledExactlyOnceWith(true);
		});

		it.each(["/", "/settings"])("hides it on %s", (path) => {
			render(layoutAt(path));
			expect(mpvSetVisible).toHaveBeenCalledExactlyOnceWith(false);
		});

		it("follows the moves to and from the player, and nothing else", () => {
			render(layoutAt("/"));
			open("Open settings");
			expect(mpvSetVisible).toHaveBeenCalledTimes(1);
			open("Open player");
			expect(mpvSetVisible).toHaveBeenLastCalledWith(true);
			open("Leave");
			expect(mpvSetVisible).toHaveBeenLastCalledWith(false);
			expect(mpvSetVisible).toHaveBeenCalledTimes(3);
		});

		it("carries on if the video can't be shown", async () => {
			vi.mocked(mpvSetVisible).mockRejectedValue(new Error("no video"));
			render(layoutAt("/"));
			await act(async () => {});
			expect(screen.getByText("Page / of live")).toBeInTheDocument();
		});
	});

	describe("the place of each screen", () => {
		it("stays while the player has the screen", () => {
			render(layoutAt("/"));
			open("Count");
			open("Open player");
			expect(screen.getByText("Counted 1")).toBeInTheDocument();
			open("Leave");
			expect(screen.getByText("Counted 1")).toBeInTheDocument();
		});
	});

	describe("moving the focus into a page", () => {
		const start = () => button("The start");

		/** A page that shows something to press, with nothing that can take the focus. */
		const Empty = () => {
			const navigate = useNavigate();
			return <p onClick={() => void navigate("/player")}>Nothing here yet</p>;
		};

		/** A page whose list loads later. Its state is its own, so the layout doesn't render. */
		const LoadsLater = () => {
			const navigate = useNavigate();
			const [loaded, setLoaded] = useState(false);
			const [more, setMore] = useState(false);
			return (
				<div>
					<div>
						<p onClick={() => setLoaded(true)}>Finish loading</p>
						<p onClick={() => setMore(true)}>Load more</p>
						<p onClick={() => void navigate("/player")}>To the player</p>
						<p onClick={() => void navigate(-1)}>Away from the player</p>
						{more && <p>More</p>}
						{loaded && <Page />}
					</div>
				</div>
			);
		};
		const finishLoading = () => fireEvent.click(screen.getByText("Finish loading"));
		const openFromRail = (name: string) => {
			act(() => railRow(name).focus());
			fireEvent.click(railRow(name));
		};
		const sections = () => screen.getByRole("navigation", { name: "Sections" });

		/** A page of rows that a press takes away, as History's entries go. */
		const Rows = ({ names, modal = false }: { names: string[]; modal?: boolean }) => {
			const [rows, setRows] = useState(names);
			return (
				<div>
					{rows.map((row) => (
						<button key={row} type="button">
							{row}
						</button>
					))}
					<p onClick={() => setRows((now) => now.slice(1))}>Remove the first</p>
					{modal && (
						<Dialog label="Modal" onClose={() => {}}>
							<p>Over the page</p>
						</Dialog>
					)}
				</div>
			);
		};
		const removeFirst = () => fireEvent.click(screen.getByText("Remove the first"));

		const Modal = () => {
			const [isOpen, setIsOpen] = useState(true);
			return (
				<>
					<Page />
					{isOpen && (
						<Dialog label="Modal" onClose={() => setIsOpen(false)}>
							<p>Over the page</p>
						</Dialog>
					)}
				</>
			);
		};

		it("puts it on the page's start when a section opens", () => {
			render(layoutAt("/"));
			fireEvent.click(railRow("Movies"));
			expect(document.activeElement).toBe(start());
		});

		it("puts it in the column beside the rail, whichever column has the start", () => {
			render(
				layoutAt(
					"/",
					<div>
						<button type="button">A group</button>
						<button type="button" {...{ [TV_START_ATTRIBUTE]: "" }}>
							A channel
						</button>
					</div>
				)
			);
			box(screen.getByRole("main"), 80);
			box(button("A group"), 100);
			box(button("A channel"), 300);
			fireEvent.click(railRow("Live TV"));
			expect(document.activeElement).toBe(button("A group"));
		});

		// The app's own router, since this depends on a navigation to the same page rendering.
		it("does it again for a second press on the section that's open", () => {
			window.history.pushState(null, "", "/");
			render(
				<BrowserRouter>
					<Routes>
						<Route element={<TvLayout />}>
							<Route path="*" element={<Page />} />
						</Route>
					</Routes>
				</BrowserRouter>
			);
			fireEvent.click(railRow("Live TV"));
			expect(document.activeElement).toBe(start());
			act(() => railRow("Live TV").focus());
			fireEvent.click(railRow("Live TV"));
			expect(document.activeElement).toBe(start());
		});

		it("leaves the focus alone until a section opens", () => {
			render(layoutAt("/"));
			expect(document.activeElement).toBe(document.body);
		});

		it("leaves the focus alone once it's moved, until the next section opens", () => {
			const { rerender } = render(layoutAt("/"));
			fireEvent.click(railRow("Movies"));
			const other = button("Count");
			act(() => other.focus());
			rerender(layoutAt("/"));
			expect(document.activeElement).toBe(other);
		});

		it("waits for a page that has nothing to take it yet", () => {
			const { rerender } = render(layoutAt("/", <Empty />));
			fireEvent.click(railRow("Movies"));
			expect(document.activeElement).toBe(document.body);
			rerender(layoutAt("/"));
			expect(document.activeElement).toBe(start());
		});

		it("moves there when a list loads without the layout rendering", async () => {
			render(layoutAt("/", <LoadsLater />));
			openFromRail("History");
			expect(sections()).toContainElement(document.activeElement as HTMLElement);
			finishLoading();
			await waitFor(() => expect(document.activeElement).toBe(start()));
		});

		it("leaves the focus on the rail when a list loads with no section opened", async () => {
			render(layoutAt("/", <LoadsLater />));
			act(() => railRow("History").focus());
			finishLoading();
			await act(async () => {});
			expect(document.activeElement).toBe(railRow("History"));
		});

		it("only moves it once, whatever else loads after", async () => {
			render(layoutAt("/", <LoadsLater />));
			openFromRail("History");
			finishLoading();
			await waitFor(() => expect(document.activeElement).toBe(start()));

			const other = button("Count");
			act(() => other.focus());
			fireEvent.click(screen.getByText("Load more"));
			expect(screen.getByText("More")).toBeInTheDocument();
			await act(async () => {});
			expect(document.activeElement).toBe(other);
		});

		it("still watches for a late list after a trip to the player", async () => {
			render(layoutAt("/", <LoadsLater />));
			fireEvent.click(screen.getByText("To the player"));
			expect(screen.queryByRole("main")).not.toBeInTheDocument();
			fireEvent.click(screen.getByText("Away from the player"));
			expect(screen.getByRole("main")).toBeInTheDocument();

			openFromRail("History");
			finishLoading();
			await waitFor(() => expect(document.activeElement).toBe(start()));
		});

		it("stops watching the page when the player takes the screen", () => {
			render(layoutAt("/", <LoadsLater />));
			const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
			fireEvent.click(screen.getByText("To the player"));
			expect(disconnect).toHaveBeenCalledTimes(1);
		});

		it("drops the wish when Back on the rail goes to Live TV", async () => {
			render(layoutAt("/", <LoadsLater />));
			openFromRail("History");
			act(() => {
				window.__cinetteBack?.();
			});
			expect(cursor()).toBe(railRow("Live TV"));
			expect(sections()).toContainElement(document.activeElement as HTMLElement);

			finishLoading();
			await act(async () => {});
			expect(sections()).toContainElement(document.activeElement as HTMLElement);
		});

		it("doesn't look for a page on the player, while it's still waiting for one", () => {
			render(layoutAt("/", <Empty />));
			fireEvent.click(railRow("Movies"));
			fireEvent.click(screen.getByText("Nothing here yet"));
			expect(screen.queryByRole("main")).not.toBeInTheDocument();
			expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
		});

		it("goes to the rail's open section when the last row goes away", async () => {
			render(layoutAt("/", <Rows names={["Only"]} />));
			openFromRail("History");
			expect(document.activeElement).toBe(button("Only"));
			removeFirst();
			await waitFor(() => expect(document.activeElement).toBe(railRow("History")));
		});

		it("goes to the page's start when a row goes away and others are left", async () => {
			render(layoutAt("/", <Rows names={["First", "Second"]} />));
			openFromRail("History");
			expect(document.activeElement).toBe(button("First"));
			removeFirst();
			await waitFor(() => expect(document.activeElement).toBe(button("Second")));
		});

		it("leaves a focus with nowhere to be alone while a modal is open", async () => {
			render(layoutAt("/", <Rows names={["First", "Second"]} modal />));
			act(() => (document.activeElement as HTMLElement).blur());
			removeFirst();
			await act(async () => {});
			expect(document.activeElement).toBe(document.body);
		});

		it("finds the page after a modal closes with nowhere to hand the focus back", () => {
			render(layoutAt("/", <Modal />));
			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(document.activeElement).toBe(start());
		});

		it("finds the rail after that when the page has nothing to take the focus", () => {
			const EmptyModal = () => {
				const [isOpen, setIsOpen] = useState(true);
				return isOpen ? (
					<Dialog label="Modal" onClose={() => setIsOpen(false)}>
						<p>Over the page</p>
					</Dialog>
				) : null;
			};
			render(layoutAt("/settings", <EmptyModal />));
			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
			expect(document.activeElement).toBe(railRow("Settings"));
		});

		it("doesn't mind a modal closing the same way on the player", () => {
			render(layoutAt("/player", <Modal />));
			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			expect(document.activeElement).toBe(document.body);
		});
	});

	describe("Back", () => {
		beforeEach(() => {
			// jsdom has no scrolling, and a move to another control scrolls it into view.
			Element.prototype.scrollIntoView = vi.fn();
		});

		afterEach(() => {
			delete (Element.prototype as Partial<Element>).scrollIntoView;
		});

		/** What Android's Back does. False lets the app close. */
		const pressBack = () => {
			let result: boolean | undefined;
			act(() => {
				result = window.__cinetteBack?.();
			});
			return result;
		};

		it("goes to Live TV from a section on the rail, then lets the app close", () => {
			render(layoutAt("/"));
			open("Open movies");
			act(() => railRow("Movies").focus());

			expect(pressBack()).toBe(true);
			expect(screen.getByText("Page / of live")).toBeInTheDocument();
			expect(cursor()).toBe(railRow("Live TV"));

			expect(pressBack()).toBe(false);
			expect(screen.getByText("Page / of live")).toBeInTheDocument();
		});

		it("goes to Live TV from settings on the rail", () => {
			render(layoutAt("/settings"));
			act(() => railRow("Settings").focus());
			expect(pressBack()).toBe(true);
			expect(screen.getByText("Page / of live")).toBeInTheDocument();
		});

		it("walks left from a page to the rail", () => {
			render(layoutAt("/"));
			const inPage = button("Count");
			const row = railRow("Live TV");
			box(inPage, 300);
			box(row, 0);
			box(row.closest(`[${TV_LIST_ATTRIBUTE}]`) as Element, 0);
			act(() => inPage.focus());
			expect(pressBack()).toBe(true);
			expect(document.activeElement).toBe(row);
		});

		it("isn't taken on a page with nothing to its left, so the app closes", () => {
			render(layoutAt("/"));
			const inPage = button("Count");
			box(inPage, 300);
			act(() => inPage.focus());
			expect(pressBack()).toBe(false);
			expect(document.activeElement).toBe(inPage);
		});

		it("ignores a Back that something on the page already used", () => {
			render(layoutAt("/settings"));
			act(() => railRow("Settings").focus());
			const takeIt = (e: KeyboardEvent) => e.preventDefault();
			window.addEventListener("keydown", takeIt, { capture: true });
			fireEvent.keyDown(railRow("Settings"), { key: "Escape" });
			window.removeEventListener("keydown", takeIt, { capture: true });
			expect(screen.getByText("Page /settings of live")).toBeInTheDocument();
		});

		it("ignores any other key on the rail", () => {
			render(layoutAt("/settings"));
			act(() => railRow("Settings").focus());
			expect(fireEvent.keyDown(railRow("Settings"), { key: "a" })).toBe(true);
			expect(screen.getByText("Page /settings of live")).toBeInTheDocument();
		});

		it("goes home from the player, and doesn't walk left in it", () => {
			render(layoutAt("/player"));
			const inPlayer = button("Count");
			box(inPlayer, 300);
			box(button("The start"), 0);
			act(() => inPlayer.focus());
			expect(pressBack()).toBe(true);
			expect(screen.getByText("Page / of live")).toBeInTheDocument();
		});
	});
});
