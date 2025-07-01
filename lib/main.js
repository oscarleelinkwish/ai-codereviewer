"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const core = __importStar(require("@actions/core"));
const openai_1 = __importDefault(require("openai"));
const rest_1 = require("@octokit/rest");
const parse_diff_1 = __importDefault(require("parse-diff"));
const minimatch_1 = __importDefault(require("minimatch"));
const GITHUB_TOKEN = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL = core.getInput("OPENAI_API_MODEL") || 'gpt-4';
const CUSTOM_RULES_PATH = core.getInput("custom_rules_path");
const octokit = new rest_1.Octokit({ auth: GITHUB_TOKEN });
const openai = new openai_1.default({
    apiKey: OPENAI_API_KEY,
});
function getPRDetails() {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        const { repository, number } = JSON.parse((0, fs_1.readFileSync)(process.env.GITHUB_EVENT_PATH || "", "utf8"));
        const prResponse = yield octokit.pulls.get({
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: number,
        });
        return {
            owner: repository.owner.login,
            repo: repository.name,
            pull_number: number,
            title: (_a = prResponse.data.title) !== null && _a !== void 0 ? _a : "",
            description: (_b = prResponse.data.body) !== null && _b !== void 0 ? _b : "",
        };
    });
}
function getDiff(owner, repo, pull_number) {
    return __awaiter(this, void 0, void 0, function* () {
        const response = yield octokit.pulls.get({
            owner,
            repo,
            pull_number,
            mediaType: { format: "diff" },
        });
        // @ts-expect-error - response.data is a string
        return response.data;
    });
}
function analyzeCode(parsedDiff, prDetails, customRules) {
    return __awaiter(this, void 0, void 0, function* () {
        const comments = [];
        for (const file of parsedDiff) {
            if (file.to === "/dev/null")
                continue; // Ignore deleted files
            for (const chunk of file.chunks) {
                const prompt = createPrompt(file, chunk, prDetails, customRules);
                const aiResponse = yield getAIResponse(prompt);
                if (aiResponse) {
                    const newComments = createComment(file, chunk, aiResponse);
                    if (newComments) {
                        comments.push(...newComments);
                    }
                }
            }
        }
        return comments;
    });
}
function createPrompt(file, chunk, prDetails, customRules) {
    const defaultRules = `你的任務是審查 Pull Request。指示：
- 以以下 JSON 格式提供回覆： {"reviews": [{"lineNumber": <行號>, "reviewComment": "<審查評論>"}]}
- 不要給予正面評論或讚美。
- 僅在有可改進之處時提供評論和建議，否則 "reviews" 應為空陣列。
- 以 GitHub Markdown 格式撰寫評論。
- 僅將給定的描述用於整體上下文，並僅評論程式碼。
- 重要：切勿建議在程式碼中添加註釋。
- 所有審查評論都必須用中文撰寫。`;
    const rules = customRules || defaultRules;
    return `${rules}

Review the following code diff in the file "${file.to}" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${
    // @ts-expect-error - ln and ln2 exists where needed
    chunk.changes.map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`).join("\n")}\`\`\`
`;
}
function getAIResponse(prompt) {
    var _a, _b;
    return __awaiter(this, void 0, void 0, function* () {
        const queryConfig = {
            model: OPENAI_API_MODEL,
            temperature: 0.2,
            max_tokens: 700,
            top_p: 1,
            frequency_penalty: 0,
            presence_penalty: 0,
        };
        try {
            core.info(`[AI_REVIEW_DEBUG] Prompt sent to OpenAI: ${prompt}`);
            const response = yield openai.chat.completions.create(Object.assign(Object.assign(Object.assign({}, queryConfig), (OPENAI_API_MODEL === "gpt-4-1106-preview"
                ? { response_format: { type: "json_object" } }
                : {})), { messages: [
                    {
                        role: "system",
                        content: prompt,
                    },
                ] }));
            const res = ((_b = (_a = response.choices[0].message) === null || _a === void 0 ? void 0 : _a.content) === null || _b === void 0 ? void 0 : _b.trim()) || "{}";
            return JSON.parse(res).reviews;
        }
        catch (error) {
            console.error("Error:", error);
            return null;
        }
    });
}
function createComment(file, chunk, aiResponses) {
    return aiResponses.flatMap((aiResponse) => {
        if (!file.to) {
            return [];
        }
        return {
            body: aiResponse.reviewComment,
            path: file.to,
            line: Number(aiResponse.lineNumber),
        };
    });
}
function createReviewComment(owner, repo, pull_number, comments) {
    return __awaiter(this, void 0, void 0, function* () {
        yield octokit.pulls.createReview({
            owner,
            repo,
            pull_number,
            comments,
            event: "COMMENT",
        });
    });
}
function main() {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        core.info('[AI_REVIEW_DEBUG] Starting AI Code Reviewer');
        const prDetails = yield getPRDetails();
        let diff;
        const eventData = JSON.parse((0, fs_1.readFileSync)((_a = process.env.GITHUB_EVENT_PATH) !== null && _a !== void 0 ? _a : "", "utf8"));
        core.info(`[AI_REVIEW_DEBUG] Event: ${eventData.action}`);
        if (eventData.action === "opened") {
            core.info('[AI_REVIEW_DEBUG] Getting diff for opened PR');
            diff = yield getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
        }
        else if (eventData.action === "synchronize") {
            core.info('[AI_REVIEW_DEBUG] Getting diff for synchronized PR');
            const newBaseSha = eventData.before;
            const newHeadSha = eventData.after;
            const response = yield octokit.repos.compareCommits({
                headers: {
                    accept: "application/vnd.github.v3.diff",
                },
                owner: prDetails.owner,
                repo: prDetails.repo,
                base: newBaseSha,
                head: newHeadSha,
            });
            diff = String(response.data);
        }
        else {
            core.info(`[AI_REVIEW_DEBUG] Unsupported event: ${process.env.GITHUB_EVENT_NAME}`);
            return;
        }
        if (!diff) {
            core.info('[AI_REVIEW_DEBUG] No diff found');
            return;
        }
        core.info(`[AI_REVIEW_DEBUG] Diff length: ${diff.length} characters`);
        const parsedDiff = (0, parse_diff_1.default)(diff);
        const excludePatterns = core
            .getInput("exclude")
            .split(",")
            .map((s) => s.trim());
        core.info(`[AI_REVIEW_DEBUG] Exclude patterns: ${excludePatterns.join(', ')}`);
        const filteredDiff = parsedDiff.filter((file) => {
            return !excludePatterns.some((pattern) => { var _a; return (0, minimatch_1.default)((_a = file.to) !== null && _a !== void 0 ? _a : "", pattern); });
        });
        core.info(`[AI_REVIEW_DEBUG] Files before filtering: ${parsedDiff.length}, after filtering: ${filteredDiff.length}`);
        if (filteredDiff.length === 0) {
            core.info('[AI_REVIEW_DEBUG] All files filtered out. No code to review.');
            return;
        }
        let customRules = null;
        if (CUSTOM_RULES_PATH) {
            try {
                customRules = (0, fs_1.readFileSync)(CUSTOM_RULES_PATH, "utf8");
                core.info('[AI_REVIEW_DEBUG] Custom rules loaded successfully');
            }
            catch (error) {
                core.warning(`Could not read custom rules file at ${CUSTOM_RULES_PATH}. Using default rules.`);
            }
        }
        core.info('[AI_REVIEW_DEBUG] Starting code analysis...');
        const comments = yield analyzeCode(filteredDiff, prDetails, customRules);
        core.info(`[AI_REVIEW_DEBUG] Analysis complete. Found ${comments.length} comments`);
        if (comments.length > 0) {
            yield createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
            core.info('[AI_REVIEW_DEBUG] Review posted successfully');
        }
    });
}
main().catch((error) => {
    console.error("Error:", error);
    process.exit(1);
});
