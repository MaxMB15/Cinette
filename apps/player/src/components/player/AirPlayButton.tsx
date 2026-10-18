// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Airplay } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

/** How long a reason stays up. */
const NOTICE_MS = 6000;

interface AirPlayButtonProps {
	/**
	 * Sends the current item to AirPlay, with the system picker anchored at
	 * the button. Resolves to why it couldn't, or `null`.
	 */
	onSend: (anchor: DOMRect) => Promise<string | null>;
}

/** The player's AirPlay button. Says why under it when an item can't go. */
export const AirPlayButton = ({ onSend }: AirPlayButtonProps) => {
	const ref = useRef<HTMLButtonElement>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice]);

	const send = async () => {
		const button = ref.current;
		if (busy || !button) return;
		setBusy(true);
		setNotice(null);
		try {
			setNotice(await onSend(button.getBoundingClientRect()));
		} catch {
			setNotice("Couldn't start AirPlay.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="relative">
			<Button
				ref={ref}
				variant="ghost"
				size="icon"
				className="text-white hover:bg-white/20"
				onClick={send}
				disabled={busy}
				aria-label="AirPlay"
			>
				<Airplay className="h-5 w-5" />
			</Button>
			{notice && (
				<p
					role="alert"
					className="absolute right-0 bottom-full mb-2 w-56 rounded bg-black/90 px-3 py-2 text-left text-xs text-white"
				>
					{notice}
				</p>
			)}
		</div>
	);
};
