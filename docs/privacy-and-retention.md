# Privacy and retention status

Seeded history uses synthetic calls. Browser demos capture real user test speech and can read selected Syncro customer/contact/ticket data. Do not send patient information, passwords or MFA codes. The redaction utility removes recognizable credential/patient markers and explicitly configured secret values, but cannot guarantee all sensitive text will be detected.

The conversation database stores seeded text and redacted finalized browser-call transcripts/events. PBX ingestion is not connected. Recording is disabled. Future event ingestion must redact before database storage, indexing, diagnostic logs and exports.

Company-approved transcript processing, provider terms, permitted retention periods, access policies and backup expiration remain prerequisites for a production pilot. Proposed periods in the specification are examples, not approved policy. Automated retention deletion is not implemented yet. UI pagination has no artificial cap on the number of retained calls; detail turns and events can be paged.

A future purge must expire content and corresponding backups while preserving approved minimal deletion audit metadata. Do not claim removal from external providers. Never include the master encryption key in a database backup or audit export.
