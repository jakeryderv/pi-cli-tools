# ADR-0005: Retrieve authoritative documentation through a pinned bounded HTTPS boundary

- Status: Accepted
- Date: 2026-08-22
- Deciders: Project maintainers

## Context

v0.3 needs detailed official documentation that local help cannot provide. A model-selected URL or ordinary general-purpose HTTP client would introduce SSRF, DNS rebinding, redirect, proxy, credential-forwarding, decompression, resource-exhaustion, cache-poisoning, and prompt-injection risks. Official sites frequently track latest documentation rather than an installed version, so HTTP success and page text cannot establish version alignment.

Startup, discovery, catalog search/enable, diagnostics, and unrelated local documentation must remain network-lazy. Retrieved text must remain bounded and must not become trusted merely because the registry labels its source authoritative.

## Decision

v0.3 will:

- Replace scalar official URLs with at most four strict source objects containing stable ID/title, fixed ASCII HTTPS URL, exact DNS-host allowlist, exact-or-descendant path boundary, expected textual media, optional topics, and explicit alignment policy. Process every accepted source in declaration order.
- Reject legacy scalar/HTTP/IP-literal/credential/query/fragment/wildcard/Unicode/trailing-dot/non-443 sources and unknown fields. User definitions with no official sources remain compatible. Invalid attributable overrides retain existing quarantine semantics.
- Expose only `operation: official` plus a printable 1-to-256-byte lexical query. The model cannot select URL, source, host, port, method, headers, body, credentials, proxy, redirects, TLS, version, cache, or limits.
- Perform no remote work except for that explicit operation. Query and version evidence are never sent remotely or interpolated into URLs.
- Use a small agent-independent transport instead of general-purpose fetch. For every hop it revalidates URL/host/segment-safe path, resolves A/AAAA once, rejects empty/oversized/malformed/mixed-special answers, and selects deterministically from vetted public addresses. A one-shot HTTPS agent dials the selected address, retains hostname SNI/certificate verification and TLS 1.2 minimum, and withholds its connection callback until peer verification succeeds. Only pre-response connect/TLS failures may try the second vetted address; response-policy/body failures do not.
- Deny maintained checked-in ranges for loopback, private, carrier-grade NAT, link-local/metadata, unspecified, documentation, benchmark, protocol-assignment, IPv4-compatible/mapped, NAT64, discard-only, AS112, 6to4, unique-local, multicast, and reserved space. Revalidate every manual redirect.
- Send only fixed unauthenticated `GET`, `Accept`, identity encoding, user-agent, and connection-close headers. Ignore proxy environment variables and global fetch dispatchers; send no auth, cookies, referrer, installed version, or query.
- Accept only complete bounded HTTP 200 HTML, Markdown, or plain text matching registry policy, with absent/UTF-8 charset and absent/identity encoding. Keep fixed DNS/connect/header/body/source/aggregate/redirect/header/body/text-byte/text-line/concurrency limits, counting failed response bodies against aggregate transfer. Do not decompress.
- Parse HTML with a bounded event parser, ignore script/style/template/head/metadata and embedded active elements, sanitize controls before caching, and perform deterministic bounded local lexical search over at most 10,000 lines with monotonic deadline checks and bounded top candidates. Do not render a browser, execute scripts, follow links, crawl, embed, or build an unbounded index.
- Store only complete successful sanitized documents in a separate clone-boundary, waiter-aware, session-memory LRU with 32 entries, 8 MiB, five-minute TTL, and eight flights. Cache identity includes complete definition/source/version policy. Failures and partial responses never cache. Shutdown aborts and awaits draining flights; reload starts fresh.
- Make the globally ranked selection authoritative for details and model text. Return at most eight 2 KiB/40-line snippets under 24 KiB/300 lines combined, and append only whole untrusted-data frames so generic tail selection cannot strip an opening label.
- Expose bounded provenance: configured/final URL and domain, redirects, cache state, retrieval time, media type, body/text SHA-256, snippet offsets/hashes, installed evidence, and alignment.
- Use installed-version evidence only for fixed exact/version-match source policy with strict SemVer `semver_first` parsing. Report factual `exact`, `major_match`, `major_minor_match`, `unversioned`, `unknown`, or `mismatch` states; treat prereleases and non-identical `0.x` versions conservatively, and never infer alignment from URL or page text.

## Consequences

### Positive

- The model cannot turn documentation lookup into general web access or SSRF.
- DNS rebinding and redirect scope are constrained by one-resolution-per-hop address pinning and repeated policy.
- Remote resource use, model context, cache memory, and concurrency are bounded.
- Cache and provenance remain session-local, deterministic, and auditable.
- Alignment claims are explicit and conservative.

### Negative

- Fixed entrypoints do not crawl linked manuals, so a source page must contain searchable material.
- Identity-only encoding rejects common compressed-only server behavior.
- Public authoritative sites can still serve malicious, stale, or compromised content.
- The checked-in special-purpose address policy requires review as IANA assignments change.
- Node's host trust configuration still affects certificate validation.
- A pre-response connect/TLS failure can make one additional request to a second already-vetted address; response-policy failures are not retried.

## Alternatives considered

### Use global `fetch()`

Automatic redirects, decompression, proxy/dispatcher integrations, and DNS connection behavior are harder to audit and pin to a prevalidated address.

### Permit model-selected URLs within an allowlisted domain

This still expands request authority, complicates cache identity, and can expose unreviewed endpoints or query behavior.

### Crawl and index official sites

Crawling increases request amplification, link-policy complexity, stale storage, and prompt-injection surface. v0.3 uses fixed documents and focused local search.

### Persist successful documents to disk

Persistence adds permissions, stale identity, parsing, poisoning, eviction, and cleanup concerns without current evidence that session memory is insufficient.

## Review triggers

Revisit this decision when:

- Authoritative sites require safe bounded compression or multiple fixed pages.
- IANA special-purpose allocations change.
- Node changes DNS, TLS, proxy, or HTTP connection behavior.
- Persistent caching has a justified threat model and lifecycle owner.
- Stronger semantic retrieval is required and can preserve deterministic security bounds.
