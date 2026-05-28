const OpenAIAgent = require("./openai-agent");

class XAgent extends OpenAIAgent {
    constructor(apiKey, fileContentGetter, fileCommentator, model, reviewRulesContent, codebaseSearcher) {
        super(apiKey, fileContentGetter, fileCommentator, model, reviewRulesContent, codebaseSearcher, "https://api.x.ai/v1/");
    }
}

module.exports = XAgent;
