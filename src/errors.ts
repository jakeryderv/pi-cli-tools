import type { CliErrorDetails } from "./types.js";

const MAX_ERROR_MESSAGE_LENGTH = 2_048;
const MAX_ERROR_FIELD_LENGTH = 128;

export function toErrorDetails(error: unknown): CliErrorDetails {
	const value = error instanceof Error ? error : new Error(String(error));
	const nodeError = value as NodeJS.ErrnoException;
	return {
		name: truncateField(value.name, MAX_ERROR_FIELD_LENGTH),
		message: truncateField(value.message, MAX_ERROR_MESSAGE_LENGTH),
		code: typeof nodeError.code === "string" ? truncateField(nodeError.code, MAX_ERROR_FIELD_LENGTH) : null,
		syscall: typeof nodeError.syscall === "string" ? truncateField(nodeError.syscall, MAX_ERROR_FIELD_LENGTH) : null,
	};
}

export function hasErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function truncateField(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
