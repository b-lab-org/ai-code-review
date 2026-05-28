const InputProcessor = require("./input-processor");
const core = require("./core-wrapper");
const { AI_REVIEW_COMMENT_PREFIX, SUMMARY_SEPARATOR, MAX_FILE_SIZE_BYTES } = require("./constants");

function splitIntoBatches(files, batchSize) {
    if (batchSize === "all") {
        return [files];
    }
    const batches = [];
    let currentBatch = [];
    let currentBytes = 0;

    for (const file of files) {
        const patchSize = file.patch ? file.patch.length : 0;

        if (currentBatch.length > 0 && (currentBatch.length >= batchSize || currentBytes + patchSize > MAX_FILE_SIZE_BYTES)) {
            batches.push(currentBatch);
            currentBatch = [];
            currentBytes = 0;
        }

        currentBatch.push(file);
        currentBytes += patchSize;
    }

    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    return batches;
}

const main = async () => {
    const inputProcessor = new InputProcessor();

    try {
        await inputProcessor.processInputs();

        if (inputProcessor.filteredDiffs.length === 0) {
            core.info('No files to review');
            return;
        }

        const aiAgent = inputProcessor.getAIAgent();
        const batches = splitIntoBatches(inputProcessor.filteredDiffs, inputProcessor.batchSize);
        const allPreviousComments = inputProcessor.previousComments;
        const batchSummaries = [];

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            const batchFiles = new Set(batch.map(f => f.filename));
            const batchComments = allPreviousComments.filter(c => batchFiles.has(c.path));
            const batchNames = batch.map(f => f.filename).join(", ");
            core.info(`Reviewing batch ${i + 1}/${batches.length}: ${batchNames}`);
            const summary = await aiAgent.doReview(batch, batchComments);
            if (summary && typeof summary === 'string' && summary.trim() !== '') {
                batchSummaries.push(summary.trim());
            }
        }

        const reviewSummary = batchSummaries.length > 1
            ? await aiAgent.synthesizeSummary(batchSummaries)
            : batchSummaries[0] || 'No issues found in the reviewed files.';

        if (!reviewSummary || typeof reviewSummary !== 'string' || reviewSummary.trim() === '') {
            throw new Error('AI Agent did not return a valid review summary');
        }

        const commentBody = `${AI_REVIEW_COMMENT_PREFIX}${inputProcessor.headCommit}${SUMMARY_SEPARATOR}${reviewSummary}`;
        await inputProcessor.githubAPI.createPRComment(
            inputProcessor.owner,
            inputProcessor.repo,
            inputProcessor.pullNumber,
            commentBody
        );

    } catch (error) {
        if (inputProcessor.failAction) {
            core.debug(error.stack);
            core.error(error.message);
            core.setFailed(error);
        } else {
            core.debug(error.stack);
            core.warning(error.message);
        }
    }
};

main();
