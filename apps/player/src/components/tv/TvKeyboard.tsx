// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Delete, Space, X } from "lucide-react";
import { TvList } from "./TvList";

const KEY_SIZE = 2.75;

export const SPACE = "space";
export const BACKSPACE = "backspace";
export const CLEAR = "clear";

const KEY_ICONS = { [SPACE]: Space, [BACKSPACE]: Delete, [CLEAR]: X } as const;

/** What a key on the screen's keyboard does to the text. */
export const applyKey = (text: string, key: string): string => {
	if (key === SPACE) return `${text} `;
	if (key === BACKSPACE) return text.slice(0, -1);
	if (key === CLEAR) return "";
	return text + key;
};

/** A grid of keys for the D-pad. OK on a key calls `onKey` with its name. */
export const TvKeys = ({
	keys,
	columns,
	active,
	onActiveChange,
	onKey,
	upper,
	start = false,
}: {
	keys: readonly string[];
	columns: number;
	active: number;
	onActiveChange: (index: number) => void;
	onKey: (key: string) => void;
	/** Whether the letters show as capitals. */
	upper: boolean;
	start?: boolean;
}) => (
	<div className="shrink-0" style={{ width: `${KEY_SIZE * columns}rem` }}>
		<TvList
			items={keys}
			label="Letters"
			itemKey={(k) => k}
			active={active}
			onActiveChange={onActiveChange}
			onSelect={onKey}
			rowHeight={KEY_SIZE}
			columnWidth={KEY_SIZE}
			columns={columns}
			height={KEY_SIZE * Math.ceil(keys.length / columns)}
			start={start}
			itemClassName="rounded-[0.5rem]"
			renderItem={(k) => <Key name={k} upper={upper} />}
		/>
	</div>
);

const Key = ({ name, upper }: { name: string; upper: boolean }) => {
	const Icon = KEY_ICONS[name as keyof typeof KEY_ICONS];
	return (
		<div className="flex h-full items-center justify-center rounded-[0.5rem] text-[1.125rem] font-medium">
			{Icon ? (
				<Icon aria-label={name} className="size-[1.25rem]" />
			) : upper ? (
				name.toUpperCase()
			) : (
				name
			)}
		</div>
	);
};
