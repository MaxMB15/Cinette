// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import bmcQr from "@/assets/bmc-qr.png";
import { openUrl } from "@/lib/openUrl";

interface DonationPopupProps {
	onDismiss: () => void;
}

export const DonationPopup = ({ onDismiss }: DonationPopupProps) => {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		const id = requestAnimationFrame(() => setVisible(true));
		return () => cancelAnimationFrame(id);
	}, []);

	return (
		<div
			className={`fixed bottom-4 right-4 z-50 flex flex-col gap-3 bg-card border border-border rounded-xl px-4 py-3 shadow-2xl w-60 transition-all duration-300 ease-out ${
				visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
			}`}
		>
			<div className="flex items-start justify-between gap-2">
				<p className="text-sm font-semibold leading-tight">Enjoying Max Video Player?</p>
				<button
					onClick={onDismiss}
					aria-label="Dismiss donation prompt"
					className="text-muted-foreground hover:text-foreground transition-colors shrink-0 mt-0.5"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			<button
				type="button"
				onClick={() => openUrl("https://buymeacoffee.com/MaxMB15")}
				className="rounded-lg overflow-hidden border border-border hover:border-primary transition-colors"
				aria-label="Donate via Buy Me a Coffee (QR code)"
			>
				<img src={bmcQr} alt="Scan to donate" className="w-full h-auto" />
			</button>

			<button
				type="button"
				onClick={() => openUrl("https://buymeacoffee.com/MaxMB15")}
				className="text-center text-xs font-semibold bg-[#5F7FFF] text-white px-3 py-1.5 rounded-lg hover:opacity-90 transition-opacity"
			>
				Support the project
			</button>

			<p className="text-[10px] text-muted-foreground text-center">
				Free and open source ·{" "}
				<button onClick={onDismiss} className="underline hover:text-foreground">
					dismiss
				</button>
			</p>
		</div>
	);
};
