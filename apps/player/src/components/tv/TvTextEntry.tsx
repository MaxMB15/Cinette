// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState } from "react";
import { ArrowBigUp, Check, Delete, Space, X, type LucideIcon } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { BACKSPACE, CLEAR, SPACE, TvKeys, applyKey } from "./TvKeyboard";
import { TvButton, TvField } from "./ui";

const COLUMNS = 12;
/** Every character a URL or a password is likely to need, by rows of twelve. */
const KEYS = [..."abcdefghijklmnopqrstuvwxyz0123456789./:-_@?&=%#+!$*()~,;'\"[]"];

/** One row of the column beside the keys, which lines up with the keys' rows. */
const Action = ({
	label,
	icon: Icon,
	pressed,
	onClick,
}: {
	label: string;
	icon: LucideIcon;
	pressed?: boolean;
	onClick: () => void;
}) => (
	<div className="flex h-[2.75rem] items-center">
		<TvButton
			aria-pressed={pressed}
			onClick={onClick}
			className="h-[2.5rem] w-full gap-[0.5rem] px-[0.75rem]"
		>
			<Icon aria-hidden className={cn("size-[1.25rem]", pressed && "fill-current")} />
			{label}
		</TvButton>
	</div>
);

/**
 * A whole screen for typing with the D-pad: letters, digits and the signs a
 * URL or password has, with Done beside them. Passwords show as they're
 * typed, since a remote makes a slip easy and hard to find. A real field above
 * the keys takes the system's keyboard. Back cancels.
 */
export const TvTextEntry = ({
	title,
	initial,
	onCancel,
	onDone,
}: {
	title: string;
	initial: string;
	onCancel: () => void;
	onDone: (text: string) => void;
}) => {
	const [text, setText] = useState(initial);
	const [active, setActive] = useState(0);
	const [upper, setUpper] = useState(false);
	const fieldRef = useRef<HTMLInputElement>(null);

	// The field shows the end of a long URL, where the next letter goes.
	useEffect(() => {
		const field = fieldRef.current!;
		field.scrollLeft = field.scrollWidth;
	}, [text]);

	const press = (key: string) => setText((now) => applyKey(now, key));

	return (
		<Dialog
			label={title}
			onClose={onCancel}
			overlayClassName="bg-background"
			className="flex w-[41.5rem] flex-col text-foreground"
		>
			{/* The keys come first, so they take the focus when this opens. The
			    field shows above them. */}
			<div className="flex gap-[0.75rem]">
				<TvKeys
					keys={KEYS}
					columns={COLUMNS}
					active={active}
					onActiveChange={setActive}
					onKey={(key) => press(upper ? key.toUpperCase() : key)}
					upper={upper}
				/>
				<div className="min-w-0 flex-1">
					<Action
						label="Shift"
						icon={ArrowBigUp}
						pressed={upper}
						onClick={() => setUpper((on) => !on)}
					/>
					<Action label="Space" icon={Space} onClick={() => press(SPACE)} />
					<Action label="Delete" icon={Delete} onClick={() => press(BACKSPACE)} />
					<Action label="Clear" icon={X} onClick={() => press(CLEAR)} />
					<Action label="Done" icon={Check} onClick={() => onDone(text)} />
				</div>
			</div>
			<div className="order-first mb-[1rem]">
				<h2 className="mb-[0.75rem] text-[1.5rem] leading-[2rem] font-semibold">{title}</h2>
				<TvField
					ref={fieldRef}
					type="text"
					aria-label={title}
					value={text}
					onChange={(e) => setText(e.target.value)}
					autoComplete="off"
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
					className="h-[3rem] w-full rounded-[0.5rem] bg-white/10 px-[0.75rem] text-[1.125rem] font-medium"
				/>
			</div>
		</Dialog>
	);
};
