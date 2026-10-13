# Upstream source and changes

The snapshot at `vendor/agentic-call-control` is from the official [3CX repository](https://github.com/3cx/agentic-call-control), commit `253f3d3c674042c998edf050e4e1b84eae55f1ea`. Its README declares MIT licensing; all original files, including attribution and Yarn lockfile, are preserved. The repository's `.git` administration directory was excluded from the source snapshot.

**Changed upstream files: none.** Source is vendored for reproducibility and is not part of the running admin service's npm workspace or Docker image. It is not yet a wired voice worker. The new `apps/voice-worker` directory documents the Phase 2 integration boundary.

Future adaptations must list modified paths here, preserve audio resampling and Call Control behaviour, replace plaintext YAML credential loading, remove unsafe raw transcript/error logging and add durable redacted event hooks. Upstream tool registration must be checked against the pinned implementation before adding scoped Syncro tools.
