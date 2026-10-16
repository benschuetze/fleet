// Tests create temp repos with plain `git`. Run from a Git hook, the process carries GIT_DIR and friends, and
// `git init` in a temp folder would then write into the real repository (16.10.2026: core.bare=true). So every
// test process starts without them.
for (const k of Object.keys(process.env))
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|PREFIX|COMMON_DIR|OBJECT_DIRECTORY)$/.test(k)) delete process.env[k];
