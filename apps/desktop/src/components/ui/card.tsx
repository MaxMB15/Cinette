// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import * as React from "react";
import { cn } from "@/lib/utils";

const Card = ({ className, ...props }: React.ComponentProps<"div">) => (
	<div
		className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)}
		{...props}
	/>
);

const CardHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
	<div className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
);

const CardTitle = ({ className, ...props }: React.ComponentProps<"h3">) => (
	<h3
		className={cn("text-2xl font-semibold leading-none tracking-tight", className)}
		{...props}
	/>
);

const CardDescription = ({ className, ...props }: React.ComponentProps<"p">) => (
	<p className={cn("text-sm text-muted-foreground", className)} {...props} />
);

const CardContent = ({ className, ...props }: React.ComponentProps<"div">) => (
	<div className={cn("p-6 pt-0", className)} {...props} />
);

const CardFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
	<div className={cn("flex items-center p-6 pt-0", className)} {...props} />
);

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
