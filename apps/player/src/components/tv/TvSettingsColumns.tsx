// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, LoaderCircle } from "lucide-react";
import { moveFocus } from "@/lib/tv-focus";
import { cn } from "@/lib/utils";
import { TvList } from "./TvList";
import { TvPrompt } from "./TvPrompt";
import { TvTextEntry } from "./TvTextEntry";
import { COLUMN_HEIGHT, TvButton, TvHeader, TvTextRow } from "./ui";
import { useRemembered } from "./tv-nav";

/** A setting's row and an answer's row. */
const ROW_HEIGHT = 2.3;
/** A section with only its name. */
const SECTION_HEIGHT = 2.5;
/** A section with a line under its name, like a provider's card. */
const CARD_HEIGHT = 3.2;
/** The name over a group of sections, and the line between two groups, as their classes set them. */
const HEADING_HEIGHT = 1.7;
const DIVIDER_HEIGHT = 1.25;
/** The frame over a section's rows that sums it up, and the gap under it. */
const SUMMARY_HEIGHT = 9.2;
const SUMMARY_GAP = 0.5;

const STATUS = {
	ok: { label: "OK", className: "bg-[hsl(142_60%_50%)]" },
	failed: { label: "Refresh failed", className: "bg-[hsl(38_92%_55%)]" },
};

/** One answer in a setting's list of choices. */
export interface TvChoice {
	label: string;
	selected: boolean;
	onPick: () => void;
	/** What this answer means, shown while the cursor is on it. */
	hint?: string;
}

/** One row of a settings screen. OK does what the first of its last four fields says. */
export interface TvSetting {
	id: string;
	label: string;
	/** Its value, at the end of the row. */
	value?: string;
	/** Before the label, for a row that does something. */
	icon?: ReactNode;
	/** Red, for a row that removes something. */
	danger?: boolean;
	/** More about it, beside the list while the cursor is on the row. */
	hint?: ReactNode;
	/** Shows a spinner while something the row started is running. */
	busy?: boolean;
	onSelect?: () => void;
	/** Answers to choose from, which show beside the list. */
	choices?: TvChoice[];
	/** Opens the keyboard. `prefill` is what an empty field starts with. */
	entry?: { title: string; value: string; prefill?: string; onDone: (text: string) => void };
	/** Asks first, with Cancel where the cursor starts, so a stray OK changes nothing. */
	confirm?: { title: string; message: string; label: string; onConfirm: () => void };
}

/** One entry of a settings screen's first column. */
export interface TvSettingsSection {
	id: string;
	label: string;
	/** Before the label. */
	icon?: ReactNode;
	/** A line under the label, which makes every row of its group a card. */
	detail?: string;
	/** A dot at the end of the row: green, or amber when the last refresh failed. */
	status?: keyof typeof STATUS;
	/** A frame over this section's rows that sums it up. */
	summary?: ReactNode;
	/** What always shows beside this section's rows. */
	aside?: ReactNode;
	settings: TvSetting[];
}

/** Sections under one heading in the first column. A group has at least one. */
export interface TvSettingsGroup {
	label: string;
	sections: TvSettingsSection[];
}

/** A row that turns something on or off with OK. */
export const toggleRow = (
	id: string,
	label: string,
	on: boolean,
	onChange: (on: boolean) => void,
	hint?: ReactNode
): TvSetting => ({
	id,
	label,
	value: on ? "On" : "Off",
	hint,
	onSelect: () => onChange(!on),
});

/** A row with a list of answers. */
export const choiceRow = <T,>(
	id: string,
	label: string,
	options: readonly { value: T; label: string }[],
	current: T,
	onPick: (value: T) => void,
	hint?: ReactNode
): TvSetting => ({
	id,
	label,
	value: options.find((o) => o.value === current)?.label,
	hint,
	choices: options.map((o) => ({
		label: o.label,
		selected: o.value === current,
		onPick: () => onPick(o.value),
	})),
});

/** A dot that's green, or amber when the last refresh failed. */
export const TvStatusDot = ({ status }: { status: keyof typeof STATUS }) => (
	<span
		role="img"
		aria-label={STATUS[status].label}
		className={cn("size-[0.45rem] shrink-0 rounded-full", STATUS[status].className)}
	/>
);

const SectionRow = ({ section }: { section: TvSettingsSection }) => (
	<div className="flex h-full items-center gap-[0.6rem] px-[0.6rem]">
		{section.icon && (
			<span className="flex shrink-0 [&>svg]:size-[1.1rem] [&>svg]:opacity-75">
				{section.icon}
			</span>
		)}
		<div className="min-w-0 flex-1">
			<p
				className={cn(
					"truncate text-[1rem] leading-[1.2rem]",
					section.detail ? "font-semibold" : "font-medium"
				)}
			>
				{section.label}
			</p>
			{section.detail && (
				<p className="truncate text-[0.75rem] leading-[1rem] opacity-70">
					{section.detail}
				</p>
			)}
		</div>
		{section.status && <TvStatusDot status={section.status} />}
	</div>
);

const SettingRow = ({ setting }: { setting: TvSetting }) => (
	<div
		className={cn(
			"flex h-full items-center gap-[0.6rem] px-[0.75rem] text-[0.95rem] leading-[1.2rem] font-medium",
			setting.danger && "text-[hsl(0_80%_70%)] in-focus:text-[hsl(0_72%_42%)]"
		)}
	>
		{setting.icon && (
			<span className="flex shrink-0 opacity-80 [&>svg]:size-[1rem]">{setting.icon}</span>
		)}
		<span className="shrink-0">{setting.label}</span>
		<span className="ml-auto min-w-0 truncate text-[0.85rem] leading-[1rem] opacity-65">
			{setting.value}
		</span>
		{setting.busy && (
			<LoaderCircle aria-label="Working" className="size-[1rem] shrink-0 animate-spin" />
		)}
	</div>
);

/**
 * The list of a setting's answers. The cursor starts on the current answer,
 * and picking one goes back to the rows.
 */
const Choices = ({ choices }: { choices: TvChoice[] }) => {
	const [active, setActive] = useState(() =>
		Math.max(
			0,
			choices.findIndex((c) => c.selected)
		)
	);
	return (
		<>
			<TvList
				items={choices}
				label="Choices"
				itemKey={(c) => c.label}
				active={active}
				onActiveChange={setActive}
				onSelect={(c) => {
					c.onPick();
					moveFocus("left");
				}}
				rowHeight={ROW_HEIGHT}
				height={ROW_HEIGHT * choices.length}
				itemClassName="rounded-[0.5rem]"
				renderItem={(c) => (
					<TvTextRow
						label={c.label}
						end={
							c.selected ? (
								<Check aria-label="Chosen" className="size-[1rem]" />
							) : undefined
						}
					/>
				)}
			/>
			{choices[active]?.hint && <Text>{choices[active].hint}</Text>}
		</>
	);
};

const Text = ({ children }: { children: ReactNode }) => (
	<div className="mt-[0.5rem] px-[0.75rem] text-[0.875rem] leading-[1.25rem] [&>p]:opacity-70 [&>p+p]:mt-[0.5rem]">
		{children}
	</div>
);

/**
 * A settings screen in three columns, walked left and right: its sections, the
 * rows of the one under the cursor, and what the row under the cursor offers.
 * A change takes effect as soon as it's made, so there's nothing to save.
 *
 * The sections come in groups, each a list under its heading, and Up and Down
 * go on from one group's list to the next. The first group takes the room the
 * others leave.
 */
export const TvSettingsColumns = ({
	title,
	memoryKey,
	groups,
}: {
	title: string;
	/** Where the screen's place is kept while another one is open. */
	memoryKey: string;
	groups: TvSettingsGroup[];
}) => {
	// Stryker disable next-line StringLiteral: a section's row number starts at 0 whether or not the id matches, so no test can tell.
	const [place, setPlace] = useRemembered(memoryKey, { section: 0, sectionId: "", setting: 0 });
	const [openId, setOpenId] = useState<string | null>(null);

	const sections = groups.flatMap((g) => g.sections);
	/** Where each group's sections start among all of them. */
	const firsts = groups.map((_, i) => groups.slice(0, i).flatMap((g) => g.sections).length);
	const rowHeights = groups.map((g) =>
		g.sections.some((s) => s.detail) ? CARD_HEIGHT : SECTION_HEIGHT
	);
	// Every group's list shows all its rows but the first's, which gets as many
	// whole rows as fit in what's left, and at least one.
	const [whole, ...rest] = groups.map((g, i) => g.sections.length * rowHeights[i]);
	const room = rest.reduce(
		(left, height) => left - DIVIDER_HEIGHT - height,
		COLUMN_HEIGHT - groups.length * HEADING_HEIGHT
	);
	const heights = [
		Math.min(whole, Math.max(1, Math.floor(room / rowHeights[0])) * rowHeights[0]),
		...rest,
	];

	const sectionIndex = Math.min(place.section, sections.length - 1);
	const section = sections[sectionIndex];
	// A row number means nothing in another section, as when a new one took this place.
	const settingIndex =
		place.sectionId === section.id ? Math.min(place.setting, section.settings.length - 1) : 0;
	const setting = section.settings[settingIndex];
	const opened = section.settings.find((s) => s.id === openId);
	const entry = opened?.entry;
	const confirm = opened?.confirm;

	const choose = (s: TvSetting) => {
		if (s.onSelect) s.onSelect();
		else if (s.choices) moveFocus("right");
		else if (s.entry || s.confirm) setOpenId(s.id);
	};

	const goTo = (index: number) =>
		setPlace({ section: index, sectionId: sections[index].id, setting: 0 });

	/** Up at a group's top and Down at its end go on to the group above or below. */
	const crossGroups = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
		const to = sectionIndex + step;
		if (e.defaultPrevented || step === 0 || !sections[to]) return;
		e.preventDefault();
		const group = firsts.filter((first) => first <= to).length - 1;
		e.currentTarget
			.querySelectorAll('[role="listbox"]')
			[group].querySelector<HTMLElement>('[aria-selected="true"]')!
			.focus({ preventScroll: true });
		goTo(to);
	};

	return (
		<div className="flex h-full flex-col">
			<TvHeader title={title} />
			<div className="flex gap-[1.3rem] px-[1.5rem]">
				<div className="w-[13rem] shrink-0" onKeyDown={crossGroups}>
					{groups.map((g, i) => {
						const first = firsts[i];
						const local = sectionIndex - first;
						const holds = local >= 0 && local < g.sections.length;
						return (
							<div key={g.label}>
								{i > 0 && (
									<div
										role="separator"
										className="mx-[0.75rem] my-[0.6rem] h-[0.05rem] bg-white/12"
									/>
								)}
								<div
									aria-hidden
									className="flex h-[1.7rem] items-end px-[0.75rem] pb-[0.3rem] text-[0.7rem] leading-[0.9rem] font-bold tracking-[0.12em] uppercase opacity-50"
								>
									{g.label}
								</div>
								<TvList
									items={g.sections}
									label={g.label}
									itemKey={(s) => s.id}
									// The list stops it at its first or last row, which keeps a group's
									// place next to the one with the cursor.
									active={local}
									onActiveChange={(index) => goTo(first + index)}
									onSelect={() => moveFocus("right")}
									rowHeight={rowHeights[i]}
									height={heights[i]}
									start={holds}
									focusable={holds}
									itemClassName="rounded-[0.6rem]"
									renderItem={(s) => <SectionRow section={s} />}
								/>
							</div>
						);
					})}
				</div>
				<div className="flex w-[23.5rem] shrink-0 flex-col gap-[0.5rem]">
					{section.summary && (
						<div
							className="shrink-0 rounded-[0.8rem] border border-white/8 bg-white/6 px-[1rem] py-[0.9rem]"
							style={{ height: `${SUMMARY_HEIGHT}rem` }}
						>
							{section.summary}
						</div>
					)}
					<TvList
						items={section.settings}
						label={section.label}
						itemKey={(s) => s.id}
						active={settingIndex}
						onActiveChange={(i) =>
							setPlace({ section: sectionIndex, sectionId: section.id, setting: i })
						}
						onSelect={choose}
						rowHeight={ROW_HEIGHT}
						height={
							COLUMN_HEIGHT - (section.summary ? SUMMARY_HEIGHT + SUMMARY_GAP : 0)
						}
						itemClassName="rounded-[0.5rem]"
						renderItem={(s) => <SettingRow setting={s} />}
					/>
				</div>
				<div className="min-w-0 flex-1">
					{setting?.choices && (
						<Choices key={`${section.id}/${setting.id}`} choices={setting.choices} />
					)}
					{setting?.hint && <Text>{setting.hint}</Text>}
					{section.aside && <Text>{section.aside}</Text>}
				</div>
			</div>
			{entry && (
				<TvTextEntry
					title={entry.title}
					initial={entry.value || (entry.prefill ?? "")}
					onCancel={() => setOpenId(null)}
					onDone={(text) => {
						setOpenId(null);
						// A start left as it was isn't an answer.
						entry.onDone(text === entry.prefill ? "" : text);
					}}
				/>
			)}
			{confirm && (
				<TvPrompt
					title={confirm.title}
					text={confirm.message}
					onClose={() => setOpenId(null)}
				>
					<TvButton onClick={() => setOpenId(null)}>Cancel</TvButton>
					<TvButton
						onClick={() => {
							setOpenId(null);
							confirm.onConfirm();
						}}
					>
						{confirm.label}
					</TvButton>
				</TvPrompt>
			)}
		</div>
	);
};
