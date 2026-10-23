// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import {
	createContext,
	useContext,
	useEffect,
	useRef,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import { cn } from "@/lib/utils";

/** What the trigger needs: its toggle and the attributes that tie it to the menu. */
export interface MenuTriggerProps {
	onClick: () => void;
	"aria-haspopup": "menu";
	"aria-expanded": boolean;
}

interface MenuProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The button that opens it, given the props it needs. */
	trigger: (props: MenuTriggerProps) => ReactNode;
	/** The popover's look and where it sits next to the trigger. */
	className?: string;
	children: ReactNode;
}

/** Closes the menu, for an item that was picked. */
const CloseMenu = createContext<() => void>(() => {});

const ITEMS = '[role^="menuitem"]';

/**
 * A button that opens a list of actions. It closes on a press outside it,
 * and on Escape or a pick, which put focus back on the button. The arrow
 * keys, Home and End move between the items.
 */
export const Menu = ({ open, onOpenChange, trigger, className, children }: MenuProps) => {
	const ref = useRef<HTMLDivElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const onOpenChangeRef = useLatestRef(onOpenChange);
	useEffect(() => {
		if (!open) return;
		// The picked item, or else the first, takes the focus.
		const items = [...menuRef.current!.querySelectorAll<HTMLElement>(ITEMS)];
		(items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
		const outside = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) onOpenChangeRef.current(false);
		};
		window.addEventListener("pointerdown", outside);
		return () => window.removeEventListener("pointerdown", outside);
	}, [open, onOpenChangeRef]);
	// Focus goes back to the button, so it isn't lost with the menu.
	const close = () => {
		onOpenChange(false);
		ref.current!.querySelector<HTMLElement>('[aria-haspopup="menu"]')!.focus();
	};
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			close();
			return;
		}
		const items = [...menuRef.current!.querySelectorAll<HTMLElement>(ITEMS)];
		const at = items.indexOf(document.activeElement as HTMLElement);
		const to =
			e.key === "ArrowDown"
				? (at + 1) % items.length
				: e.key === "ArrowUp"
					? (at - 1 + items.length) % items.length
					: e.key === "Home"
						? 0
						: e.key === "End"
							? items.length - 1
							: null;
		if (to === null) return;
		e.preventDefault();
		items[to].focus();
	};
	return (
		<div className="relative" ref={ref}>
			{trigger({
				onClick: () => onOpenChange(!open),
				"aria-haspopup": "menu",
				"aria-expanded": open,
			})}
			{open && (
				<div
					ref={menuRef}
					role="menu"
					onKeyDown={onKeyDown}
					className={cn(
						"absolute z-20 overflow-y-auto rounded-lg p-1 shadow-xl",
						className
					)}
				>
					<CloseMenu.Provider value={close}>{children}</CloseMenu.Provider>
				</div>
			)}
		</div>
	);
};

interface MenuItemProps {
	onSelect: () => void;
	/** Set for one of a set of choices, which shows whether it's the one picked. */
	checked?: boolean;
	className?: string;
	children: ReactNode;
}

/** An item that closes the menu, then does what it says. */
export const MenuItem = ({ onSelect, checked, className, children }: MenuItemProps) => {
	const close = useContext(CloseMenu);
	return (
		<button
			type="button"
			role={checked === undefined ? "menuitem" : "menuitemradio"}
			aria-checked={checked}
			tabIndex={-1}
			onClick={() => {
				close();
				onSelect();
			}}
			className={cn(
				"flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left focus-visible:outline-hidden",
				className
			)}
		>
			{children}
		</button>
	);
};
