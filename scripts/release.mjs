#!/usr/bin/env node
/**
 * One command for a release: every check runs first, then bump, commit, tag,
 * build, tarball check, publish and verify, without asking again.
 *
 *   npm run release              # patch/minor/major from the commits since the last tag
 *   npm run release -- --minor   # force the bump
 *
 * A failed check prints the reason and the fix and exits before anything is
 * written: the working tree, the build and npm are untouched. Once the release
 * commit exists, a later failure prints the commands that undo it instead
 * (nothing is rolled back automatically).
 *
 * `docs/release.md` keeps the manual checklist and what follows the npm publish
 * (GitHub release notes); this script does not push anything.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
// A verified tarball is installed once; npm >= 11 skips these without the flag.
const INSTALL_SCRIPTS = "@stephenzhou01/pi-web,node-pty,@google/genai,protobufjs";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const help = flag("help") || args.includes("-h");
const dryRun = flag("dry-run");
const noPublish = flag("no-publish");
const skipChecks = flag("skip-checks");
const skipTests = skipChecks || flag("skip-tests");
const e2e = flag("e2e");
const anyBranch = flag("any-branch");
const forcedBump = ["major", "minor", "patch"].find(flag);

if (help) {
  console.log(`Usage: npm run release [options]

  --major | --minor | --patch  force the version bump
                               (default: from the commits since the last tag)
  --any-branch                 allow a branch other than main
  --skip-checks                skip lint, typecheck and unit tests
  --skip-tests                 skip the unit tests only
  --e2e                        also run the e2e suite (needs playwright's chromium)
  --dry-run                    checks only: print the version it would release
  --no-publish                 rehearse: stop after the tarball check, publish nothing
`);
  process.exit(0);
}

// ── output ──────────────────────────────────────────────────────────────────
let stepNumber = 0;
const step = (title) => console.log(`\n[${++stepNumber}] ${title}`);
const ok = (text) => console.log(`    ✓ ${text}`);
const note = (text) => console.log(`    · ${text}`);
const warn = (text) => console.log(`    ! ${text}`);

/** What has been written so far, so a later failure can say how to undo it. */
const state = { previousHead: null, version: null, tag: null, committed: false };

class ReleaseError extends Error {
  constructor(reason, fixes = [], detail = []) {
    super(reason);
    this.fixes = fixes;
    this.detail = detail;
  }
}

function fail(error) {
  const { message, fixes = [], detail = [] } = error instanceof ReleaseError
    ? error
    : new ReleaseError(String(error?.message ?? error));
  console.error(`\n✗ ${message}`);
  for (const line of detail) console.error(`    ${line}`);
  if (fixes.length > 0) {
    console.error("\n修复：");
    for (const line of fixes) console.error(`    ${line}`);
  }
  if (state.committed) {
    console.error("\n发布没有发生。撤销这次发布的提交与 tag：");
    console.error(`    git reset --hard ${state.previousHead}`);
    console.error(`    git tag -d ${state.tag}`);
  } else {
    console.error("\n仓库、构建和 npm 都没有被改动。");
  }
  process.exit(1);
}

// ── command helpers ─────────────────────────────────────────────────────────
function capture(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", cwd: repoRoot, ...options });
  if (result.error) throw new ReleaseError(`无法执行 ${command}：${result.error.message}`, ["确认命令在 PATH 中"]);
  return { status: result.status ?? 1, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function git(...gitArgs) {
  const result = capture("git", gitArgs);
  if (result.status !== 0) {
    throw new ReleaseError(`git ${gitArgs.join(" ")} 失败`, [], result.stderr.split("\n").slice(-3));
  }
  return result.stdout;
}

/** Runs a command with its output on screen; a non-zero status becomes a failure. */
function run(title, command, commandArgs) {
  console.log(`\n$ ${command} ${commandArgs.join(" ")}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit", cwd: repoRoot });
  if (result.error) throw new ReleaseError(`${title}：无法执行 ${command}（${result.error.message}）`);
  if (result.status !== 0) throw new ReleaseError(`${title}失败（退出码 ${result.status}）`);
}

function check(title, command, commandArgs) {
  step(title);
  run(title, command, commandArgs);
  ok(title);
}

// ── preflight ───────────────────────────────────────────────────────────────
function preflightRepository() {
  step("仓库与分支");
  const toplevel = capture("git", ["rev-parse", "--show-toplevel"]).stdout;
  if (resolve(toplevel) !== repoRoot) {
    throw new ReleaseError(`脚本不在仓库根目录运行（${repoRoot} ≠ ${toplevel}）`, ["从仓库根目录运行 npm run release"]);
  }
  const branch = git("symbolic-ref", "--short", "HEAD");
  if (branch !== "main" && !anyBranch) {
    throw new ReleaseError(`当前分支是 ${branch}，发布默认只从 main 出发`, [
      "切到 main 并合并你的改动，然后重跑",
      "或确实要从这个分支发布：npm run release -- --any-branch",
    ]);
  }
  const dirty = git("status", "--porcelain");
  if (dirty) {
    throw new ReleaseError("工作区不干净：发布出去的 tarball 必须对应一个提交", [
      "提交或 stash 上面的改动，然后重跑",
    ], dirty.split("\n").slice(0, 10));
  }
  ok(`${branch}，工作区干净`);
  state.previousHead = git("rev-parse", "HEAD");
}

function preflightDevServer() {
  step("没有正在使用本仓库 .next 的开发服务");
  if (existsSync(join(repoRoot, ".next", "dev", "lock"))) {
    throw new ReleaseError("本仓库的 dev server 正在运行（.next/dev/lock 存在）", [
      "停掉它（lsof -nP -iTCP:30141 -sTCP:LISTEN 找到进程），然后重跑",
      "若它是崩溃后留下的锁：rm -rf .next",
      "另一个目录里 npm 全局安装的 pi-web 不占用这里，可以继续运行",
    ]);
  }
  ok("没有 dev server 占用 .next");
}

function preflightRegistry() {
  step("npm 配置");
  const registry = capture(NPM, ["config", "get", "registry"]).stdout;
  if (registry.replace(/\/+$/, "") !== REGISTRY.replace(/\/+$/, "")) {
    throw new ReleaseError(`npm registry 指向 ${registry}，不是官方源`, [
      `npm config set registry ${REGISTRY}`,
    ]);
  }
  ok(`registry ${REGISTRY}`);
}

function preflightLogin() {
  step("npm 登录");
  const whoami = capture(NPM, ["whoami"]);
  if (whoami.status !== 0) {
    const fixes = [
      "npm login   # 浏览器授权，之后重跑",
      "或写入 Automation token：npm config set //registry.npmjs.org/:_authToken=<token>",
    ];
    if (dryRun || noPublish) {
      warn("未登录（npm whoami 返回 401）——本次不发布，继续");
      return;
    }
    throw new ReleaseError("npm 未登录（whoami 返回 401）", fixes);
  }
  ok(`已登录：${whoami.stdout}`);
}

function packageField() {
  const raw = readFileSync(join(repoRoot, "package.json"), "utf8");
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (error) {
    throw new ReleaseError(`package.json 解析失败：${error.message}`);
  }
  if (!pkg.name) throw new ReleaseError("package.json 缺少 name");
  if (pkg.private === true) throw new ReleaseError("package.json 的 private 为 true，不能发布", ["去掉 private 后重跑"]);
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version ?? "")) {
    throw new ReleaseError(`package.json 的 version（${pkg.version}）不是 x.y.z`, ["npm version <x.y.z> --no-git-tag-version"]);
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes(".next")) {
    throw new ReleaseError("package.json 的 files 没有包含 .next：发出去的包里不会有构建产物");
  }
  return pkg;
}

/** major/minor/patch from the conventional commits since the last tag. */
function bumpFromCommits() {
  const tag = capture("git", ["describe", "--tags", "--abbrev=0"]).stdout;
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const log = capture("git", ["log", "--format=%B%x1e", range]).stdout;
  const commits = log.split("\x1e").map((entry) => entry.trim()).filter(Boolean);
  if (commits.length === 0) {
    throw new ReleaseError(`${tag} 之后没有提交，没有可发布的内容`);
  }
  let bump = "patch";
  for (const commit of commits) {
    const subject = commit.split("\n")[0];
    if (/^\w+(\([^)]*\))?!:/.test(subject) || /(^|\n)BREAKING[ -]CHANGE:/.test(commit)) {
      return { bump: "major", since: tag, commits: commits.length };
    }
    if (/^feat(\([^)]*\))?!?:/.test(subject)) bump = "minor";
  }
  return { bump, since: tag, commits: commits.length };
}

function nextVersion(current, bump) {
  const [major, minor, patch] = current.split(".").map(Number);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function preflightVersion(pkg) {
  step("下一版版本号");
  const { bump, since, commits } = forcedBump
    ? { bump: forcedBump, since: capture("git", ["describe", "--tags", "--abbrev=0"]).stdout, commits: null }
    : bumpFromCommits();
  state.version = nextVersion(pkg.version, bump);
  state.tag = `v${state.version}`;
  note(`${pkg.version} → ${state.version}（${bump}，${commits === null ? "手动指定" : `${commits} 个提交，自 ${since}`}）`);

  const published = capture(NPM, ["view", `${pkg.name}@${state.version}`, "version", "--registry", REGISTRY]);
  if (published.status === 0) {
    throw new ReleaseError(`${pkg.name}@${state.version} 已经发布过，已发布的版本不能覆盖`, [
      "换一个版本：npm run release -- --minor（或 --patch）",
    ]);
  }
  if (!/E404|404 Not Found|version not found/i.test(`${published.stderr}\n${published.stdout}`)) {
    throw new ReleaseError(`无法确认 ${state.version} 是否可用`, ["确认网络能访问 registry，然后重跑"], [
      published.stderr.split("\n").slice(-2).join(" "),
    ]);
  }
  ok(`npm 上没有 ${state.version}`);

  const localTag = capture("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${state.tag}`]);
  if (localTag.status === 0) {
    throw new ReleaseError(`本地已存在 tag ${state.tag}`, [`git tag -d ${state.tag}   # 确认它不属于别的提交`]);
  }
  const remoteTag = capture("git", ["ls-remote", "--tags", "origin", state.tag]);
  if (remoteTag.status === 0 && remoteTag.stdout) {
    throw new ReleaseError(`origin 上已存在 tag ${state.tag}`);
  }
  ok(`tag ${state.tag} 可用`);
}

// ── checks ──────────────────────────────────────────────────────────────────
function runChecks() {
  if (skipChecks) {
    step("静态检查与测试");
    warn("已按要求跳过（--skip-checks）");
    return;
  }
  check("lint", NPM, ["run", "lint"]);
  step("类型检查");
  run("类型检查", "npx", ["tsc", "--noEmit"]);
  ok("tsc --noEmit");
  if (skipTests) {
    step("单元测试");
    warn("已按要求跳过（--skip-tests）");
  } else {
    step("单元测试");
    try {
      run("单元测试", NPM, ["test"]);
    } catch (error) {
      throw new ReleaseError("单元测试没有全部通过", [
        "先修好失败的用例，再重跑",
        "确实要带着失败发布：npm run release -- --skip-tests",
      ], error.message ? [error.message] : []);
    }
    ok("npm test");
  }
  if (e2e) check("e2e", NPM, ["run", "test:e2e"]);
}

// ── release ─────────────────────────────────────────────────────────────────
function bumpCommitTag() {
  step(`写入 ${state.version}：bump、提交、tag`);
  capture(NPM, ["version", state.version, "--no-git-tag-version"]);
  ok("package.json / package-lock.json");

  git("add", "package.json", "package-lock.json");
  git("commit", "-m", `Release v${state.version}`);
  state.committed = true;
  ok(`提交 Release v${state.version}`);

  git("tag", "-a", state.tag, "-m", state.tag);
  ok(`tag ${state.tag}`);
}

function build() {
  step("构建生产产物");
  // A fresh .next: a previous `next start`/e2e leaves .next/server/route-cache
  // behind, which the build keeps and the package would ship.
  rmSync(join(repoRoot, ".next"), { recursive: true, force: true });
  run("构建", NPM, ["run", "build"]);
  for (const stale of ["dev", "cache", "server/route-cache"]) {
    if (existsSync(join(repoRoot, ".next", stale))) {
      throw new ReleaseError(`构建产物里出现了 .next/${stale}，它不该进包`, [
        `rm -rf .next/${stale} 后重跑，或检查是哪个服务写了它`,
      ]);
    }
  }
  if (!existsSync(join(repoRoot, ".next", "BUILD_ID"))) {
    throw new ReleaseError("构建没有产出 .next/BUILD_ID", ["检查 npm run build 的输出"]);
  }
  ok("构建完成，产物里没有 dev/cache/route-cache");
}

function checkTarball(pkg) {
  step("检查要发布的 tarball");
  const packed = capture(NPM, ["pack", "--dry-run", "--json"]);
  if (packed.status !== 0) {
    throw new ReleaseError("npm pack --dry-run 失败", [], packed.stderr.split("\n").slice(-3));
  }
  let files = [];
  try {
    files = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
  } catch {
    throw new ReleaseError("无法解析 npm pack --dry-run --json 的输出", [], [packed.stdout.slice(0, 200)]);
  }
  const forbidden = files.filter((path) => (
    path.startsWith(".next/dev/")
    || path.startsWith(".next/cache/")
    || path.startsWith(".next/server/route-cache/")
    || path.endsWith(".js.map")
    || /(^|\/)\.env/.test(path)
    || path.startsWith("demo/")
    || path.startsWith("e2e/")
    || path.startsWith("docs/")
  ));
  if (forbidden.length > 0) {
    throw new ReleaseError("tarball 里有不该发布的文件", ["检查 package.json 的 files 白名单"], forbidden.slice(0, 8));
  }
  for (const required of ["package.json", "bin/pi-web.js", ".next/BUILD_ID"]) {
    if (!files.includes(required)) {
      throw new ReleaseError(`tarball 里没有 ${required}`, ["检查 package.json 的 files 白名单"]);
    }
  }
  const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  if (version !== state.version) {
    throw new ReleaseError(`package.json 是 ${version}，不是 ${state.version}`);
  }
  ok(`${files.length} 个文件，含 ${pkg.name}@${state.version} 与 .next 构建产物`);
}

function publish(pkg) {
  step("发布到 npm");
  note("若账号开了 2FA，这里会要一次性验证码，直接在终端输入即可");
  run("npm publish", NPM, ["publish", "--access", "public"]);
  ok(`npm publish ${pkg.name}@${state.version}`);
}

async function registryInfo(name, version) {
  const encoded = name.replace("/", "%2F");
  const response = await fetch(`${REGISTRY}${encoded}/${version}`);
  return { status: response.status };
}

async function distTag(name) {
  const encoded = name.replace("/", "%2F");
  const response = await fetch(`${REGISTRY}-/package/${encoded}/dist-tags`);
  if (!response.ok) return null;
  return response.json();
}

async function verifyPublished(pkg) {
  step("等待 registry 出现新版本");
  const deadline = Date.now() + 5 * 60 * 1000;
  let last = null;
  for (;;) {
    last = await registryInfo(pkg.name, state.version).catch(() => ({ status: 0 }));
    note(`${new Date().toLocaleTimeString()} ${state.version} → ${last.status}`);
    if (last.status === 200) break;
    if (Date.now() > deadline) {
      throw new ReleaseError(`5 分钟内 registry 仍返回 ${last.status}，发布可能还在传播或审核中`, [
        "不要重发同一个版本；过几分钟再看：npm view <name>@<version> version",
        "新包名会先进入审核，页面显示 0.0.0-stage 占位版",
      ]);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
  }
  ok("registry 返回 200");

  const tags = await distTag(pkg.name);
  if (tags?.latest !== state.version) {
    throw new ReleaseError(`dist-tags.latest 是 ${tags?.latest}，不是 ${state.version}`, [
      "等传播完成再看：npm view <name> dist-tags",
    ]);
  }
  ok(`latest → ${state.version}`);
}

function verifyInstall(pkg) {
  step("装一次真包并启动版本号");
  const prefix = mkdtempSync(join(tmpdir(), "pi-web-release-"));
  try {
    const npmMajor = Number(capture(NPM, ["--version"]).stdout.split(".")[0]);
    const installArgs = ["install", "--global", "--prefix", prefix];
    if (npmMajor >= 11) installArgs.push(`--allow-scripts=${INSTALL_SCRIPTS}`);
    installArgs.push(`${pkg.name}@${state.version}`);
    const installed = capture(NPM, installArgs);
    if (installed.status !== 0) {
      throw new ReleaseError("从 registry 安装这个版本失败", ["确认 tarball 内容完整"], installed.stderr.split("\n").slice(-3));
    }
    const bin = join(prefix, "bin", pkg.bin ? Object.keys(pkg.bin)[0] : "pi-web");
    const printed = capture(bin, ["version"]);
    if (printed.status !== 0 || !printed.stdout.includes(state.version)) {
      throw new ReleaseError(`安装后的 ${bin} version 输出「${printed.stdout || printed.stderr}」`, ["确认 bin 与 version 输出"]);
    }
    ok(`全局安装后 ${bin} version → ${printed.stdout.split("\n").pop()}`);
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Pi Web release · ${repoRoot}`);
  preflightRepository();
  preflightDevServer();
  preflightRegistry();
  const pkg = packageField();
  preflightLogin();
  preflightVersion(pkg);

  if (dryRun) {
    step("演练结束（--dry-run）");
    note(`会发布 ${pkg.name}@${state.version}，tag ${state.tag}`);
    note("没有改动任何文件、没有构建、没有发布");
    return;
  }

  runChecks();
  bumpCommitTag();
  build();
  checkTarball(pkg);

  if (noPublish) {
    step("已停在发布之前（--no-publish）");
    note(`提交与 tag 已就绪：${state.tag}`);
    note(`发布：${NPM} publish --access public`);
    note("不想要它们：按上面打印的 git reset / git tag -d 撤销");
    return;
  }

  publish(pkg);
  await verifyPublished(pkg);
  verifyInstall(pkg);

  const branch = git("symbolic-ref", "--short", "HEAD");
  step("完成");
  ok(`${pkg.name}@${state.version} 已发布，latest 指向它`);
  note(`推送提交与 tag：git push origin ${branch} ${state.tag}`);
  note("GitHub Release 与发布说明：docs/release.md 第 5–6 步");
  note(`用时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

const startedAt = Date.now();
main().catch((error) => fail(error));
