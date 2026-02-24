const parseDiff = require("parse-diff");
const core = require("./core-wrapper");

/**
 * Parses a patch string and returns the hunks array.
 * Returns an empty array if the patch is invalid or has no hunks.
 *
 * @param {string} patch - The patch string to parse
 * @returns {Array<import('parse-diff').Chunk>} - Array of hunks, or empty array if none
 */
function getHunksFromPatch(patch) {
    if (!patch) {
        return [];
    }

    try {
        const files = parseDiff(patch);

        if (files.length > 1) {
            core.warning(`getHunksFromPatch: Expected single-file patch but got ${files.length} files. Using only the first file.`);
        }

        if (files[0] && files[0].chunks && files[0].chunks.length > 0) {
            return files[0].chunks;
        }
        return [];
    } catch (error) {
        core.error(`getHunksFromPatch: Error parsing patch: ${error.message}`);
        return [];
    }
}

/**
 * Checks if two hunks overlap based on line ranges in the new file.
 *
 * @param {import('parse-diff').Chunk} hunk1 - First hunk (from parse-diff)
 * @param {import('parse-diff').Chunk} hunk2 - Second hunk (from parse-diff)
 * @returns {boolean} True if hunks overlap
 */
function hunksOverlap(hunk1, hunk2) {
    // parse-diff provides: oldStart, oldLines, newStart, newLines
    const h1Start = hunk1.newStart;
    const h1End = hunk1.newStart + hunk1.newLines - 1;
    const h2Start = hunk2.newStart;
    const h2End = hunk2.newStart + hunk2.newLines - 1;

    // Overlaps if: h1Start <= h2End AND h2Start <= h1End
    //
    // Visual examples:
    //
    // OVERLAP (partial):        OVERLAP (h1 contains h2):
    //   h1: [====]                 h1: [==========]
    //   h2:    [====]              h2:    [====]
    //
    // OVERLAP (h2 contains h1):  NO OVERLAP (h1 before h2):
    //   h1:    [====]              h1: [====]
    //   h2: [==========]           h2:          [====]
    //
    // The condition catches all overlap cases and excludes non-overlapping ranges.
    const overlaps = h1Start <= h2End && h2Start <= h1End;

    if (overlaps) {
        core.debug(`hunksOverlap: Hunks overlap - [${h1Start}-${h1End}] overlaps with [${h2Start}-${h2End}]`);
    }

    return overlaps;
}

/**
 * Reconstructs a patch string from filtered hunks.
 *
 * @param {Array<import('parse-diff').Chunk>} hunks - Array of hunk objects from parse-diff
 * @returns {string} Reconstructed patch string
 */
function reconstructPatch(hunks) {
    return hunks
        .map((hunk) => {
            // Reconstruct hunk header
            const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;

            // Hunk changes include type and content, we need just the content
            const lines = hunk.changes.map((change) => change.content);

            return [header, ...lines].join("\n");
        })
        .join("\n");
}

/**
 * Filters hunks from incrementalPatch to only include those that overlap
 * with hunks in wholePRPatch.
 *
 * This is used during incremental reviews to exclude hunks that came from
 * merge commits (syncing target branch into PR branch).
 *
 * @param {string} incrementalPatch - Patch from incremental diff
 * @param {string} wholePRPatch - Patch from whole PR diff
 * @returns {string|null} Filtered patch string or null if no relevant hunks
 */
function filterPatchHunks(incrementalPatch, wholePRPatch) {
    if (!incrementalPatch) {
        core.debug("filterPatchHunks: incrementalPatch is empty, returning null");
        return null;
    }

    // Parse both patches using parse-diff
    const incrementalHunks = getHunksFromPatch(incrementalPatch);
    const wholePRHunks = getHunksFromPatch(wholePRPatch);

    core.debug(`filterPatchHunks: Parsed ${incrementalHunks.length} incremental hunks, ${wholePRHunks.length} whole PR hunks`);

    // Handle edge cases
    if (incrementalHunks.length === 0) {
        core.debug("filterPatchHunks: No hunks in incremental patch, returning as-is");
        return incrementalPatch; // No hunks to filter
    }

    if (wholePRHunks.length === 0) {
        core.debug("filterPatchHunks: No hunks in whole PR patch, file is merge-only");
        return null; // File is merge-only (not in whole PR)
    }

    core.debug(`filterPatchHunks: Comparing ${incrementalHunks.length} incremental hunks against ${wholePRHunks.length} whole PR hunks`);

    // Filter: keep incremental hunks that overlap with any whole PR hunk
    const filteredHunks = incrementalHunks.filter((incHunk) => {
        const hasOverlap = wholePRHunks.some((prHunk) => hunksOverlap(incHunk, prHunk));
        if (!hasOverlap) {
            core.debug(`filterPatchHunks: Hunk at lines ${incHunk.newStart}-${incHunk.newStart + incHunk.newLines - 1} has no overlap, filtering out`);
        }
        return hasOverlap;
    });

    core.debug(`filterPatchHunks: Filtered ${incrementalHunks.length} hunks to ${filteredHunks.length} hunks`);

    if (filteredHunks.length === 0) {
        core.debug("filterPatchHunks: All hunks filtered out, returning null");
        return null; // All hunks are merge-only
    }

    // Reconstruct patch from filtered hunks
    const reconstructed = reconstructPatch(filteredHunks);
    core.debug(`filterPatchHunks: Reconstructed patch with ${filteredHunks.length} hunks`);
    return reconstructed;
}

/**
 * Extracts only the relevant lines from a diff hunk based on the comment's line range.
 * This helps the LLM compare comments more accurately by showing only the code that was commented on.
 *
 * @param {string} diffHunk - The full diff hunk from GitHub API
 * @param {number} startLine - The starting line of the comment (required)
 * @param {number} endLine - The ending line of the comment (required)
 * @param {("LEFT"|"RIGHT")} side - Which side of the diff (LEFT for deletions, RIGHT for additions)
 * @returns {string|null} - Trimmed diff hunk containing only relevant lines, or null if parsing fails
 */
function extractRelevantDiffHunk(diffHunk, startLine, endLine, side = "RIGHT") {
    if (!diffHunk || !startLine || !endLine) {
        core.debug('extractRelevantDiffHunk: Missing required parameters, returning null');
        return null;
    }

    const CONTEXT_LINES = 3; // Lines of context before/after the comment

    try {
        // Parse the diff hunk using parse-diff library
        const hunks = getHunksFromPatch(diffHunk);

        if (hunks.length === 0) {
            core.debug('extractRelevantDiffHunk: No hunks found, returning null');
            return null;
        }

        if (hunks.length > 1) {
            core.warning(`extractRelevantDiffHunk: Expected single hunk but got ${hunks.length} hunks. Using only the first hunk.`);
        }

        const hunk = hunks[0]; // Take first hunk (usually only one)

        // parse-diff provides line numbers for each change:
        // - type: "normal" → has ln1 (old line) and ln2 (new line)
        // - type: "add" → has ln (new line only)
        // - type: "del" → has ln (old line only)

        // First pass: find the indices of changes that are within our range
        let firstRelevantIndex = -1;
        let lastRelevantIndex = -1;

        for (let i = 0; i < hunk.changes.length; i++) {
            const change = hunk.changes[i];
            let lineNumber;

            if (side === "RIGHT") {
                // RIGHT side: check additions and context lines (new file)
                if (change.type === 'add') {
                    lineNumber = change.ln;
                } else if (change.type === 'normal') {
                    lineNumber = change.ln2;
                } else {
                    continue; // Skip deletions for range detection
                }
            } else {
                // LEFT side: check deletions and context lines (old file)
                if (change.type === 'del') {
                    lineNumber = change.ln;
                } else if (change.type === 'normal') {
                    lineNumber = change.ln1;
                } else {
                    continue; // Skip additions for range detection
                }
            }

            // Check if line is within comment range (with context)
            if (lineNumber >= startLine - CONTEXT_LINES && lineNumber <= endLine + CONTEXT_LINES) {
                if (firstRelevantIndex === -1) {
                    firstRelevantIndex = i;
                }
                lastRelevantIndex = i;
            }
        }

        if (firstRelevantIndex === -1) {
            core.debug('extractRelevantDiffHunk: No relevant lines found in range, returning null');
            return null;
        }

        // Second pass: include ALL changes between first and last relevant index
        // This includes deletions (on RIGHT) or additions (on LEFT) that appear in the range
        const relevantChanges = hunk.changes.slice(firstRelevantIndex, lastRelevantIndex + 1);

        if (relevantChanges.length === 0) {
            core.debug('extractRelevantDiffHunk: No changes extracted, returning null');
            return null;
        }

        // Calculate the correct start line numbers and counts for the extracted hunk
        // Use 0 as default per unified diff format (e.g., new file: @@ -0,0 +1,N @@)
        let oldStart = 0;
        let newStart = 0;
        let oldLines = 0;
        let newLines = 0;

        for (const change of relevantChanges) {
            if (change.type === 'normal') {
                // Context line exists in both old and new
                if (oldStart === 0) oldStart = change.ln1;
                if (newStart === 0) newStart = change.ln2;
                oldLines++;
                newLines++;
            } else if (change.type === 'del') {
                // Deletion exists only in old file
                if (oldStart === 0) oldStart = change.ln;
                oldLines++;
            } else if (change.type === 'add') {
                // Addition exists only in new file
                if (newStart === 0) newStart = change.ln;
                newLines++;
            }
        }

        // Create a hunk object matching parse-diff structure
        const result = reconstructPatch([{
            oldStart,
            oldLines,
            newStart,
            newLines,
            changes: relevantChanges
        }]);

        core.debug('Extracted relevant hunk:\n' + result);
        return result;

    } catch (error) {
        core.error(`extractRelevantDiffHunk: Error parsing diff hunk: ${error.message}`);
        // On error, skip this comment by returning null
        return null;
    }
}

module.exports = {
    filterPatchHunks,
    extractRelevantDiffHunk,
};
