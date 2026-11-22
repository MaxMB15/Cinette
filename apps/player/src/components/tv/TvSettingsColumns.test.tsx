// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
	activeRow,
	beside,
	column,
	cursorTo,
	enterText,
	layOutColumns,
	pressOk,
} from "@/test/tv-columns";
import {
	TvSettingsColumns,
	choiceRow,
	toggleRow,
	type TvChoice,
	type TvSetting,
	type TvSettingsGroup,
	type TvSettingsSection,
} from "./TvSettingsColumns";
import { TvNavContext } from "./tv-nav";

const row = (id: string, more: Partial<TvSetting> = {}): TvSetting => ({ id, label: id, ...more });

const section = (
	id: string,
	settings: TvSetting[],
	more: Partial<TvSettingsSection> = {}
): TvSettingsSection => ({ id, label: id, settings, ...more });

const choice = (label: string, more: Partial<TvChoice> = {}): TvChoice => ({
	label,
	selected: false,
	onPick: () => {},
	...more,
});

/** Sections named with `prefix` and a number, each with one row. */
const many = (prefix: string, count: number, more: Partial<TvSettingsSection> = {}) =>
	Array.from({ length: count }, (_, i) => {
		const id = `${prefix}${String(i).padStart(2, "0")}`;
		return section(id, [row(`${id} row`)], more);
	});

const grouped = (
	groups: TvSettingsGroup[],
	memory = new Map<string, unknown>(),
	memoryKey = "test"
) => (
	<TvNavContext.Provider value={{ section: "live", openSection: () => {}, memory }}>
		<TvSettingsColumns title="Settings" memoryKey={memoryKey} groups={groups} />
	</TvNavContext.Provider>
);

/** The sections in one group, called Sections. */
const columns = (
	sections: TvSettingsSection[],
	memory?: Map<string, unknown>,
	memoryKey?: string
) => grouped([{ label: "Sections", sections }], memory, memoryKey);

const show = (...sections: TvSettingsSection[]) => render(columns(sections));

/** One section called Main, with this one row. */
const showRow = (setting: TvSetting) => show(section("Main", [setting]));

const button = (name: string) => screen.getByRole("button", { name });
const dialog = () => screen.queryByRole("dialog");
const back = () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
const rowLabels = (name: string) =>
	within(column(name))
		.getAllByRole("option")
		.map((r) => r.textContent);

describe("toggleRow", () => {
	it("says On, and turns off with OK", () => {
		const onChange = vi.fn();

		const setting = toggleRow("wifi", "Wi-Fi", true, onChange, "About it");
		setting.onSelect?.();

		expect(setting).toMatchObject({
			id: "wifi",
			label: "Wi-Fi",
			value: "On",
			hint: "About it",
		});
		expect(onChange).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("says Off, and turns on with OK", () => {
		const onChange = vi.fn();

		const setting = toggleRow("wifi", "Wi-Fi", false, onChange);
		setting.onSelect?.();

		expect(setting.value).toBe("Off");
		expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
	});
});

describe("choiceRow", () => {
	const options = [
		{ value: 1, label: "One" },
		{ value: 2, label: "Two" },
	];

	it("shows the current answer's label as its value", () => {
		const setting = choiceRow("n", "Number", options, 2, () => {}, "About it");

		expect(setting).toMatchObject({ id: "n", label: "Number", value: "Two", hint: "About it" });
	});

	it("marks only the current answer as selected", () => {
		const setting = choiceRow("n", "Number", options, 2, () => {});

		expect(setting.choices?.map((c) => [c.label, c.selected])).toEqual([
			["One", false],
			["Two", true],
		]);
	});

	it("has no value when the current answer isn't one of the options", () => {
		const setting = choiceRow("n", "Number", options, 9, () => {});

		expect(setting.value).toBeUndefined();
		expect(setting.choices?.some((c) => c.selected)).toBe(false);
	});

	it("picks an answer by its value", () => {
		const onPick = vi.fn();

		choiceRow("n", "Number", options, 2, onPick).choices?.[0].onPick();

		expect(onPick).toHaveBeenCalledExactlyOnceWith(1);
	});
});

describe("TvSettingsColumns", () => {
	describe("the sections", () => {
		it("shows the title and each section with the line under its name", () => {
			show(section("One", [row("a")], { detail: "42 channels" }), section("Two", [row("b")]));

			expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
			expect(rowLabels("Sections")).toEqual(["One42 channels", "Two"]);
		});

		it("starts with the focus on the first section and its rows beside it", () => {
			show(section("One", [row("a")]), section("Two", [row("b")]));

			expect(activeRow("Sections")).toHaveTextContent("One");
			expect(activeRow("Sections")).toHaveFocus();
			expect(activeRow("One")).toHaveTextContent("a");
		});

		it("shows another section's rows from the top as the cursor reaches it", () => {
			show(section("One", [row("a"), row("b")]), section("Two", [row("c"), row("d")]));

			cursorTo("One", "b");
			cursorTo("Sections", "Two");

			expect(rowLabels("Two")).toEqual(["c", "d"]);
			expect(activeRow("Two")).toHaveTextContent("c");
		});

		it("goes back to the top of a section that was left and come back to", () => {
			show(section("One", [row("a"), row("b")]), section("Two", [row("c")]));

			cursorTo("One", "b");
			cursorTo("Sections", "Two");
			cursorTo("Sections", "One");

			expect(activeRow("One")).toHaveTextContent("a");
		});

		it("moves the focus to the rows with OK on a section", () => {
			show(section("One", [row("a"), row("b")]));
			layOutColumns();

			fireEvent.keyDown(activeRow("Sections"), { key: "Enter" });

			expect(activeRow("One")).toHaveFocus();
		});

		it("keeps each section's element when the sections change order", () => {
			const one = section("One", [row("a")]);
			const two = section("Two", [row("b")]);
			const view = render(columns([one, two]));
			const first = screen.getByRole("option", { name: "One" });

			view.rerender(columns([two, one]));

			expect(screen.getByRole("option", { name: "One" })).toBe(first);
		});
	});

	describe("the groups", () => {
		const groups: TvSettingsGroup[] = [
			{ label: "Providers", sections: [section("A", [row("a")]), section("B", [row("b")])] },
			{ label: "App", sections: [section("C", [row("c")]), section("D", [row("d")])] },
		];

		it("shows each group's sections in a list under its name, with a line between them", () => {
			render(grouped(groups));

			expect(rowLabels("Providers")).toEqual(["A", "B"]);
			expect(rowLabels("App")).toEqual(["C", "D"]);
			expect(screen.getByText("Providers")).toHaveAttribute("aria-hidden", "true");
			expect(screen.getByText("App")).toHaveAttribute("aria-hidden", "true");
			expect(screen.getAllByRole("separator")).toHaveLength(1);
			expect(screen.getByRole("separator").nextElementSibling).toBe(screen.getByText("App"));
		});

		it("starts in the first group, and keeps the others out of the tab order", () => {
			render(grouped(groups));

			expect(activeRow("Providers")).toHaveFocus();
			expect(activeRow("App")).toHaveTextContent("C");
			expect(activeRow("App")).toHaveAttribute("tabindex", "-1");
			expect(activeRow("App")).not.toHaveAttribute("data-active");
			expect(column("A")).toBeInTheDocument();
		});

		it("goes on to the next group with Down at a group's end, and back with Up", () => {
			render(grouped(groups));
			cursorTo("Providers", "B");
			const focus = vi.spyOn(HTMLElement.prototype, "focus");

			expect(fireEvent.keyDown(activeRow("Providers"), { key: "ArrowDown" })).toBe(false);

			expect(activeRow("App")).toHaveFocus();
			expect(activeRow("App")).toHaveTextContent("C");
			expect(activeRow("App")).toHaveAttribute("tabindex", "0");
			expect(activeRow("Providers")).toHaveTextContent("B");
			expect(activeRow("Providers")).toHaveAttribute("tabindex", "-1");
			expect(column("C")).toBeInTheDocument();
			for (const [options] of focus.mock.calls)
				expect(options).toEqual({ preventScroll: true });

			fireEvent.keyDown(activeRow("App"), { key: "ArrowUp" });

			expect(activeRow("Providers")).toHaveFocus();
			expect(activeRow("Providers")).toHaveTextContent("B");
			expect(column("B")).toBeInTheDocument();
		});

		it("leaves Up at the first section, Down at the last, and the other arrows to the rest of the screen", () => {
			render(grouped(groups));

			expect(fireEvent.keyDown(activeRow("Providers"), { key: "ArrowUp" })).toBe(true);
			expect(fireEvent.keyDown(activeRow("Providers"), { key: "ArrowRight" })).toBe(true);
			cursorTo("Providers", "B");
			fireEvent.keyDown(activeRow("Providers"), { key: "ArrowDown" });
			expect(fireEvent.keyDown(activeRow("App"), { key: "ArrowRight" })).toBe(true);
			expect(activeRow("App")).toHaveFocus();
			expect(activeRow("App")).toHaveTextContent("C");
			cursorTo("App", "D");
			expect(fireEvent.keyDown(activeRow("App"), { key: "ArrowDown" })).toBe(true);
			expect(activeRow("App")).toHaveTextContent("D");
		});

		it("leaves a held arrow inside a group to the group's list", () => {
			render(grouped([{ label: "Providers", sections: many("P", 40) }, groups[1]]));
			const row = () => activeRow("Providers");

			fireEvent.keyDown(row(), { key: "ArrowDown" });
			for (let press = 0; press < 30; press++) {
				fireEvent.keyDown(row(), { key: "ArrowDown", repeat: true });
			}

			// One row a press, then five once the key has repeated 30 times.
			expect(row()).toHaveTextContent("P35");
		});

		it("gives the first group the whole rows that fit in the room the others leave", () => {
			render(
				grouped([
					{ label: "Providers", sections: many("P", 10, { detail: "1 channel" }) },
					{ label: "App", sections: many("A", 6) },
				])
			);

			expect(parseFloat(column("Providers").style.height)).toBeCloseTo(9.6);
			expect(column("App").style.height).toBe("15rem");
		});

		it("makes every row of a group a card when one has a line under its name", () => {
			render(
				grouped([
					{
						label: "Providers",
						sections: [section("A", [], { detail: "1 channel" }), section("B", [])],
					},
					{ label: "App", sections: many("A", 6) },
				])
			);

			expect(column("Providers").style.height).toBe("6.4rem");
			const heights = (name: string) =>
				within(column(name))
					.getAllByRole("option")
					.map((option) => option.style.height);
			expect(heights("Providers")).toEqual(["3.2rem", "3.2rem"]);
			expect(heights("App")[0]).toBe("2.5rem");
		});

		it("gives the first group one row when the others leave no room", () => {
			render(
				grouped([
					{ label: "Providers", sections: many("P", 3, { detail: "1 channel" }) },
					{ label: "App", sections: many("A", 12) },
				])
			);

			expect(column("Providers").style.height).toBe("3.2rem");
		});

		it("starts in the group of the remembered section", () => {
			const memory = new Map<string, unknown>([
				["test", { section: 2, sectionId: "C", setting: 0 }],
			]);

			render(grouped(groups, memory));

			expect(activeRow("App")).toHaveFocus();
			expect(activeRow("App")).toHaveTextContent("C");
			expect(activeRow("Providers")).toHaveTextContent("B");
			expect(activeRow("Providers")).toHaveAttribute("tabindex", "-1");
		});
	});

	describe("a section's row", () => {
		it("shows its icon, and its name in bold when a line is under it", () => {
			show(
				section("One", [], { icon: <svg data-testid="icon" />, detail: "3 channels" }),
				section("Two", [])
			);

			// Each sits in a box of its own, which sizes it.
			expect(within(column("Sections")).getByTestId("icon").parentElement!.tagName).toBe(
				"SPAN"
			);
			expect(screen.getByText("3 channels").tagName).toBe("P");
			expect(screen.getByText("One")).toHaveClass("font-semibold");
			expect(screen.getByText("Two")).toHaveClass("font-medium");
		});

		it("shows a green dot, or an amber one when the refresh failed", () => {
			show(section("One", [], { status: "failed" }), section("Two", [], { status: "ok" }));

			expect(screen.getByRole("img", { name: "Refresh failed" })).toHaveClass(
				"bg-[hsl(38_92%_55%)]"
			);
			expect(screen.getByRole("img", { name: "OK" })).toHaveClass("bg-[hsl(142_60%_50%)]");
		});

		it("shows its summary over its rows, which make room for it", () => {
			show(
				section("One", [row("a")], { summary: <p>All about One</p> }),
				section("Two", [row("b")])
			);

			expect(screen.getByText("All about One").parentElement!.style.height).toBe("9.2rem");
			expect(parseFloat(column("One").style.height)).toBeCloseTo(22.3);

			cursorTo("Sections", "Two");

			expect(screen.queryByText("All about One")).toBeNull();
			expect(column("Two").style.height).toBe("32rem");
		});
	});

	describe("the rows", () => {
		it("shows a row's icon, and a row that removes something in red", () => {
			show(
				section("One", [
					row("a", { icon: <svg data-testid="icon" /> }),
					row("b", { danger: true }),
				])
			);

			expect(within(column("One")).getByTestId("icon").parentElement!.tagName).toBe("SPAN");
			expect(screen.getByText("b").parentElement).toHaveClass("text-[hsl(0_80%_70%)]");
			expect(screen.getByText("a").parentElement).not.toHaveClass("text-[hsl(0_80%_70%)]");
		});

		it("shows a row's value at its end", () => {
			show(section("One", [row("a", { value: "Yes" })]));

			expect(activeRow("One")).toHaveTextContent("aYes");
		});

		it("shows a spinner only on a row that's busy", () => {
			show(section("One", [row("a", { busy: true }), row("b")]));

			const rows = within(column("One")).getAllByRole("option");
			expect(within(rows[0]).getByLabelText("Working")).toBeInTheDocument();
			expect(within(rows[1]).queryByLabelText("Working")).not.toBeInTheDocument();
		});

		it("shows the hint of the row under the cursor, and the section's aside all along", () => {
			show(
				section("One", [row("a", { hint: "About a" }), row("b", { hint: "About b" })], {
					aside: "About the section",
				})
			);

			expect(screen.getByText("About a")).toBeInTheDocument();
			expect(screen.queryByText("About b")).not.toBeInTheDocument();
			expect(screen.getByText("About the section")).toBeInTheDocument();

			cursorTo("One", "b");

			expect(screen.getByText("About b")).toBeInTheDocument();
			expect(screen.queryByText("About a")).not.toBeInTheDocument();
			expect(screen.getByText("About the section")).toBeInTheDocument();
		});

		it("shows nothing beside the rows when neither the row nor the section has more to say", () => {
			show(section("One", [row("a")]));

			expect(beside("One")).toBeEmptyDOMElement();
		});

		it("shows a section's aside when it has no rows", () => {
			show(section("One", [], { aside: "Nothing here yet" }));

			expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
		});

		it("runs a row's action with OK, ahead of anything else it offers", () => {
			const onSelect = vi.fn();
			const onDone = vi.fn();
			const onPick = vi.fn();
			show(
				section("One", [
					row("a", {
						onSelect,
						choices: [choice("Yes", { onPick })],
						entry: { title: "Type it", value: "", onDone },
					}),
				])
			);
			layOutColumns();

			pressOk("One", "a");

			expect(onSelect).toHaveBeenCalledOnce();
			expect(onPick).not.toHaveBeenCalled();
			expect(activeRow("One")).toHaveFocus();
			expect(dialog()).not.toBeInTheDocument();
		});

		it("does nothing with OK on a row that only informs", () => {
			show(section("One", [row("a")]));
			layOutColumns();

			pressOk("One", "a");

			expect(activeRow("One")).toHaveFocus();
			expect(dialog()).not.toBeInTheDocument();
		});

		it("doesn't open what a row gains after OK on it did nothing", () => {
			const onDone = vi.fn();
			const view = show(section("Main", [row("a")]));

			pressOk("Main", "a");
			view.rerender(
				columns([
					section("Main", [row("a", { entry: { title: "Type it", value: "", onDone } })]),
				])
			);

			expect(dialog()).not.toBeInTheDocument();
		});

		it("acts on the row under the cursor, not the first one", () => {
			const first = vi.fn();
			const second = vi.fn();
			show(
				section("One", [
					row("a", { entry: { title: "First", value: "", onDone: first } }),
					row("b", { entry: { title: "Second", value: "", onDone: second } }),
				])
			);

			pressOk("One", "b");

			expect(screen.getByRole("dialog", { name: "Second" })).toBeInTheDocument();
		});

		it("keeps each row's element when the rows change order", () => {
			const view = show(section("One", [row("a"), row("b")]));
			const first = screen.getByRole("option", { name: "a" });

			view.rerender(columns([section("One", [row("b"), row("a")])]));

			expect(screen.getByRole("option", { name: "a" })).toBe(first);
		});
	});

	describe("a row's answers", () => {
		it("moves the focus to the answers with OK, and opens nothing", () => {
			show(section("One", [row("a", { choices: [choice("Yes")] })]));
			layOutColumns();

			pressOk("One", "a");

			expect(activeRow("Choices")).toHaveFocus();
			expect(dialog()).not.toBeInTheDocument();
		});

		it("starts on the selected answer and marks it as chosen", () => {
			show(
				section("One", [
					row("a", {
						choices: [choice("Yes"), choice("No", { selected: true }), choice("Maybe")],
					}),
				])
			);

			expect(activeRow("Choices")).toHaveTextContent("No");
			expect(within(activeRow("Choices")).getByLabelText("Chosen")).toBeInTheDocument();
			expect(within(column("Choices")).getAllByLabelText("Chosen")).toHaveLength(1);
		});

		it("starts on the first answer when none is selected, and marks none", () => {
			show(
				section("One", [
					row("a", {
						choices: [choice("Yes", { hint: "Yes means yes" }), choice("No")],
					}),
				])
			);

			expect(activeRow("Choices")).toHaveTextContent("Yes");
			expect(screen.getByText("Yes means yes")).toBeInTheDocument();
			expect(within(column("Choices")).queryByLabelText("Chosen")).not.toBeInTheDocument();
		});

		it("is as tall as its answers", () => {
			show(section("One", [row("a", { choices: [choice("Yes"), choice("No")] })]));

			expect(column("Choices").style.height).toBe("4.6rem");
		});

		it("shows the hint of the answer under the cursor", () => {
			show(
				section("One", [
					row("a", {
						choices: [
							choice("Yes", { hint: "Yes means yes" }),
							choice("No", { hint: "No means no" }),
							choice("Maybe"),
						],
					}),
				])
			);

			expect(screen.getByText("Yes means yes")).toBeInTheDocument();

			cursorTo("Choices", "No");

			expect(screen.getByText("No means no")).toBeInTheDocument();
			expect(screen.queryByText("Yes means yes")).not.toBeInTheDocument();

			cursorTo("Choices", "Maybe");

			expect(screen.queryByText("No means no")).not.toBeInTheDocument();
		});

		it("shows no list items for a row with no answers", () => {
			show(section("One", [row("a", { choices: [], hint: "No answers yet" })]));

			expect(within(column("Choices")).queryAllByRole("option")).toEqual([]);
			expect(screen.getByText("No answers yet")).toBeInTheDocument();
		});

		it("picks the answer with OK and goes back to the rows", () => {
			const onPick = vi.fn();
			const other = vi.fn();
			show(
				section("One", [
					row("a", {
						choices: [choice("Yes", { onPick: other }), choice("No", { onPick })],
					}),
				])
			);
			layOutColumns();
			pressOk("One", "a");

			pressOk("Choices", "No");

			expect(onPick).toHaveBeenCalledOnce();
			expect(other).not.toHaveBeenCalled();
			expect(activeRow("One")).toHaveFocus();
		});

		it("starts again on the selected answer when the cursor reaches another row", () => {
			show(
				section("One", [
					row("a", { choices: [choice("Yes"), choice("No", { selected: true })] }),
					row("b", {
						choices: [choice("Red", { selected: true }), choice("Blue")],
					}),
				])
			);
			expect(activeRow("Choices")).toHaveTextContent("No");

			cursorTo("One", "b");

			expect(activeRow("Choices")).toHaveTextContent("Red");
		});

		it("starts again on the selected answer when the same row id is in another section", () => {
			show(
				section("One", [
					row("a", { choices: [choice("Yes"), choice("No", { selected: true })] }),
				]),
				section("Two", [
					row("a", { choices: [choice("Red", { selected: true }), choice("Blue")] }),
				])
			);

			cursorTo("Sections", "Two");

			expect(activeRow("Choices")).toHaveTextContent("Red");
		});

		it("keeps each answer's element when the answers change order", () => {
			const view = show(section("One", [row("a", { choices: [choice("X"), choice("Y")] })]));
			const first = screen.getByRole("option", { name: "X" });

			view.rerender(
				columns([section("One", [row("a", { choices: [choice("Y"), choice("X")] })])])
			);

			expect(screen.getByRole("option", { name: "X" })).toBe(first);
		});
	});

	describe("a row that opens the keyboard", () => {
		const entryRow = (more: Partial<NonNullable<TvSetting["entry"]>> = {}) => {
			const onDone = vi.fn();
			const setting = row("a", {
				entry: { title: "Type it", value: "", onDone, ...more },
			});
			return { onDone, setting };
		};
		const field = () => screen.getByRole("textbox", { name: "Type it" });

		it("opens the keyboard with OK, named by the entry", () => {
			const { setting } = entryRow();
			showRow(setting);

			pressOk("Main", "a");

			expect(screen.getByRole("dialog", { name: "Type it" })).toBeInTheDocument();
		});

		it("starts from the value when there is one, whatever the prefill", () => {
			const { setting } = entryRow({ value: "saved", prefill: "http://" });
			showRow(setting);

			pressOk("Main", "a");

			expect(field()).toHaveValue("saved");
		});

		it("starts from the prefill when the value is empty", () => {
			const { setting } = entryRow({ prefill: "http://" });
			showRow(setting);

			pressOk("Main", "a");

			expect(field()).toHaveValue("http://");
		});

		it("starts empty with neither a value nor a prefill", () => {
			const { setting, onDone } = entryRow();
			showRow(setting);

			pressOk("Main", "a");
			fireEvent.click(button("Done"));

			expect(onDone).toHaveBeenCalledExactlyOnceWith("");
		});

		it("closes and hands over the text with Done", () => {
			const { setting, onDone } = entryRow();
			showRow(setting);

			pressOk("Main", "a");
			enterText("Type it", "typed");

			expect(onDone).toHaveBeenCalledExactlyOnceWith("typed");
			expect(dialog()).not.toBeInTheDocument();
		});

		it("is already closed when its callback runs", () => {
			let open: HTMLElement | null = null;
			const { setting } = entryRow({
				onDone: () => {
					flushSync(() => {});
					open = dialog();
				},
			});
			showRow(setting);

			pressOk("Main", "a");
			enterText("Type it", "typed");

			expect(open).toBeNull();
		});

		it("closes on Back without handing anything over, and gives the focus back", () => {
			const { setting, onDone } = entryRow();
			showRow(setting);

			pressOk("Main", "a");
			back();

			expect(dialog()).not.toBeInTheDocument();
			expect(onDone).not.toHaveBeenCalled();
			expect(activeRow("Main")).toHaveFocus();
		});
	});

	describe("a row that asks first", () => {
		const confirmRow = (onConfirm: () => void = () => {}) =>
			row("a", {
				confirm: {
					title: "Remove it?",
					message: "It can't come back.",
					label: "Remove",
					onConfirm,
				},
			});

		it("shows the question with OK, with Cancel under the cursor", () => {
			showRow(confirmRow());

			pressOk("Main", "a");

			expect(screen.getByRole("dialog", { name: "Remove it?" })).toBeInTheDocument();
			expect(screen.getByRole("heading", { name: "Remove it?" })).toBeInTheDocument();
			expect(screen.getByText("It can't come back.")).toBeInTheDocument();
			expect(button("Cancel")).toHaveFocus();
			expect(button("Remove")).toBeInTheDocument();
		});

		it("closes on Cancel without doing it", () => {
			const onConfirm = vi.fn();
			showRow(confirmRow(onConfirm));

			pressOk("Main", "a");
			fireEvent.click(button("Cancel"));

			expect(dialog()).not.toBeInTheDocument();
			expect(onConfirm).not.toHaveBeenCalled();
		});

		it("closes on Back without doing it", () => {
			const onConfirm = vi.fn();
			showRow(confirmRow(onConfirm));

			pressOk("Main", "a");
			back();

			expect(dialog()).not.toBeInTheDocument();
			expect(onConfirm).not.toHaveBeenCalled();
		});

		it("does it once when the answer is yes, and closes", () => {
			const onConfirm = vi.fn();
			showRow(confirmRow(onConfirm));

			pressOk("Main", "a");
			fireEvent.click(button("Remove"));

			expect(onConfirm).toHaveBeenCalledOnce();
			expect(dialog()).not.toBeInTheDocument();
		});

		it("is already closed when its callback runs", () => {
			let open: HTMLElement | null = null;
			showRow(
				confirmRow(() => {
					flushSync(() => {});
					open = dialog();
				})
			);

			pressOk("Main", "a");
			fireEvent.click(button("Remove"));

			expect(open).toBeNull();
		});
	});

	describe("the remembered place", () => {
		const sections = [
			section("One", [row("a"), row("b")]),
			section("Two", [row("c"), row("d"), row("e")]),
		];

		it("comes back to the same section and row when the screen opens again", () => {
			const memory = new Map<string, unknown>();
			const view = render(columns(sections, memory));

			cursorTo("Sections", "Two");
			cursorTo("Two", "d");
			view.unmount();
			render(columns(sections, memory));

			expect(activeRow("Sections")).toHaveTextContent("Two");
			expect(activeRow("Two")).toHaveTextContent("d");
		});

		it("keeps each screen's place apart", () => {
			const memory = new Map<string, unknown>();
			const view = render(columns(sections, memory));

			cursorTo("Sections", "Two");
			view.unmount();
			render(columns(sections, memory, "other"));

			expect(activeRow("Sections")).toHaveTextContent("One");
		});

		it("starts at the top of a section that took the remembered one's place", () => {
			const memory = new Map<string, unknown>([
				["test", { section: 1, sectionId: "Gone", setting: 2 }],
			]);

			render(columns(sections, memory));

			expect(activeRow("Two")).toHaveTextContent("c");
		});

		it("stops at the last row when the section got shorter", () => {
			const memory = new Map<string, unknown>([
				["test", { section: 0, sectionId: "One", setting: 9 }],
			]);

			render(columns([section("One", [row("a"), row("b", { hint: "About b" })])], memory));

			expect(activeRow("One")).toHaveTextContent("b");
			expect(screen.getByText("About b")).toBeInTheDocument();
		});

		it("stops at the last section when there are fewer sections", () => {
			const memory = new Map<string, unknown>([
				["test", { section: 9, sectionId: "Two", setting: 1 }],
			]);

			render(columns(sections, memory));

			expect(activeRow("Sections")).toHaveTextContent("Two");
			expect(activeRow("Two")).toHaveTextContent("d");
		});
	});
});
