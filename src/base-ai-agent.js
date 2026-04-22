const core = require("./core-wrapper");
const constants = require("./constants");

class SimpleMutex {
    constructor() {
        this._locked = false;
        this._waiting = [];
    }
    acquire(timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("Timeout while waiting for cache lock")), timeoutMs);
            const grant = () => {
                clearTimeout(timer);
                resolve();
            };
            if (!this._locked) {
                this._locked = true;
                grant();
            } else {
                this._waiting.push(grant);
            }
        });
    }
    release() {
        if (this._waiting.length) {
            const next = this._waiting.shift();
            next();
        } else {
            this._locked = false;
        }
    }
}

class BaseAIAgent {
    constructor(apiKey, fileContentGetter, fileCommentator, model, reviewRulesContent, codebaseSearcher) {
        this.apiKey = apiKey;
        this.fileContentGetter = fileContentGetter;
        this.fileCommentator = fileCommentator;
        this.model = model;
        this.reviewRulesContent = reviewRulesContent;
        this.codebaseSearcher = codebaseSearcher;
        this.fileCache = new Map();
        this.cacheMutex = new SimpleMutex();
        this.MAX_CACHE_ENTRIES = constants.MAX_CACHE_ENTRIES;
    }

    getSystemPrompt() {
        let prompt = `You are an expert code reviewer analyzing a GitHub pull request as part of an automated CI pipeline. You must work independently without human interaction. Review for logical errors, bugs, and security issues.

Focus on:
- Real bugs and logic errors (high priority)
- Security vulnerabilities (high priority)
- Typos

Skip and do not comment on (but you can mention these in the summary):
- Formatting and code style preferences (the lowest priority)
- Performance issues
- Code maintainability issues
- Best practices

For each issue found, use the get_file_content tool to retrieve additional context if needed, and the add_review_comment tool to add specific, actionable comments to the code.

The "changedFiles" object contains information about files that were modified in the PR, including:
- filename: The path to the changed file
- status: The change status (added, modified, etc.)
- patch: The diff showing what was changed
- additions: The number of added lines
- deletions: The number of deleted lines

You MUST use the get_file_content tool to examine files for a thorough review. Always examine the content you receive and make determinations based on that content.

CRITICAL - UNDERSTANDING WHAT TO REVIEW:

You MUST only comment on lines that were actually added or removed in this PR. Do NOT comment on context lines that are shown for reference only.

The patch field uses unified diff format. Each line has a prefix character that tells you what type of line it is:

SPACE PREFIX (line starts with a space): This is a CONTEXT LINE. It is unchanged code shown for reference only. DO NOT comment on these lines. They are NOT part of the changes and were already in the codebase before this PR.

PLUS PREFIX (line starts with +): This is an ADDITION. It is a new line added in this PR. You SHOULD review these lines. Use side: "RIGHT" when commenting.

MINUS PREFIX (line starts with -): This is a DELETION. It is a line removed in this PR. You SHOULD review these lines. Use side: "LEFT" when commenting.

DOUBLE AT PREFIX (line starts with @@): This is a HUNK HEADER. It shows line numbers in the format @@ -oldStart,oldLines +newStart,newLines @@. For example, @@ -10,5 +10,6 @@ means the old file had 5 lines starting at line 10, and the new file has 6 lines starting at line 10.

HOW TO DETERMINE LINE NUMBERS FOR COMMENTS:

Step 1: Identify an issue in a line with + or - prefix.
Step 2: Count line numbers starting from the hunk header. For additions (+ lines), count from the +newStart number. For deletions (- lines), count from the -oldStart number.
Step 3: Use add_review_comment with the correct line number and side.

MULTI-LINE COMMENTS:

When commenting on a range of lines, all lines in the range must have + or - prefixes (no context lines). The range must be contiguous in the diff. Use the side of the LAST line in the range.

COMMON MISTAKES TO AVOID:

MISTAKE 1: Commenting on context lines. Never comment on lines with space prefixes. They are just context shown for reference.

MISTAKE 2: Including context lines in your line range. When specifying start_line_number to end_line_number, ensure all lines in that range are actual changes (+ or - prefixes), not context lines.

MISTAKE 3: Commenting on pre-existing issues. If you see a bug in a context line (space prefix), it was already in the codebase before this PR. This PR did not introduce it, so it is out of scope for this review. Only comment on issues in lines with + or - prefixes.

GOLDEN RULE: Only use add_review_comment on lines with + or - prefixes. Never comment on lines with space prefixes (context lines). This ensures you are reviewing what changed in this PR, not the entire codebase.

When complete, call the mark_as_done tool with a brief summary of the review. The summary should ONLY include:
- A concise overview of what was changed in the code
- The overall quality assessment of the changes
- Any patterns or recurring issues observed
- DO NOT ask questions or request more information in the summary
- DO NOT mention "I couldn't see the changes" - use the tools to retrieve any content you need

SUMMARY REQUIREMENTS:

You MUST always provide a meaningful summary that describes what code was reviewed, even if you found no issues. A summary is required for every review.

DO NOT write summaries like these BAD EXAMPLES:
- "No review comments to add."
- "Proceeding to summary."
- "Code looks good."
- "No issues found."
- "No issues found that warrant inline comments on the changed lines."
- "I will now review the changes by examining the modified files..."
- Do NOT include "Actions taken:" sections listing which files you reviewed
- Do NOT include "Review comments added:" sections listing where you posted comments
- Do NOT structure your summary with separate labeled sections like "Summary:", "Overview:", "Quality:", "Patterns:"
- Do NOT use future tense ("I will review...") or describe the review process itself

INSTEAD write summaries like these GOOD EXAMPLES:
- "This PR adds input validation to the user registration endpoint in auth-service.js. The changes include email format checking, password strength requirements, and SQL injection prevention through parameterized queries. The implementation correctly handles edge cases such as empty strings and null values. No security vulnerabilities were identified in the modified code. Overall the changes improve the security posture of the authentication system."
- "This PR refactors the database connection pooling logic by extracting configuration into a separate module and replacing callback-based queries with async/await. The refactoring improves code readability and maintainability without changing functionality. Connection error handling is preserved correctly. All database operations maintain their original behavior and no race conditions were introduced."

Your summary should be a single cohesive paragraph (or a few short paragraphs) describing WHAT changed, WHY it matters, and the QUALITY of the changes. Write in past tense about the code changes, not about your review process.

Lines are 1-indexed. Do not comment on trivial issues or style preferences.
Be concise but thorough in your review.
=> MODE NO-FALSE-POSITIVES IS ON.`;

        if (this.codebaseSearcher) {
            prompt += `\n\nYou also have access to the grep_codebase tool, which lets you search across the ENTIRE codebase (not just files in the diff). Use this when you need to find callers of a changed function, check how a pattern is used elsewhere, look for related implementations, or verify definitions in other files. It supports extended regular expressions (e.g. \`functionName\\s*\\(\`, \`import.*module\`).

The grep_codebase tool returns results in the format \`path/to/file.js:42:  matching line content\`, one match per line. You can use the file path and line number from the results to call get_file_content for more context around a match.`;
        }

        if (this.reviewRulesContent) {
            prompt += `\n\nAdditionally, adhere to the following custom review rules:\n${this.reviewRulesContent}`;
        }

        return prompt;
    }


    /**
     * Formats previous AI comments into a message for the LLM.
     * Includes file path, comment body, and diff_hunk for context.
     *
     * @param {Array} comments - Filtered previous AI comments
     * @returns {string|null} Formatted message for LLM or null if no comments
     */
    formatPreviousCommentsMessage(comments) {
        if (!comments || comments.length === 0) {
            return null;
        }

        const formattedComments = comments.map((comment, index) => {
            const lineRange = comment.start_line && comment.start_line !== comment.end_line
                ? `lines ${comment.start_line}-${comment.end_line}`
                : `line ${comment.end_line}`;

            return `
=============================================================================

COMMENT #${index + 1}
File: ${comment.path} (${comment.side} side, ${lineRange})

Your previous comment:
"${comment.comment}"

Code context when you commented:
\`\`\`diff
${comment.diff_hunk}
\`\`\`
`.trim();
        }).join('\n\n');

        return `CRITICAL: DUPLICATE COMMENT PREVENTION

You have already made ${comments.length} review comment(s) on files in this review:

${formattedComments}

=============================================================================

DO NOT make duplicate comments.

A comment is a DUPLICATE if it discusses the SAME ISSUE on the SAME CODE, even if the wording is different.

Before making ANY comment, explicitly check: "Did I already comment on this specific issue in this file?"

Compare your draft comment against the previous comments above:
- Is it the same file?
- Is it the same code location? (compare diff_hunk context, not just line numbers)
- Is it the same problem? (same variable, same type of issue, same recommendation)

If YES to all three → DO NOT COMMENT (it's a duplicate, even if worded differently)
If NO to any → You may comment (it's a new issue)

Focus only on NEW issues not already covered by your previous comments.`;
    }

    handleError(error, message, throwError = true) {
        const fullMessage = `${message}: ${error.message}`;
        console.error(fullMessage);
        if (throwError) {
            throw new Error(fullMessage);
        }
    }

    async getFileContentWithCache(pathToFile, startLineNumber, endLineNumber) {
        if (!pathToFile || typeof pathToFile !== "string") {
            throw new Error("Invalid file path provided");
        }
        if (
            !Number.isInteger(startLineNumber) ||
            !Number.isInteger(endLineNumber) ||
            startLineNumber < 1 ||
            endLineNumber < 1 ||
            startLineNumber > endLineNumber
        ) {
            throw new Error("Invalid line numbers provided");
        }
        try {
            await this.cacheMutex.acquire();
            let content;
            try {
                const cacheKey = `${pathToFile}`;
                if (this.fileCache.has(cacheKey)) {
                    content = this.fileCache.get(cacheKey);
                } else {
                    core.info(`Fetching content for file: ${pathToFile}`);
                    content = await this.fileContentGetter(pathToFile);
                    if (typeof content !== "string") {
                        throw new Error(`Invalid content type received for ${pathToFile}`);
                    }
                    this.fileCache.set(cacheKey, content);
                    if (this.fileCache.size > this.MAX_CACHE_ENTRIES) {
                        const oldestKey = this.fileCache.keys().next().value;
                        this.fileCache.delete(oldestKey);
                    }
                }
            } finally {
                this.cacheMutex.release();
            }

            const span = Number.isInteger(constants.LINE_SPAN) && constants.LINE_SPAN >= 0 ? constants.LINE_SPAN : 3;
            const lines = content.split(/\r?\n/);
            const startIndex = Math.max(0, startLineNumber - 1 - span);
            const endIndex = Math.min(lines.length, endLineNumber + span);
            const selectedLines = lines.slice(startIndex, endIndex);
            const width = Math.max(4, String(lines.length).length);
            const numberedLines = selectedLines.map((line, index) => {
                const lineNumber = startIndex + index + 1;
                return `${lineNumber.toString().padStart(width, " ")}: ${line}`;
            });
            const escapedPath = pathToFile.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
            return `\`\`\`${escapedPath}\n${numberedLines.join("\n")}\n\`\`\``;
        } catch (error) {
            const errMsg = `Error getting file content for ${pathToFile}: ${error.message}`;
            core.error(errMsg);
            return `Error getting file content: ${error.message}`;
        }
    }

    validateLineNumbers(startLineNumber, endLineNumber) {
        if (!Number.isInteger(startLineNumber) || startLineNumber < 1) {
            return "Error: Start line number must be a positive integer";
        }
        if (!Number.isInteger(endLineNumber) || endLineNumber < 1) {
            return "Error: End line number must be a positive integer";
        }
        if (startLineNumber > endLineNumber) {
            return "Error: Start line number cannot be greater than end line number";
        }
        return null;
    }

    async addReviewComment(fileName, startLineNumber, endLineNumber, foundErrorDescription, side = "RIGHT") {
        const validationError = this.validateLineNumbers(startLineNumber, endLineNumber);
        if (validationError) {
            this.handleError(new Error(validationError), "Validation error", false);
            return validationError;
        }
        try {
            await this.fileCommentator(foundErrorDescription, fileName, side, startLineNumber, endLineNumber);
            return "Success! The review comment has been published.";
        } catch (error) {
            this.handleError(error, "Error creating review comment", false);
            return `Error! Please ensure that the lines you specify for the comment are part of the DIFF! Error message: ${error.message}`;
        }
    }

    async searchCodebase(pattern, fileGlob, caseSensitive) {
        if (!this.codebaseSearcher) {
            return "Error: codebase search is not available. The checkout_dir input was not set.";
        }
        try {
            return await this.codebaseSearcher(pattern, fileGlob, caseSensitive);
        } catch (error) {
            this.handleError(error, "Error searching codebase", false);
            return `Error searching codebase: ${error.message}`;
        }
    }

    doReview(_changedFiles) {
        throw new Error("Method 'doReview' must be implemented by subclass");
    }

    initialize() {
        throw new Error("Method 'initialize' must be implemented by subclass");
    }
}

module.exports = BaseAIAgent;
