// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import * as React from "react";
import { cn } from "@/lib/utils";

interface ScrollAreaProps extends React.ComponentProps<"div"> {}

const ScrollArea = ({ className, children, ...props }: ScrollAreaProps) => (
	<div className={cn("relative overflow-auto scrollbar-hide", className)} {...props}>
		{children}
	</div>
);

export { ScrollArea };
