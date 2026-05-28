const OpenAIAgent = require("./openai-agent");

class PerplexityAgent extends OpenAIAgent {
    constructor(apiKey, fileContentGetter, fileCommentator, model, reviewRulesContent, codebaseSearcher) {
        super(apiKey, fileContentGetter, fileCommentator, model, reviewRulesContent, codebaseSearcher, "https://api.perplexity.ai/");
    }
}

module.exports = PerplexityAgent;
