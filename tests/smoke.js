console.log("hello from mosnode");
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as cp from "node:child_process";
console.log("platform:", process.platform, os.type(), os.hostname());
const f = "/tmp/mosnode_test.txt";
fs.writeFileSync(f, "line1\nline2\n");
console.log("read back:", JSON.stringify(fs.readFileSync(f, "utf8")));
console.log("stat size:", fs.statSync(f).size);
console.log("readdir /tmp includes file:", fs.readdirSync("/tmp").includes("mosnode_test.txt"));
console.log("path join:", path.join("/a", "b", "c"));
console.log("execSync:", JSON.stringify(cp.execSync("echo hi from shell", { encoding: "utf8" }).trim()));
setTimeout(() => {
  console.log("timer fired");
  setImmediate(() => {
    console.log("immediate fired");
    process.exit(0);
  });
}, 50);
console.log("sync code done");
