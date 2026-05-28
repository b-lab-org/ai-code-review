const OpenAIAgent = require("./openai-agent");

class DeepseekAgent extends OpenAIAgent {
    constructor(apiKey, fileContentGetter, fileCommentator, model, reviewRulesContent, codebaseSearcher) {
        super(apiKey, fileContentGetter, fileCommentator, model, reviewRulesContent, codebaseSearcher, "https://api.deepseek.com/");
    }
}

module.exports = DeepseekAgent;
