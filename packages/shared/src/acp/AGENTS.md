# Shared ACP boundaries

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
Ancestor shared contracts apply.

- Untagged ACP form fields remain independent: preserve original keys, restore
  JSON booleans, and validate required fields and enum answers. Decline unsupported
  types/constraints. Invalid or future Core metadata cannot use the standard
  fallback. Core note/custom-answer associations retain their existing semantics.
  Contract: [OMP ACP](../../../../specs/omp-native-acp.md).
