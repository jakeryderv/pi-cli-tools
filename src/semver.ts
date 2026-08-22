const NUMERIC_IDENTIFIER = "(?:0|[1-9]\\d*)";
const PRERELEASE_IDENTIFIER = `(?:${NUMERIC_IDENTIFIER}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const BUILD_IDENTIFIER = "[0-9A-Za-z-]+";
const STRICT_SEMVER = new RegExp(
	`^(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})\\.(${NUMERIC_IDENTIFIER})(?:-(${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*))?(?:\\+(${BUILD_IDENTIFIER}(?:\\.${BUILD_IDENTIFIER})*))?$`,
	"u",
);

export interface ParsedSemver {
	readonly major: string;
	readonly minor: string;
	readonly patch: string;
	readonly prerelease: readonly string[];
	readonly build: readonly string[];
}

/** Parse exactly one SemVer 2.0.0 value, including identifier leading-zero rules. */
export function parseStrictSemver(value: string): ParsedSemver | null {
	const match = STRICT_SEMVER.exec(value);
	if (!match?.[1] || !match[2] || !match[3]) return null;
	return {
		major: match[1],
		minor: match[2],
		patch: match[3],
		prerelease: match[4]?.split(".") ?? [],
		build: match[5]?.split(".") ?? [],
	};
}

/** Find strict SemVer values in one already-bounded line. */
export function findStrictSemvers(value: string): string[] {
	return [
		...value.matchAll(
			/(?:^|[^\p{L}\p{N}])v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=$|[^\p{L}\p{N}])/gu,
		),
	]
		.map((match) => match[1])
		.filter((candidate): candidate is string => candidate !== undefined && parseStrictSemver(candidate) !== null);
}
