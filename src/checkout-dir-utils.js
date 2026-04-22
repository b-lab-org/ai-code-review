const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const core = require("./core-wrapper");
const {
    MAX_FILE_SIZE_BYTES,
    MAX_GREP_OUTPUT_BYTES,
    MAX_GREP_MATCHES_PER_FILE,
    GREP_TIMEOUT_MS,
    GREP_EXCLUDE_PATHS
} = require("./constants");

const execFileAsync = promisify(execFile);

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
/*                             Public API                                      */
/* -------------------------------------------------------------------------- */

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

/**
 * Reads a single file from the checkout directory with path traversal guard.
 * Returns file content as a UTF-8 string, or an error message string.
 */
function readLocalFile(checkoutDir, filePath) {
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

/**
 * Creates an async closure that reads file content from the local checkout
 * directory. Drop-in replacement for the GitHub API file content getter.
 */
function createLocalFileGetter(checkoutDir) {
    return (filePath) => readLocalFile(checkoutDir, filePath);
}

/**
 * Creates an async closure that searches the codebase using git grep.
 * Only works when checkoutDir is a git repository.
 */
function createCodebaseSearcher(checkoutDir) {
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
        args.push("--"); // separates pattern from pathspecs
        if (fileGlob) {
            args.push(fileGlob); // file glob filter (e.g. "*.js")
        }
        for (const p of GREP_EXCLUDE_PATHS) {
            args.push(`:(exclude)${p}`); // exclude paths defined in constants
        }

        try {
            const { stdout } = await execFileAsync("git", args, {
                cwd: checkoutDir,
                maxBuffer: MAX_GREP_OUTPUT_BYTES,
                timeout: GREP_TIMEOUT_MS,
            });

            // Strip ./ prefix from paths so they match diff format
            const cleaned = stdout.replace(/^\.\//gm, "");
            return cleaned || "No matches found.";
        } catch (error) {
            // git grep returns exit code 1 when no matches found
            if (error.code === 1) {
                return "No matches found.";
            }
            core.warning(`Git grep search failed: ${error.message}`);
            return `Search error: ${error.message}`;
        }
    };
}

module.exports = {
    validateCheckoutDir,
    readLocalFile,
    createLocalFileGetter,
    createCodebaseSearcher
};
