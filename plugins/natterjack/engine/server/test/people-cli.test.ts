// people/cli.ts: errors without Python's warnings, and one more try when the network drops a read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cliError, runReading, transientFailure, withoutWarnings, type CliResult, type Runner } from "../src/people/cli.ts";

const AZ_WARNING = "D:\\a\\_work\\1\\s\\build_scripts\\windows\\artifacts\\cli\\Lib\\site-packages\\cryptography/hazmat/backends/openssl/backend.py:8: UserWarning: You are using cryptography on a 32-bit Python on a 64-bit Windows Operating System. Cryptography will be significantly faster if you switch to using a 64-bit Python.";
const RESET = "ERROR: ('Connection aborted.', ConnectionResetError(10054, 'An existing connection was forcibly closed by the remote host', None, 10054, None))";
const fail = (stderr: string): CliResult => ({ ok: false, code: 1, stdout: "", stderr });

test("withoutWarnings drops Python warnings and the source line under them", () => {
  assert.deepEqual(withoutWarnings(`${AZ_WARNING}\n${RESET}\n`), [RESET]);
  assert.deepEqual(withoutWarnings("/x/y.py:3: DeprecationWarning: old\n  import thing\nERROR: real"), ["ERROR: real"]);
  assert.deepEqual(withoutWarnings("ERROR: one\n  indented detail"), ["ERROR: one", "  indented detail"], "only the line under a warning is dropped");
});

test("cliError shows the error, not az's 32-bit Python warning", () => {
  const e = cliError("Listing Web Apps", fail(`${AZ_WARNING}\n${RESET}`));
  assert.equal(e.message, `Listing Web Apps: ${RESET}`);
  assert.equal(cliError("X", { ok: false, code: 3, stdout: "", stderr: AZ_WARNING }).message, "X: exit 3", "a warning alone isn't the error");
});

test("runReading tries a dropped connection once more; other failures and successes run once", async () => {
  const calls: string[] = [];
  const flaky = (answers: CliResult[]): Runner => async (name) => { calls.push(name); return answers.shift()!; };
  assert.equal((await runReading(flaky([fail(`${AZ_WARNING}\n${RESET}`), { ok: true, code: 0, stdout: "[]", stderr: "" }]), "az", [])).stdout, "[]");
  assert.equal(calls.length, 2);

  calls.length = 0;
  assert.equal((await runReading(flaky([fail(RESET), fail(RESET)]), "az", [])).ok, false, "twice is enough");
  assert.equal(calls.length, 2);

  calls.length = 0;
  await runReading(flaky([fail("ERROR: (AuthorizationFailed) no access")]), "az", []);
  assert.equal(calls.length, 1, "a real error isn't retried");
  assert.equal(transientFailure({ ok: true, code: 0, stdout: RESET, stderr: "" }), false);
});
