// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import * as React from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface SelectOption<T extends string | number> {
	value: T;
	label: string;
}

interface SelectProps<T extends string | number> {
	value: T;
	onChange: (value: T) => void;
	options: SelectOption<T>[];
	placeholder?: string;
	className?: string;
	"aria-label"?: string;
}

export const Select = <T extends string | number>({
	value,
	onChange,
	options,
	placeholder,
	className,
	"aria-label": ariaLabel,
}: SelectProps<T>) => {
	const [open, setOpen] = React.useState(false);
	const ref = React.useRef<HTMLDivElement>(null);

	const selected = options.find((o) => o.value === value);

	React.useEffect(() => {
		const handler = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		if (open) document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	return (
		<div ref={ref} className={cn("relative", className)}>
			<button
				type="button"
				aria-label={ariaLabel}
				aria-expanded={open}
				aria-haspopup="listbox"
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-secondary px-3 py-2.5 text-sm text-foreground transition-colors hover:bg-accent focus:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
			>
				<span className="truncate">{selected?.label ?? placeholder ?? "Select…"}</span>
				<ChevronDown
					className={cn(
						"h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
						open && "rotate-180"
					)}
				/>
			</button>

			{open && (
				<div className="absolute z-50 mt-1 w-full overflow-hidden rounded-xl border border-border bg-popover shadow-lg animate-in fade-in-0 zoom-in-95">
					<ul
						role="listbox"
						aria-label={ariaLabel}
						className="py-1 max-h-48 overflow-auto"
					>
						{options.map((opt) => (
							<li
								key={opt.value}
								role="option"
								aria-selected={opt.value === value}
								onClick={() => {
									onChange(opt.value as T);
									setOpen(false);
								}}
								className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
							>
								<Check
									className={cn(
										"h-3.5 w-3.5 shrink-0 text-primary",
										opt.value === value ? "opacity-100" : "opacity-0"
									)}
								/>
								<span className="truncate">{opt.label}</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
};
