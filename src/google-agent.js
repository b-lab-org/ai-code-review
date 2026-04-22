const OpenAIAgent = require("./openai-agent");

class GoogleAgent extends OpenAIAgent {
    constructor(apiKey, fileContentGetter, fileCommentator, model, reviewRulesContent, codebaseSearcher) {
        super(apiKey, fileContentGetter, fileCommentator, model, reviewRulesContent, codebaseSearcher, "https://generativelanguage.googleapis.com/v1beta/openai/");
    }
}

module.exports = GoogleAgent;
