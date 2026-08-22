/** Shared hard limits for registry validation and direct CLI execution. */
export const CLI_MAX_ARGUMENT_COUNT = 128;
export const CLI_MAX_ARGUMENT_BYTES = 8 * 1024;
export const CLI_MAX_TOTAL_ARGUMENT_BYTES = 32 * 1024;
export const CLI_MAX_PATH_BYTES = 4 * 1024;
export const CLI_MIN_TIMEOUT_MS = 100;
export const CLI_MAX_TIMEOUT_MS = 600_000;
export const CLI_MAX_PROCESS_EXIT_CODE = 255;
export const CLI_MAX_ACCEPTED_EXIT_CODES = CLI_MAX_PROCESS_EXIT_CODE + 1;

// Leave room for status and stream labels in the Pi adapter.
export const CLI_MAX_RETURNED_OUTPUT_BYTES = 48 * 1024;
export const CLI_MAX_RETURNED_OUTPUT_LINES = 1_980;

export const CLI_MAX_SPOOL_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const CLI_MAX_RETAINED_SPOOL_BYTES = 512 * 1024 * 1024;
export const CLI_MAX_RETAINED_SPOOL_DIRECTORIES = 256;
export const CLI_SPOOL_DISK_RESERVATION_BYTES = 2 * CLI_MAX_SPOOL_PAYLOAD_BYTES + 64 * 1024;

export const CLI_TERMINATION_GRACE_MS = 500;
export const CLI_TERMINATION_CONFIRMATION_MS = 5_000;
export const CLI_OUTPUT_DRAIN_GRACE_MS = 5_000;
