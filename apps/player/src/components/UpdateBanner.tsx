// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { Download, X, RefreshCw } from "lucide-react";
import type { UpdateState } from "@/hooks/useUpdateChecker";

interface UpdateBannerProps {
	state: UpdateState;
	hidden?: boolean;
}

export const UpdateBanner = ({ state, hidden }: UpdateBannerProps) => {
	if (!state.update || hidden) return null;
	return <UpdateCard state={state} update={state.update} />;
};

/** The banner itself. It mounts each time it shows, so it can fade in. */
const UpdateCard = ({
	state,
	update,
}: {
	state: UpdateState;
	update: NonNullable<UpdateState["update"]>;
}) => {
	const { installing, progress, error, packageInstall, dismiss, install } = state;
	const [visible, setVisible] = useState(false);

	// Start hidden for one frame so the transition has a state to run from.
	useEffect(() => {
		const id = requestAnimationFrame(() => setVisible(true));
		return () => cancelAnimationFrame(id);
	}, []);

	return (
		<div
			className={`fixed bottom-4 right-4 z-50 flex items-center gap-3 bg-card border border-border rounded-xl px-4 py-3 shadow-2xl max-w-sm transition-all duration-300 ease-out ${
				visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
			}`}
		>
			<div className="flex-1 min-w-0">
				<p className="text-sm font-semibold leading-tight">
					Update available — v{update.version}
				</p>
				{installing ? (
					<p className="text-xs text-muted-foreground mt-0.5">
						{progress !== null ? `Downloading… ${progress}%` : "Installing…"}
						{packageInstall && progress === 100 && " (password required)"}
					</p>
				) : (
					<p className="text-xs text-muted-foreground mt-0.5 truncate">
						{update.body ?? "A new version is ready to install."}
					</p>
				)}
				{installing && progress !== null && (
					<div className="mt-1.5 h-1 w-full rounded-full bg-secondary overflow-hidden">
						<div
							className="h-full bg-primary transition-all duration-200"
							style={{ width: `${progress}%` }}
						/>
					</div>
				)}
			</div>

			{error && <p className="text-xs text-destructive mt-1">{error}</p>}

			{installing ? (
				<RefreshCw className="h-4 w-4 text-muted-foreground animate-spin shrink-0" />
			) : (
				<>
					<button
						onClick={install}
						className="flex items-center gap-1.5 text-xs font-semibold bg-primary text-primary-foreground px-3 py-1.5 rounded-lg hover:bg-primary/90 transition-colors shrink-0"
					>
						<Download className="h-3 w-3" />
						Install
					</button>
					<button
						onClick={dismiss}
						aria-label="Dismiss update"
						className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
					>
						<X className="h-4 w-4" />
					</button>
				</>
			)}
		</div>
	);
};
