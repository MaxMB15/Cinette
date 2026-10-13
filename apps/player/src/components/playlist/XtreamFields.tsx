// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

interface XtreamFieldsProps {
	/**
	 * The add form is compact and names its fields with placeholders. The
	 * settings modal shows labels above smaller inputs and lets fields stay
	 * empty, since it saves more than the login.
	 */
	variant: "add" | "edit";
	url: string;
	username: string;
	password: string;
	onUrlChange: (value: string) => void;
	onUsernameChange: (value: string) => void;
	onPasswordChange: (value: string) => void;
}

export const XtreamFields = ({
	variant,
	url,
	username,
	password,
	onUrlChange,
	onUsernameChange,
	onPasswordChange,
}: XtreamFieldsProps) => {
	const editing = variant === "edit";
	const inputProps = editing ? { className: "h-8 text-sm" } : { required: true };

	return (
		<>
			<Field label="Server URL" hideLabel={!editing}>
				{(id) => (
					<Input
						id={id}
						value={url}
						onChange={(e) => onUrlChange(e.target.value)}
						placeholder={
							editing
								? "http://example.com:8080"
								: "Server URL (e.g. http://example.com:8080)"
						}
						{...inputProps}
					/>
				)}
			</Field>
			<Field label="Username" hideLabel={!editing}>
				{(id) => (
					<Input
						id={id}
						value={username}
						onChange={(e) => onUsernameChange(e.target.value)}
						placeholder="Username"
						{...inputProps}
					/>
				)}
			</Field>
			<Field label="Password" hideLabel={!editing}>
				{(id) => (
					<Input
						id={id}
						value={password}
						onChange={(e) => onPasswordChange(e.target.value)}
						placeholder="Password"
						type="password"
						{...inputProps}
					/>
				)}
			</Field>
		</>
	);
};
