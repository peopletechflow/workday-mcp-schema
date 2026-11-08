const test = (n: string, f: () => void) => { f(); console.log(`ok - ${n}`); };
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("CI template: read-only token, SHA-pinned actions, checksum-verified gitleaks", () => {
  const y = readFileSync("docs/ci-workflow.example.yml", "utf8");
  assert.match(y, /^permissions:\n  contents: read$/m);
  for (const m of y.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1]!, /@[0-9a-f]{40}$/, m[1]);
  assert.match(y, /persist-credentials: false/);
  const dl = y.indexOf("curl"), sum = y.indexOf("sha256sum -c"), run = y.indexOf("./gitleaks");
  assert.ok(dl > 0 && dl < sum && sum < run, "download, then verify, then run");
  assert.match(y, /5bc41815076e6ed6ef8fbecc9d9b75bcae31f39029ceb55da08086315316e3ba  gl\.tgz/);
  assert.doesNotMatch(y, /secrets\./);
});
