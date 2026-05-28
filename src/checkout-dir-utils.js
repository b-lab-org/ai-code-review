const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const spawn = require("nano-spawn").default;

const core = require("./core-wrapper");
const {
    MAX_FILE_SIZE_BYTES,
    MAX_GREP_MATCHES_PER_FILE,
    GIT_TIMEOUT_MS,
    GREP_EXCLUDE_PATHS
} = require("./constants");
const { parseDiffFileSection } = require("./patch-utils");

/* -------------------------------------------------------------------------- */
/*                             Path safety                                     */
/* -------------------------------------------------------------------------- */

/**
 * Resolves a file path against the checkout directory and ensures it does not
 * escape outside of it (path traversal guard).
 * Returns the resolved absolute path, or null if the path is outside.
 */
function safePath(checkoutDir, filePath) {
    const resolved = path.resolve(checkoutDir, filePath);
    if (resolved !== checkoutDir && !resolved.startsWith(checkoutDir + path.sep)) {
        return null;
    }
    return resolved;
}

/* -------------------------------------------------------------------------- */
/*                             Helpers                                         */
/* -------------------------------------------------------------------------- */

/** Returns undefined for WORKING_TREE (triggers filesystem read), or the ref as-is */
function _effectiveRef(headCommit) {
    return headCommit === "WORKING_TREE" ? undefined : headCommit;
}

/** Runs a git command and returns stdout */
async function _execGit(cwd, args, options = {}) {
    const result = await spawn("git", args, {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        ...options,
    });
    return result.stdout;
}

/**
 * Validates that the given directory path exists and is a directory.
 * Returns the resolved absolute path.
 */
function validateCheckoutDir(dirPath) {
    const resolved = path.resolve(dirPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`checkout_dir "${dirPath}" does not exist or is not a directory.`);
    }
    return resolved;
}

/* -------------------------------------------------------------------------- */
/*                         File reading (ref-aware)                            */
/* -------------------------------------------------------------------------- */

/**
 * Reads a single file from the checkout directory.
 * When ref is provided, reads from git at that commit via `git show`.
 * When ref is not provided, reads from the filesystem (working tree).
 * Returns file content as a UTF-8 string, or an error/info message string.
 */
function readLocalFile(checkoutDir, filePath, ref) {
    if (ref) {
        return _readFileFromGit(checkoutDir, filePath, ref);
    }
    return _readFileFromDisk(checkoutDir, filePath);
}

function _readFileFromGit(checkoutDir, filePath, ref) {
    try {
        const buf = execFileSync("git", ["show", `${ref}:${filePath}`], {
            cwd: checkoutDir,
            maxBuffer: MAX_FILE_SIZE_BYTES + 1024,
        });

        if (buf.length > MAX_FILE_SIZE_BYTES) {
            return `[File too large (${Math.round(buf.length / 1024)}KB) - skipped for review]`;
        }

        // Binary detection: check for null bytes in first 8KB
        const sample = buf.slice(0, Math.min(8192, buf.length));
        if (sample.includes(0)) {
            return "[Binary file not shown in review]";
        }

        return buf.toString("utf-8");
    } catch (error) {
        return `[Error reading file: ${error.message}]`;
    }
}

function _readFileFromDisk(checkoutDir, filePath) {
    const fullPath = safePath(checkoutDir, filePath);
    if (!fullPath) {
        return `[Access denied: path "${filePath}" is outside checkout directory]`;
    }

    try {
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            const entries = fs.readdirSync(fullPath);
            return `[Directory content: ${entries.join(", ")}]`;
        }

        if (stat.size > MAX_FILE_SIZE_BYTES) {
            return `[File too large (${Math.round(stat.size / 1024)}KB) - skipped for review]`;
        }

        // Binary detection: check for null bytes in first 8KB
        const sample = Buffer.alloc(Math.min(8192, stat.size));
        const fd = fs.openSync(fullPath, "r");
        try {
            fs.readSync(fd, sample, 0, sample.length, 0);
        } finally {
            fs.closeSync(fd);
        }
        if (sample.includes(0)) {
            return "[Binary file not shown in review]";
        }

        return fs.readFileSync(fullPath, "utf-8");
    } catch (error) {
        return `[Error reading file: ${error.message}]`;
    }
}

/* -------------------------------------------------------------------------- */
/*                         Codebase grep (ref-aware)                           */
/* -------------------------------------------------------------------------- */

/**
 * Creates an async closure that searches the codebase using git grep.
 * When ref is provided, searches at that specific commit.
 * When ref is not provided, searches the working tree.
 */
function buildCodebaseSearcher(checkoutDir, ref) {
    return async (pattern, fileGlob, caseSensitive) => {
        if (!pattern || typeof pattern !== "string") {
            return "Error: search pattern is required";
        }

        const args = [
            "grep", // git subcommand
            "-n", // show line numbers in output
            "-E", // extended regex (supports \s, +, |, () without escaping)
            "--max-count", String(MAX_GREP_MATCHES_PER_FILE), // stop after N matches per file
        ];

        if (!caseSensitive) {
            args.push("-i"); // case-insensitive matching
        }

        args.push("--"); // end of flags, prevents pattern being interpreted as a flag
        args.push(pattern); // search pattern

        if (ref) {
            args.push(ref); // search at specific commit
        }

        args.push("--"); // separates pattern from pathspecs
        if (fileGlob) {
            args.push(fileGlob); // file glob filter (e.g. "*.js")
        }
        for (const p of GREP_EXCLUDE_PATHS) {
            args.push(`:(exclude)${p}`); // exclude paths defined in constants
        }

        try {
            const stdout = await _execGit(checkoutDir, args);

            // When searching at a ref, git grep prefixes output with "ref:path"
            const cleaned = ref
                ? stdout.replace(new RegExp(`^(\\./|${ref}:)`, "gm"), "")
                : stdout.replace(/^\.\//gm, "");
            return cleaned || "No matches found.";
        } catch (error) {
            // git grep returns exit code 1 when no matches found
            if (error.exitCode === 1) {
                return "No matches found.";
            }
            core.warning(`Git grep search failed: ${error.message}`);
            return `Search error: ${error.message}`;
        }
    };
}

/* -------------------------------------------------------------------------- */
/*                         LocalGitAPI                                         */
/* -------------------------------------------------------------------------- */

class LocalGitAPI {
    constructor(repoPath, baseRef, headRef) {
        this.repoPath = repoPath;
        this.baseRef = baseRef;
        this.headRef = headRef;
        this.isWorkingTree = headRef === "WORKING_TREE";
    }

    _diffRefs(base, head) {
        if (this.isWorkingTree) {
            return [base];
        }
        return [base, head];
    }

    async getPullRequest(_owner, _repo, _prNumber) {
        const headSha = this.isWorkingTree
            ? "WORKING_TREE"
            : (await _execGit(this.repoPath, ["rev-parse", "HEAD"])).trim();
        const resolvedBase = await this._resolveRef(this.baseRef);
        const baseSha = (await _execGit(this.repoPath, ["merge-base", resolvedBase, "HEAD"])).trim();
        core.info(`[LOCAL] getPullRequest() → base: ${baseSha}, head: ${headSha}`);
        return {
            head: { sha: headSha },
            base: { sha: baseSha },
        };
    }

    async _resolveRef(ref) {
        try {
            await _execGit(this.repoPath, ["rev-parse", "--verify", ref]);
            return ref;
        } catch {
            const remoteRef = `origin/${ref}`;
            core.info(`[LOCAL] Ref "${ref}" not found locally, trying "${remoteRef}"`);
            await _execGit(this.repoPath, ["rev-parse", "--verify", remoteRef]);
            return remoteRef;
        }
    }

    async compareCommits(_owner, _repo, base, head) {
        const files = await this.getFilesBetweenCommits(_owner, _repo, base, head);
        return { files };
    }

    getContent(_owner, _repo, _baseRef, actualRef, filePath) {
        core.info(`[LOCAL] getContent(${actualRef}, ${filePath})`);
        const ref = _effectiveRef(actualRef);
        return readLocalFile(this.repoPath, filePath, ref);
    }

    createPRComment(_owner, _repo, _prNumber, body) {
        core.info(`[LOCAL] PR Comment:\n${body}`);
    }

    createReviewComment(_owner, _repo, _prNumber, _commitId, body, filePath, side, startLine, line) {
        const range = startLine === line ? `line ${startLine}` : `lines ${startLine}-${line}`;
        core.info(`[LOCAL] Review Comment on ${filePath} (${side}, ${range}):\n${body}`);
    }

    listPRComments(_owner, _repo, _prNumber) {
        return [];
    }

    listPRReviewComments(_owner, _repo, _prNumber) {
        return [];
    }

    async listPRCommits(_owner, _repo, _prNumber) {
        const baseSha = (await _execGit(this.repoPath, ["merge-base", this.baseRef, "HEAD"])).trim();
        const log = await _execGit(this.repoPath, ["log", "--format=%H", `${baseSha}..HEAD`]);
        return log.trim().split("\n").filter(Boolean).map(sha => ({ sha }));
    }

    async getFilesBetweenCommits(_owner, _repo, baseCommit, headCommit) {
        core.info(`[LOCAL] getFilesBetweenCommits(${baseCommit}, ${headCommit})`);
        const refs = this._diffRefs(baseCommit, headCommit);
        const files = await _streamDiff(this.repoPath, refs);
        core.info(`[LOCAL] Found ${files.length} changed files`);
        return files;
    }
}

/**
 * Spawns a single `git diff` process, splits output into per-file sections,
 * and delegates parsing to parseDiffFileSection for GitHub-compatible objects.
 */
async function _streamDiff(cwd, refs) {
    const proc = spawn("git", ["diff", "--no-ext-diff", "--no-color", ...refs], { cwd });

    const files = [];
    let currentSection = "";

    for await (const line of proc) {
        if (line.startsWith("diff --git ")) {
            if (currentSection) {
                const parsed = parseDiffFileSection(currentSection);
                if (parsed) {
                    files.push(parsed);
                }
            }
            currentSection = line;
        } else if (currentSection) {
            currentSection += "\n" + line;
        }
    }

    if (currentSection) {
        const parsed = parseDiffFileSection(currentSection);
        if (parsed) {
            files.push(parsed);
        }
    }

    return files;
}

/* -------------------------------------------------------------------------- */
/*                         LocalContext                                         */
/* -------------------------------------------------------------------------- */

class LocalContext {
    constructor(checkoutDir) {
        this._fullLocalMode = process.env.AI_REVIEW_LOCAL === "true" && !!checkoutDir;

        if (this._fullLocalMode) {
            this._checkoutDir = validateCheckoutDir(checkoutDir);
            this._baseRef = process.env.AI_REVIEW_LOCAL_BASE_REF || "main";
            const headRefEnv = (process.env.AI_REVIEW_LOCAL_HEAD_REF || "HEAD").toUpperCase();
            this._isWorkingTree = headRefEnv === "WORKING_TREE";
        } else if (checkoutDir) {
            this._checkoutDir = validateCheckoutDir(checkoutDir);
            this._isWorkingTree = false;
        }
    }

    get isFullLocalMode() { return this._fullLocalMode; }

    get hasLocalAccess() { return !!this._checkoutDir; }

    get checkoutDir() { return this._checkoutDir; }

    createGitHubAPI() {
        return new LocalGitAPI(
            this._checkoutDir,
            this._baseRef,
            this._isWorkingTree ? "WORKING_TREE" : "HEAD"
        );
    }

    createFileGetter(headCommit) {
        const ref = _effectiveRef(headCommit);
        return (filePath) => readLocalFile(this._checkoutDir, filePath, ref);
    }

    createCodebaseSearcher(headCommit) {
        const ref = _effectiveRef(headCommit);
        return buildCodebaseSearcher(this._checkoutDir, ref);
    }

    readFile(filePath, headCommit) {
        const ref = _effectiveRef(headCommit);
        return readLocalFile(this._checkoutDir, filePath, ref);
    }
}

module.exports = { LocalContext };
