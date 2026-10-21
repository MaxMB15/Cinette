// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Cast as CastIcon, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DevicePicker } from "@/components/remote/DevicePicker";
import type { Cast } from "@/hooks/useCast";
import { castEntries, castPickerNotice } from "@/lib/cast";
import { LOCAL_ENTRY } from "@/lib/device-picker";
import type { Channel } from "@/lib/types";

interface CastButtonProps {
	cast: Cast;
	/** What plays here now, which the picker works out each route for. */
	channel: Channel;
	/** Casts to the receiver chosen, after the confirm step for a converted
	 *  route. The player says why when it can't. */
	onSend: (receiverId: string) => Promise<void>;
}

/**
 * The player's Cast button. It opens the device picker with this device and
 * the Cast receivers, each showing how this item would get there, or says
 * why it can't find any.
 */
export const CastButton = ({ cast, channel, onSend }: CastButtonProps) => {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);

	const close = () => {
		setOpen(false);
		cast.release();
	};
	// The button is disabled while a cast starts, so one starts at a time.
	const select = async (id: string) => {
		close();
		if (id === LOCAL_ENTRY.id) return;
		setBusy(true);
		// On the promise, since the React Compiler can't compile `finally`.
		await onSend(id).catch(() => {});
		setBusy(false);
	};

	return (
		<>
			<Button
				variant="ghost"
				size="icon"
				className="text-white hover:bg-white/20"
				onClick={() => setOpen(true)}
				disabled={busy}
				aria-label="Cast"
				aria-haspopup="dialog"
			>
				{busy ? (
					<Loader2 className="h-5 w-5 animate-spin" aria-hidden />
				) : (
					<CastIcon className="h-5 w-5" aria-hidden />
				)}
			</Button>
			<DevicePicker
				open={open}
				onClose={close}
				entries={[LOCAL_ENTRY, ...castEntries(cast.receivers, cast.statuses)]}
				activeId={LOCAL_ENTRY.id}
				onSelect={(id) => void select(id)}
				onOpen={() => cast.check(channel)}
				notice={castPickerNotice(cast)}
			/>
		</>
	);
};
