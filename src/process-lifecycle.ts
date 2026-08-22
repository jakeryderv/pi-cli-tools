import { spawn } from "node:child_process";
import { addAbortListener } from "node:events";

import { hasErrorCode, toErrorDetails } from "./errors.js";
import { CLI_OUTPUT_DRAIN_GRACE_MS, CLI_TERMINATION_CONFIRMATION_MS, CLI_TERMINATION_GRACE_MS } from "./limits.js";
import type {
	CliCancellationTermination,
	CliCaptureMetadata,
	CliErrorDetails,
	CliExecutionStatus,
	CliProcessGroupCleanup,
	CliTermination,
	CliTimeoutTermination,
} from "./types.js";

const GROUP_POLL_INTERVAL_MS = 25;

type OutputStreamName = "stdout" | "stderr";
type TerminationReason = "timed_out" | "cancelled";
type CaptureCutoffReason = Exclude<CliCaptureMetadata["reason"], null>;

export interface ProcessExecutionRequest {
	readonly executablePath: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly environment: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
	readonly startedAt: bigint;
	readonly onPipes: (stdout: NodeJS.ReadableStream, stderr: NodeJS.ReadableStream) => void;
	readonly onOutput: (stream: OutputStreamName, chunk: Buffer) => void;
}

export interface ProcessExecutionOutcome {
	readonly status: CliExecutionStatus;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly spawnError: CliErrorDetails | null;
	readonly termination: CliTermination | null;
	readonly processGroupCleanup: CliProcessGroupCleanup | null;
	readonly capture: CliCaptureMetadata;
}

interface MutableControlMetadata {
	reason: "timed_out" | "cancelled" | "natural_exit";
	attempted: boolean;
	forced: boolean;
	confirmed: boolean;
	error: CliErrorDetails | null;
}

interface ControlState {
	metadata: MutableControlMetadata;
	groupGone: boolean;
}

interface MutableLifecycleState {
	spawned: boolean;
	closed: boolean;
	settled: boolean;
	stdoutEnded: boolean;
	stderrEnded: boolean;
	cause: CliExecutionStatus | null;
	pendingTermination: TerminationReason | null;
	exitCode: number | null;
	exitSignal: NodeJS.Signals | null;
	spawnError: CliErrorDetails | null;
	control: ControlState | null;
	processGroupCleanup: CliProcessGroupCleanup | null;
	capture: CliCaptureMetadata;
}

/** Spawn and supervise one POSIX process group without owning output projection or storage. */
export async function executeCliProcess(request: ProcessExecutionRequest): Promise<ProcessExecutionOutcome> {
	if (request.signal?.aborted) return preCancelledOutcome();

	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(request.executablePath, request.args, {
			cwd: request.cwd,
			env: request.environment,
			detached: true,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		return spawnErrorOutcome(toErrorDetails(error));
	}

	if (!child.stdout || !child.stderr) {
		if (child.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// The structured spawn failure below remains the primary outcome.
			}
		}
		return spawnErrorOutcome(toErrorDetails(new Error("Child process pipes were not created")));
	}

	const stdout = child.stdout;
	const stderr = child.stderr;
	request.onPipes(stdout, stderr);

	const state: MutableLifecycleState = {
		spawned: false,
		closed: false,
		settled: false,
		stdoutEnded: false,
		stderrEnded: false,
		cause: null,
		pendingTermination: null,
		exitCode: null,
		exitSignal: null,
		spawnError: null,
		control: null,
		processGroupCleanup: null,
		capture: { complete: true, cutOff: false, reason: null },
	};
	let timeoutTimer: NodeJS.Timeout | undefined;
	let forceTimer: NodeJS.Timeout | undefined;
	let confirmationTimer: NodeJS.Timeout | undefined;
	let groupPollTimer: NodeJS.Timeout | undefined;
	let outputDrainTimer: NodeJS.Timeout | undefined;
	let abortDisposable: Disposable | undefined;

	let resolveLifecycle: (() => void) | undefined;
	const lifecycle = new Promise<void>((resolve) => {
		resolveLifecycle = resolve;
	});

	const clearTimer = (timer: NodeJS.Timeout | undefined): void => {
		if (timer) clearTimeout(timer);
	};

	const disposeTriggers = (): void => {
		clearTimer(timeoutTimer);
		timeoutTimer = undefined;
		abortDisposable?.[Symbol.dispose]();
		abortDisposable = undefined;
	};

	const clearControlTimers = (): void => {
		clearTimer(forceTimer);
		clearTimer(confirmationTimer);
		clearTimer(groupPollTimer);
		clearTimer(outputDrainTimer);
	};

	const detachApplicationListeners = (): void => {
		stdout.off("data", onStdoutData);
		stderr.off("data", onStderrData);
		stdout.off("end", onStdoutEnd);
		stderr.off("end", onStderrEnd);
		child.off("spawn", onSpawn);
		child.off("error", onError);
		child.off("exit", onExit);
		child.off("close", onClose);
		child.once("error", () => undefined);
	};

	const settleLifecycle = (): void => {
		if (state.settled) return;
		state.settled = true;
		disposeTriggers();
		clearControlTimers();
		detachApplicationListeners();
		resolveLifecycle?.();
	};

	const recordControlError = (error: unknown): void => {
		if (state.control && !state.control.metadata.error) state.control.metadata.error = toErrorDetails(error);
	};

	const probeProcessGroup = (): boolean => {
		if (!child.pid) return false;
		try {
			process.kill(-child.pid, 0);
			return true;
		} catch (error) {
			if (hasErrorCode(error, "ESRCH")) return false;
			recordControlError(error);
			return true;
		}
	};

	const setCaptureCutoff = (reason: CaptureCutoffReason): void => {
		if (state.stdoutEnded && state.stderrEnded) return;
		state.capture = { complete: false, cutOff: true, reason };
	};

	const destroyOutput = (reason: CaptureCutoffReason): void => {
		setCaptureCutoff(reason);
		stdout.destroy();
		stderr.destroy();
	};

	const trySettleControl = (): void => {
		if (!state.control?.groupGone || !state.closed) return;
		if (state.control.metadata.reason === "natural_exit") {
			state.processGroupCleanup = toNaturalCleanup(state.control.metadata);
		}
		settleLifecycle();
	};

	const markGroupGone = (): void => {
		if (!state.control) return;
		state.control.groupGone = true;
		state.control.metadata.confirmed = true;
		clearTimer(forceTimer);
		forceTimer = undefined;
		clearTimer(groupPollTimer);
		groupPollTimer = undefined;
		trySettleControl();
	};

	const sendGroupSignal = (processSignal: NodeJS.Signals): "sent" | "gone" | "failed" => {
		if (!child.pid || !state.control) return "failed";
		try {
			process.kill(-child.pid, processSignal);
			return "sent";
		} catch (error) {
			if (hasErrorCode(error, "ESRCH")) {
				markGroupGone();
				return "gone";
			}
			recordControlError(error);
			return "failed";
		}
	};

	const pollProcessGroup = (): void => {
		if (!state.control || state.control.groupGone || state.settled) return;
		if (!probeProcessGroup()) {
			markGroupGone();
			return;
		}
		groupPollTimer = setTimeout(pollProcessGroup, GROUP_POLL_INTERVAL_MS);
	};

	const beginControl = (reason: TerminationReason | "natural_exit"): void => {
		if (state.control || state.settled) return;
		disposeTriggers();
		clearTimer(outputDrainTimer);
		outputDrainTimer = undefined;
		state.control = {
			metadata: {
				reason,
				attempted: Boolean(child.pid),
				forced: false,
				confirmed: false,
				error: null,
			},
			groupGone: false,
		};

		if (!child.pid || !probeProcessGroup()) {
			state.control.metadata.attempted = false;
			markGroupGone();
			return;
		}

		sendGroupSignal("SIGTERM");
		if (!state.control.groupGone) {
			forceTimer = setTimeout(() => {
				if (!state.control || state.control.groupGone || state.settled) return;
				if (!probeProcessGroup()) {
					markGroupGone();
					return;
				}
				if (sendGroupSignal("SIGKILL") === "sent") state.control.metadata.forced = true;
			}, CLI_TERMINATION_GRACE_MS);
			groupPollTimer = setTimeout(pollProcessGroup, GROUP_POLL_INTERVAL_MS);
		}

		confirmationTimer = setTimeout(() => {
			if (!state.control || state.settled) return;
			if (!state.control.groupGone && !probeProcessGroup()) markGroupGone();
			if (lifecycleIsSettled()) return;
			state.control.metadata.confirmed = state.control.groupGone;
			if (state.control.metadata.reason === "natural_exit") {
				state.processGroupCleanup = toNaturalCleanup(state.control.metadata);
			}
			destroyOutput("termination_confirmation_timeout");
			child.unref();
			settleLifecycle();
		}, CLI_TERMINATION_CONFIRMATION_MS);
	};

	const finishNaturalExitWithoutGroup = (cutoffReason?: CaptureCutoffReason): void => {
		state.processGroupCleanup = {
			reason: "natural_exit",
			attempted: false,
			forced: false,
			confirmed: true,
			error: null,
		};
		if (!state.closed && cutoffReason) {
			destroyOutput(cutoffReason);
			child.unref();
		}
		settleLifecycle();
	};

	const beginNaturalCleanup = (noGroupCutoffReason: CaptureCutoffReason): void => {
		if (state.cause !== "exited" || state.settled || state.control) return;
		if (!probeProcessGroup()) {
			finishNaturalExitWithoutGroup(state.closed ? undefined : noGroupCutoffReason);
			return;
		}
		beginControl("natural_exit");
	};

	const scheduleNaturalDrain = (): void => {
		if (outputDrainTimer || state.settled) return;
		outputDrainTimer = setTimeout(() => {
			beginNaturalCleanup("output_drain_timeout");
		}, CLI_OUTPUT_DRAIN_GRACE_MS);
	};

	const lifecycleIsSettled = (): boolean => state.settled;

	const requestTermination = (reason: TerminationReason): void => {
		if (state.cause === "exited") {
			beginNaturalCleanup("process_group_cleanup");
			return;
		}
		if (state.cause) return;

		state.cause = reason;
		disposeTriggers();
		if (!state.spawned) {
			state.pendingTermination = reason;
			return;
		}
		beginControl(reason);
	};

	function onStdoutData(chunk: Buffer | string): void {
		request.onOutput("stdout", toBuffer(chunk));
	}
	function onStderrData(chunk: Buffer | string): void {
		request.onOutput("stderr", toBuffer(chunk));
	}
	function onStdoutEnd(): void {
		state.stdoutEnded = true;
	}
	function onStderrEnd(): void {
		state.stderrEnded = true;
	}
	function onSpawn(): void {
		state.spawned = true;
		if (state.pendingTermination) {
			const reason = state.pendingTermination;
			state.pendingTermination = null;
			beginControl(reason);
		}
	}
	function onError(error: Error): void {
		state.spawnError = toErrorDetails(error);
		if (state.spawned) return;
		state.cause ??= "spawn_error";
		if (state.cause === "timed_out" || state.cause === "cancelled") {
			state.control = {
				metadata: {
					reason: state.cause,
					attempted: false,
					forced: false,
					confirmed: false,
					error: null,
				},
				groupGone: false,
			};
		}
		settleLifecycle();
	}
	function onExit(code: number | null, processSignal: NodeJS.Signals | null): void {
		state.exitCode = code;
		state.exitSignal = processSignal;
		if (!state.cause) {
			state.cause = "exited";
			scheduleNaturalDrain();
		}
	}
	function onClose(code: number | null, processSignal: NodeJS.Signals | null): void {
		state.closed = true;
		state.stdoutEnded = true;
		state.stderrEnded = true;
		state.exitCode ??= code;
		state.exitSignal ??= processSignal;

		state.cause ??= state.spawned ? "exited" : "spawn_error";
		if (state.cause === "spawn_error") {
			state.spawnError ??= toErrorDetails(new Error("Child process closed before it spawned"));
			settleLifecycle();
			return;
		}
		if (state.cause === "exited") {
			if (!probeProcessGroup()) finishNaturalExitWithoutGroup();
			else beginNaturalCleanup("process_group_cleanup");
			return;
		}
		if (state.control && (state.control.groupGone || !probeProcessGroup())) markGroupGone();
	}

	stdout.on("data", onStdoutData);
	stderr.on("data", onStderrData);
	stdout.once("end", onStdoutEnd);
	stderr.once("end", onStderrEnd);
	child.once("spawn", onSpawn);
	child.once("error", onError);
	child.once("exit", onExit);
	child.once("close", onClose);

	if (request.signal) {
		abortDisposable = addAbortListener(request.signal, () => {
			requestTermination("cancelled");
		});
	}
	const timeoutRemaining = Math.max(0, request.timeoutMs - elapsedMilliseconds(request.startedAt));
	timeoutTimer = setTimeout(() => {
		requestTermination("timed_out");
	}, timeoutRemaining);

	await lifecycle;
	return createOutcome(state);
}

function createOutcome(state: MutableLifecycleState): ProcessExecutionOutcome {
	const status = state.cause ?? "spawn_error";
	if (status === "spawn_error") {
		return {
			status,
			exitCode: null,
			signal: null,
			spawnError: state.spawnError ?? toErrorDetails(new Error("Unable to spawn child process")),
			termination: null,
			processGroupCleanup: null,
			capture: state.capture,
		};
	}
	if (status === "timed_out") {
		const metadata = state.control?.metadata;
		return {
			status,
			exitCode: state.exitCode,
			signal: state.exitSignal,
			spawnError: state.spawnError,
			termination: metadata ? toTermination(metadata, status) : createUnattemptedTermination(status),
			processGroupCleanup: null,
			capture: state.capture,
		};
	}
	if (status === "cancelled") {
		const metadata = state.control?.metadata;
		return {
			status,
			exitCode: state.exitCode,
			signal: state.exitSignal,
			spawnError: state.spawnError,
			termination: metadata ? toTermination(metadata, status) : createUnattemptedTermination(status),
			processGroupCleanup: null,
			capture: state.capture,
		};
	}
	return {
		status: "exited",
		exitCode: state.exitCode,
		signal: state.exitSignal,
		spawnError: null,
		termination: null,
		processGroupCleanup: state.processGroupCleanup ?? {
			reason: "natural_exit",
			attempted: false,
			forced: false,
			confirmed: false,
			error: toErrorDetails(new Error("Natural process-group cleanup state missing")),
		},
		capture: state.capture,
	};
}

function toTermination(metadata: MutableControlMetadata, reason: "timed_out"): CliTimeoutTermination;
function toTermination(metadata: MutableControlMetadata, reason: "cancelled"): CliCancellationTermination;
function toTermination(metadata: MutableControlMetadata, reason: TerminationReason): CliTermination {
	return {
		reason,
		attempted: metadata.attempted,
		forced: metadata.forced,
		confirmed: metadata.confirmed,
		error: metadata.error,
	};
}

function createUnattemptedTermination(reason: "timed_out"): CliTimeoutTermination;
function createUnattemptedTermination(reason: "cancelled"): CliCancellationTermination;
function createUnattemptedTermination(reason: TerminationReason): CliTermination {
	return { reason, attempted: false, forced: false, confirmed: false, error: null };
}

function toNaturalCleanup(metadata: MutableControlMetadata): CliProcessGroupCleanup {
	return {
		reason: "natural_exit",
		attempted: metadata.attempted,
		forced: metadata.forced,
		confirmed: metadata.confirmed,
		error: metadata.error,
	};
}

function preCancelledOutcome(): ProcessExecutionOutcome {
	return {
		status: "cancelled",
		exitCode: null,
		signal: null,
		spawnError: null,
		termination: createUnattemptedTermination("cancelled"),
		processGroupCleanup: null,
		capture: { complete: true, cutOff: false, reason: null },
	};
}

function spawnErrorOutcome(error: CliErrorDetails): ProcessExecutionOutcome {
	return {
		status: "spawn_error",
		exitCode: null,
		signal: null,
		spawnError: error,
		termination: null,
		processGroupCleanup: null,
		capture: { complete: true, cutOff: false, reason: null },
	};
}

function elapsedMilliseconds(startedAt: bigint): number {
	return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

function toBuffer(chunk: Buffer | string): Buffer {
	return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}
